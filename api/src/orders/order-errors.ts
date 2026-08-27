import { UnrecoverableError } from 'bullmq';

/**
 * Error taxonomy for the order write path.
 *
 * The split that matters is "will retrying help?".
 *
 * Business failures never will — the stock really is gone, the user really
 * did already buy one. They extend BullMQ's UnrecoverableError, which stops
 * the job immediately regardless of the `attempts` setting. Without that,
 * `attempts: 3` turns 450 sold-out jobs into 1,350 round trips hammering the
 * exact row the 50 winners are queueing on, at the worst possible moment —
 * and buries the genuine failures in Bull Board.
 *
 * Transient failures might — a lock timeout, a deadlock, a dropped
 * connection. Those are worth another go.
 */

export class OutOfStockError extends UnrecoverableError {
  constructor(productId: string) {
    super(`OUT_OF_STOCK: no units left for ${productId}`);
    this.name = 'OUT_OF_STOCK';
  }
}

export class DuplicateOrderError extends UnrecoverableError {
  constructor(userId: string, productId: string) {
    super(`DUPLICATE_ORDER: ${userId} already ordered ${productId}`);
    this.name = 'DUPLICATE_ORDER';
  }
}

export class ProductNotFoundError extends UnrecoverableError {
  constructor(productId: string) {
    super(`PRODUCT_NOT_FOUND: ${productId}`);
    this.name = 'PRODUCT_NOT_FOUND';
  }
}

/**
 * Thrown *inside* the transaction when we detect that this exact job already
 * committed its order in an earlier run (same job_id on the existing row).
 *
 * It exists purely to force a rollback. The stock decrement this attempt just
 * made is a duplicate of one that already committed, so it must not survive —
 * returning normally here would commit it and sell the same unit twice. The
 * processor catches this outside the transaction and reports success.
 *
 * Deliberately NOT an UnrecoverableError: it never reaches BullMQ as a
 * failure at all.
 */
export class ReplayDetectedError extends Error {
  constructor(readonly orderId: string) {
    super(`REPLAY_DETECTED: job already committed order ${orderId}`);
    this.name = 'REPLAY_DETECTED';
  }
}

/** Optimistic strategy ran out of retry budget — transient by nature. */
export class OptimisticRetryExhaustedError extends Error {
  constructor(productId: string, attempts: number) {
    super(`OPTIMISTIC_RETRY_EXHAUSTED: ${productId} after ${attempts} attempts`);
    this.name = 'OPTIMISTIC_RETRY_EXHAUSTED';
  }
}

/**
 * Pull the SQLSTATE out of an error.
 *
 * TypeORM wraps driver errors in QueryFailedError and puts the pg error on
 * `.driverError`, but it also copies some fields onto the wrapper — which one
 * is populated depends on the code path, so check both rather than guessing.
 */
export function pgCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { code?: unknown; driverError?: { code?: unknown } };
  if (typeof e.code === 'string') return e.code;
  if (e.driverError && typeof e.driverError.code === 'string') return e.driverError.code;
  return undefined;
}

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_LOCK_TIMEOUT = '55P03';
export const PG_DEADLOCK = '40P01';
export const PG_SERIALIZATION_FAILURE = '40001';

/**
 * Worth retrying: the operation failed for a reason that may not repeat.
 * Class 08 is "connection exception" in its entirety, hence the prefix test.
 */
export function isTransient(err: unknown): boolean {
  const code = pgCode(err);
  if (!code) return false;
  return (
    code === PG_LOCK_TIMEOUT ||
    code === PG_DEADLOCK ||
    code === PG_SERIALIZATION_FAILURE ||
    code.startsWith('08')
  );
}
