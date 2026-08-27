import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { ORDERS_QUEUE } from './orders.module';
import { ClaimResult, StockClaimService } from './stock-claim.service';
import { ReplayDetectedError } from './order-errors';

export interface ProcessOrderJobData {
  userId: string;
  productId: string;
  /**
   * Token of the Redis lock the API layer took before enqueuing, so this
   * worker can release exactly that lock and no other. Optional because the
   * current producer does not send one yet — see the note on releaseLock().
   */
  lockToken?: string;
  /** Present on older jobs; the business rule fixes quantity at 1. */
  quantity?: number;
}

/**
 * Release a distributed lock only if we still own it.
 *
 * A bare DEL is unsafe: if the lock's TTL expires while this job is still
 * running and the user retries, a *new* lock appears under the same key. DEL
 * would delete that one, letting the same user through a second time. The
 * compare makes the delete a no-op unless the value is still ours.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

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
    this.cacheVersionKey = process.env.CACHE_VERSION_KEY ?? 'products:cache:version';
    this.logger.log(
      `concurrency=${WORKER_CONCURRENCY} strategy=${this.stockClaim.getStrategy()} cacheVersionKey=${this.cacheVersionKey}`,
    );
  }

  async process(job: Job<ProcessOrderJobData>): Promise<ClaimResult> {
    const { userId, productId, lockToken } = job.data;
    const jobId = String(job.id);

    try {
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
    } finally {
      // Runs on every path, success or failure, so a user is never left
      // locked out waiting for the TTL after their job has already resolved.
      await this.releaseLock(userId, productId, lockToken);
    }
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

  private async releaseLock(userId: string, productId: string, lockToken?: string): Promise<void> {
    if (!lockToken) return; // producer did not send one — nothing we can prove ownership of
    try {
      await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, `lock:order:${userId}:${productId}`, lockToken);
    } catch (err) {
      // Never let cleanup mask the real outcome of the job.
      this.logger.error(`lock release failed for ${userId}/${productId}: ${(err as Error).message}`);
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
