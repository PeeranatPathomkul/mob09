import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { resolveCacheVersionKey } from '../redis/cache-keys';
import { ORDERS_QUEUE } from './orders.module';
import { ClaimResult, StockClaimService } from './stock-claim.service';
import { ReplayDetectedError } from './order-errors';

export interface ProcessOrderJobData {
  userId: string;
  productId: string;
  /** Present on older jobs; the business rule fixes quantity at 1. */
  quantity?: number;
}

const WORKER_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 10);

@Processor(ORDERS_QUEUE, { concurrency: WORKER_CONCURRENCY })
export class OrdersProcessor extends WorkerHost {
  private readonly logger = new Logger(OrdersProcessor.name);
  private readonly cacheVersionKey: string;

  constructor(
    private readonly stockClaim: StockClaimService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    super();
    // Same helper ProductCacheService uses. Readers derive their page keys
    // from whatever this resolves to, so the two must never drift apart.
    this.cacheVersionKey = resolveCacheVersionKey(process.env.CACHE_VERSION_KEY);
    this.logger.log(
      `concurrency=${WORKER_CONCURRENCY} strategy=${this.stockClaim.getStrategy()} cacheVersionKey=${this.cacheVersionKey}`,
    );
  }

  async process(job: Job<ProcessOrderJobData>): Promise<ClaimResult> {
    const { userId, productId } = job.data;
    const jobId = String(job.id);

    // The entry-point lock (OrdersService) is released by
    // OrdersLockReleaseListener as soon as BullMQ reports this job
    // completed or failed — not from here. That listener is the sole owner
    // of that key; duplicating the release here previously ran under a
    // different, wrong Redis key and never actually fired.
    let result: ClaimResult;
    try {
      result = await this.stockClaim.claim(userId, productId, jobId);
    } catch (err) {
      if (err instanceof ReplayDetectedError) {
        // This job already committed in an earlier run and crashed before
        // BullMQ recorded it. The transaction that just ran was rolled
        // back, so nothing was double-counted. The order exists and is
        // correct: report success.
        this.logger.warn(`job ${jobId} replayed; order ${err.orderId} already committed`);
        return { orderId: err.orderId, remainingStock: -1, replayed: true, attempts: 1 };
      }
      throw err;
    }

    // Strictly after the commit. Bumping the cache version before it would
    // invalidate readers on the strength of a write that might still roll
    // back — and a reader could then refill the cache from the pre-commit
    // state, leaving a stale entry that outlives the transaction.
    await this.bumpCacheVersion();

    return result;
  }

  private async bumpCacheVersion(): Promise<void> {
    try {
      await this.redis.incr(this.cacheVersionKey);
    } catch (err) {
      // The stock change is already committed and correct; a failed cache
      // bump must not fail the job. Readers fall back to their TTL.
      this.logger.error(`cache version bump failed: ${(err as Error).message}`);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<ProcessOrderJobData> | undefined, err: Error) {
    // err.name carries the taxonomy (OUT_OF_STOCK, DUPLICATE_ORDER, ...), so
    // Bull Board shows why a job failed instead of one undifferentiated wall
    // of red — that breakdown is the evidence for the report.
    this.logger.warn(`job ${job?.id ?? '?'} failed [${err.name}] ${err.message}`);
  }
}
