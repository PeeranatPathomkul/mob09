import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { buildOrderLockKey, buildOrderLockPayload, COMPARE_AND_DELETE_SCRIPT } from './orders-lock.util';

/**
 * The entry-point lock in OrdersService has a TTL as a safety net, but the
 * real release mechanism is this listener: as soon as BullMQ reports a job
 * finished (either way), we free the lock immediately so the user isn't
 * stuck waiting out the TTL — this is what stops a failed job (out of
 * stock, DB error, etc.) from locking that user out of retrying for up to
 * LOCK_TTL_SECONDS.
 */
@Injectable()
export class OrdersLockReleaseListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrdersLockReleaseListener.name);
  private queueEvents!: QueueEvents;

  constructor(
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  onModuleInit() {
    this.queueEvents = new QueueEvents('orders', {
      connection: {
        host: this.config.get<string>('REDIS_HOST'),
        port: Number(this.config.get<string>('REDIS_PORT') ?? 6379),
      },
    });

    this.queueEvents.on('completed', ({ jobId }) => this.release(jobId));
    this.queueEvents.on('failed', ({ jobId }) => this.release(jobId));
  }

  async onModuleDestroy() {
    await this.queueEvents?.close();
  }

  private async release(jobId: string) {
    // jobId format is "order:{userId}:{productId}" — see buildOrderJobId.
    const [, userId, productId] = jobId.split(':');
    if (!userId || !productId) {
      this.logger.warn(`Unexpected job id format, skipping lock release: ${jobId}`);
      return;
    }

    const lockKey = buildOrderLockKey(userId, productId);
    // Reconstruct the exact payload OrdersService would have stored for
    // this job id, and use it as the compare token: a plain DEL here could
    // wipe out a *new* lock some other request acquired if this event
    // handler ever fired late — the compare-and-delete script guarantees
    // we only ever remove the lock we're actually releasing.
    const payloadStr = JSON.stringify(buildOrderLockPayload(jobId));
    await this.redis.eval(COMPARE_AND_DELETE_SCRIPT, 1, lockKey, payloadStr);
  }
}