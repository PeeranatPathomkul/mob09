import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Order, OrderStatus } from './entities/order.entity';
import { Product } from '../products/entities/product.entity';
import {
  DuplicateOrderError,
  OptimisticRetryExhaustedError,
  OutOfStockError,
  PG_UNIQUE_VIOLATION,
  ProductNotFoundError,
  ReplayDetectedError,
  pgCode,
} from './order-errors';

export type StockClaimStrategy = 'pessimistic' | 'optimistic' | 'atomic';

export interface ClaimResult {
  orderId: string;
  remainingStock: number;
  /** True when this job had already committed and was re-run after a crash. */
  replayed: boolean;
  /** Optimistic strategy only: how many passes it took. 1 means no contention. */
  attempts: number;
}

const OPTIMISTIC_MAX_ATTEMPTS = 50;

/**
 * Claims exactly one unit of a product for exactly one user, or fails with a
 * reason the caller can act on.
 *
 * Three interchangeable implementations, selected at runtime by
 * STOCK_CLAIM_STRATEGY, so a benchmark sweep only has to restart the
 * container instead of rebuilding the image.
 *
 * All three run against a 100% hot row — every request in the load test
 * targets the same product — which is what drives the design. Under that
 * shape PostgreSQL serialises writers on the row lock no matter what we do,
 * so the only lever that actually moves throughput is how many round trips
 * happen while the lock is held.
 */
@Injectable()
export class StockClaimService {
  private readonly logger = new Logger(StockClaimService.name);
  private readonly strategy: StockClaimStrategy;
  private readonly lockTimeout: string;

  // Aggregate counters for the report: wasted work is (attempts - successes).
  private optimisticAttempts = 0;
  private optimisticSuccesses = 0;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    const raw = (config.get<string>('STOCK_CLAIM_STRATEGY') ?? 'pessimistic').trim().toLowerCase();
    this.strategy = (['pessimistic', 'optimistic', 'atomic'] as const).includes(raw as StockClaimStrategy)
      ? (raw as StockClaimStrategy)
      : 'pessimistic';

    if (raw !== this.strategy) {
      this.logger.warn(`Unknown STOCK_CLAIM_STRATEGY "${raw}", falling back to "pessimistic"`);
    }

    // Postgres interval literal, e.g. "5s". Guarded because it is
    // interpolated into SET LOCAL, which cannot take a bind parameter.
    const timeout = (config.get<string>('DB_LOCK_TIMEOUT') ?? '5s').trim();
    this.lockTimeout = /^\d+(ms|s|min)?$/.test(timeout) ? timeout : '5s';
    if (this.lockTimeout !== timeout) {
      this.logger.warn(`Invalid DB_LOCK_TIMEOUT "${timeout}", falling back to "5s"`);
    }

    this.logger.log(`strategy=${this.strategy} lock_timeout=${this.lockTimeout}`);
  }

  getStrategy(): StockClaimStrategy {
    return this.strategy;
  }

  /** Optimistic wasted-work stats for the report. */
  getOptimisticStats() {
    return {
      attempts: this.optimisticAttempts,
      successes: this.optimisticSuccesses,
      wasted: this.optimisticAttempts - this.optimisticSuccesses,
    };
  }

  async claim(userId: string, productId: string, jobId: string): Promise<ClaimResult> {
    switch (this.strategy) {
      case 'optimistic':
        return this.claimOptimistic(userId, productId, jobId);
      case 'atomic':
        return this.claimAtomic(userId, productId, jobId);
      default:
        return this.claimPessimistic(userId, productId, jobId);
    }
  }

  // ------------------------------------------------------------------
  // Shared helpers
  // ------------------------------------------------------------------

  /**
   * Fail fast instead of queueing forever behind the row lock.
   *
   * SET LOCAL scopes this to the current transaction, so it cannot leak onto
   * the next user of this pooled connection. A 55P03 lock timeout is
   * classified transient, so BullMQ retries it — which is the behaviour we
   * want: a backed-up queue that fails visibly beats one that silently grows.
   */
  private async applyLockTimeout(manager: EntityManager): Promise<void> {
    await manager.query(`SET LOCAL lock_timeout = '${this.lockTimeout}'`);
  }

  /**
   * Decide what a 23505 on (user_id, product_id) actually means.
   *
   * Runs on a SEPARATE connection on purpose: once a statement fails inside a
   * transaction, Postgres poisons it — every subsequent query returns 25P02
   * until rollback. So the row we need to inspect is unreachable from the
   * transaction that just blew up.
   *
   * Same job_id  -> this job already committed; we are a post-crash replay.
   * Other job_id -> a genuine second purchase attempt.
   */
  private async classifyUniqueViolation(
    userId: string,
    productId: string,
    jobId: string,
  ): Promise<{ replayed: true; orderId: string } | { replayed: false }> {
    const rows: Array<{ id: string; job_id: string | null }> = await this.dataSource.query(
      `SELECT id, job_id FROM orders WHERE user_id = $1 AND product_id = $2 LIMIT 1`,
      [userId, productId],
    );

    const existing = rows[0];
    if (existing && existing.job_id !== null && existing.job_id === jobId) {
      return { replayed: true, orderId: existing.id };
    }
    return { replayed: false };
  }

  // ------------------------------------------------------------------
  // A) Pessimistic — SELECT ... FOR UPDATE. The default, the one we ship.
  // ------------------------------------------------------------------
  private async claimPessimistic(userId: string, productId: string, jobId: string): Promise<ClaimResult> {
    try {
      return await this.dataSource.transaction('READ COMMITTED', async (manager) => {
        await this.applyLockTimeout(manager);

        // Blocks until whoever holds the row commits, then reads the value
        // they left behind — this is the serialisation point.
        const product = await manager.findOne(Product, {
          where: { id: productId },
          lock: { mode: 'pessimistic_write' },
        });

        if (!product) throw new ProductNotFoundError(productId);
        if (product.remainingStock <= 0) throw new OutOfStockError(productId);

        const remainingStock = product.remainingStock - 1;
        await manager.update(Product, { id: productId }, { remainingStock });

        // Same transaction as the decrement, deliberately. If this INSERT
        // fails on the unique constraint, the decrement rolls back with it
        // and the unit returns to the pool automatically.
        const order = manager.create(Order, {
          userId,
          productId,
          quantity: 1,
          status: OrderStatus.CONFIRMED,
          jobId,
        });
        const saved = await manager.save(order);

        return { orderId: saved.id, remainingStock, replayed: false, attempts: 1 };
      });
    } catch (err) {
      return this.handleClaimError(err, userId, productId, jobId);
    }
  }

  // ------------------------------------------------------------------
  // B) Optimistic — version + retry. Built to be measured, not shipped.
  // ------------------------------------------------------------------
  private async claimOptimistic(userId: string, productId: string, jobId: string): Promise<ClaimResult> {
    for (let attempt = 1; attempt <= OPTIMISTIC_MAX_ATTEMPTS; attempt++) {
      this.optimisticAttempts++;

      try {
        const result = await this.dataSource.transaction('READ COMMITTED', async (manager) => {
          await this.applyLockTimeout(manager);

          // Plain read, no lock — the whole point of the strategy.
          const product = await manager.findOne(Product, { where: { id: productId } });
          if (!product) throw new ProductNotFoundError(productId);
          if (product.remainingStock <= 0) throw new OutOfStockError(productId);

          // The compare-and-swap. If someone else moved the version between
          // our read and here, this matches 0 rows and we start over.
          const updated = await manager
            .createQueryBuilder()
            .update(Product)
            .set({ remainingStock: () => 'remaining_stock - 1', version: () => 'version + 1' })
            .where('id = :productId AND version = :version AND remaining_stock > 0')
            .setParameters({ productId, version: product.version })
            .execute();

          if (updated.affected === 0) return null; // lost the race

          const order = manager.create(Order, {
            userId,
            productId,
            quantity: 1,
            status: OrderStatus.CONFIRMED,
            jobId,
          });
          const saved = await manager.save(order);

          return {
            orderId: saved.id,
            remainingStock: product.remainingStock - 1,
            replayed: false as const,
            attempts: attempt,
          };
        });

        if (result) {
          this.optimisticSuccesses++;
          if (attempt > 1) {
            this.logger.debug(`optimistic claim for ${userId}/${productId} took ${attempt} attempts`);
          }
          return result;
        }
        // null -> CAS lost, fall through and retry.
      } catch (err) {
        return this.handleClaimError(err, userId, productId, jobId);
      }
    }

    this.logger.warn(
      `optimistic claim gave up on ${productId} after ${OPTIMISTIC_MAX_ATTEMPTS} attempts`,
    );
    throw new OptimisticRetryExhaustedError(productId, OPTIMISTIC_MAX_ATTEMPTS);
  }

  // ------------------------------------------------------------------
  // C) Atomic CTE — still pessimistic locking, but one round trip.
  // ------------------------------------------------------------------
  private async claimAtomic(userId: string, productId: string, jobId: string): Promise<ClaimResult> {
    // Postgres holds the row lock from the UPDATE until COMMIT either way.
    // What differs is how long that is: the pessimistic path spends three
    // round trips inside the lock (SELECT, UPDATE, INSERT); this spends one.
    //
    // The INSERT is driven by SELECT ... FROM claimed, so if the UPDATE
    // matched nothing (no stock), `claimed` is empty, the INSERT writes
    // nothing, and the whole statement returns 0 rows.
    const sql = `
      WITH claimed AS (
        UPDATE products
           SET remaining_stock = remaining_stock - 1,
               updated_at = now()
         WHERE id = $1 AND remaining_stock > 0
        RETURNING id, remaining_stock
      ),
      placed AS (
        INSERT INTO orders (id, user_id, product_id, quantity, status, job_id)
        SELECT gen_random_uuid(), $2, claimed.id, 1, 'confirmed', $3 FROM claimed
        RETURNING id, product_id
      )
      SELECT placed.id AS order_id, claimed.remaining_stock
        FROM placed JOIN claimed ON claimed.id = placed.product_id
    `;

    try {
      const rows: Array<{ order_id: string; remaining_stock: number }> = await this.dataSource.query(sql, [
        productId,
        userId,
        jobId,
      ]);

      if (rows.length === 0) {
        // Zero rows is ambiguous on its own: no stock, or no such product.
        // Distinguish so the failure reason in Bull Board is truthful.
        const exists: Array<{ one: number }> = await this.dataSource.query(
          `SELECT 1 AS one FROM products WHERE id = $1`,
          [productId],
        );
        if (exists.length === 0) throw new ProductNotFoundError(productId);
        throw new OutOfStockError(productId);
      }

      return {
        orderId: rows[0].order_id,
        remainingStock: Number(rows[0].remaining_stock),
        replayed: false,
        attempts: 1,
      };
    } catch (err) {
      return this.handleClaimError(err, userId, productId, jobId);
    }
  }

  // ------------------------------------------------------------------
  // Shared failure translation
  // ------------------------------------------------------------------

  /**
   * Turn a raw driver error into the right domain error.
   *
   * Note this never returns a ClaimResult for the replay case — it throws
   * ReplayDetectedError, which the processor converts into success *after*
   * the transaction has rolled back. Returning here instead would leave this
   * attempt's stock decrement committed on top of the one the original run
   * already made, selling the same unit twice.
   */
  private async handleClaimError(
    err: unknown,
    userId: string,
    productId: string,
    jobId: string,
  ): Promise<never> {
    if (pgCode(err) === PG_UNIQUE_VIOLATION) {
      const verdict = await this.classifyUniqueViolation(userId, productId, jobId);
      if (verdict.replayed) throw new ReplayDetectedError(verdict.orderId);
      throw new DuplicateOrderError(userId, productId);
    }
    throw err;
  }
}
