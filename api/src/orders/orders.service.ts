import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { CreateOrderDto } from './dto/create-order.dto';
import {
  buildOrderJobId,
  buildOrderLockKey,
  buildOrderLockPayload,
  COMPARE_AND_DELETE_SCRIPT,
  OrderLockPayload,
} from './orders-lock.util';

// Safety-net only. The lock is normally released the instant BullMQ reports
// the job completed or failed (see OrdersLockReleaseListener) — this TTL
// just bounds the damage if that listener is ever down: too short and a
// slow-but-healthy job could get bypassed by a duplicate before it
// finishes; too long and a listener outage locks the user out for the
// full window. 30s comfortably covers normal enqueue+process time.
const LOCK_TTL_SECONDS = 30;

const QUANTITY = 1; // Business rule: each user may buy at most 1 unit per product.

const MAX_ACQUIRE_ATTEMPTS = 3;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectQueue('orders') private readonly ordersQueue: Queue,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async createOrder(userId: string, dto: CreateOrderDto): Promise<OrderLockPayload> {
    const lockKey = buildOrderLockKey(userId, dto.productId);
    const jobId = buildOrderJobId(userId, dto.productId);
    const payload = buildOrderLockPayload(jobId);
    const payloadStr = JSON.stringify(payload);

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      // Single atomic Redis command — SET key value NX EX ttl. There is no
      // separate "check if it exists" call before this: the existence
      // check and the write happen as one indivisible operation on Redis's
      // side. Two concurrent requests for the same user+product both send
      // this command; Redis serializes them, so exactly one gets "OK" back
      // and the other gets nil. There is no window for both to win.
      const acquired = await this.redis.set(lockKey, payloadStr, 'EX', LOCK_TTL_SECONDS, 'NX');

      if (acquired === 'OK') {
        try {
          await this.ordersQueue.add(
            'process-order',
            { userId, productId: dto.productId, quantity: QUANTITY },
            { jobId },
          );
          return payload;
        } catch (err) {
          // We never got a job into the queue at all, so there is nothing
          // for OrdersLockReleaseListener to eventually release — free the
          // slot immediately instead of making the user wait out the TTL.
          await this.redis.eval(COMPARE_AND_DELETE_SCRIPT, 1, lockKey, payloadStr);
          throw err;
        }
      }

      // Lock already held. This is either (a) the client's own
      // network-layer retry of the exact same request, or (b) a rapid
      // double/triple click. Either way, the right behavior is idempotent
      // replay, not an error: hand back the same response the original
      // request produced instead of enqueuing (or reporting) a second
      // attempt.
      const existing = await this.redis.get(lockKey);
      if (existing) {
        return JSON.parse(existing) as OrderLockPayload;
      }

      // Narrow TOCTOU: the lock expired in the gap between our failed SET
      // and the GET above (only possible right at the TTL boundary). The
      // previous holder is gone, so loop and try again — bounded by
      // MAX_ACQUIRE_ATTEMPTS so a pathological repeated-expiry case can't
      // spin forever.
      this.logger.debug(
        `Lock ${lockKey} vanished between SET and GET, retrying (attempt ${attempt + 1})`,
      );
    }

    // Exhausted retries in an extremely unlikely repeated-race scenario.
    // Enqueue directly rather than leaving the request unanswered — worst
    // case this duplicates a job id BullMQ already dedupes on.
    await this.ordersQueue.add(
      'process-order',
      { userId, productId: dto.productId, quantity: QUANTITY },
      { jobId },
    );
    return payload;
  }
}
