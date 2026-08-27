// Shared helpers so the lock key, the deterministic job id, and the exact
// payload string stored in the lock are computed identically wherever
// they're needed (OrdersService when acquiring, OrdersLockReleaseListener
// when releasing) — a mismatch here would silently break the
// compare-and-delete safety check below.

export interface OrderLockPayload {
  orderJobId: string;
  message: string;
}

export function buildOrderLockKey(userId: string, productId: string): string {
  return `order-lock:${userId}:${productId}`;
}

// Deterministic job id: doubles as BullMQ's own jobId-dedup key, a second
// (redundant but free) line of defense under the Redis lock.
export function buildOrderJobId(userId: string, productId: string): string {
  return `order:${userId}:${productId}`;
}

export function buildOrderLockPayload(orderJobId: string): OrderLockPayload {
  return { orderJobId, message: 'Your order is in the queue.' };
}

/**
 * Atomic compare-and-delete: only removes KEYS[1] if its current value still
 * equals ARGV[1]. Plain GET-then-DEL is two round trips with a race between
 * them — another request could acquire a new lock on the same key in that
 * gap, and a bare DEL would then delete someone else's live lock. Wrapping
 * the compare and the delete in a single Lua script makes it one atomic
 * operation, so we only ever remove the lock we ourselves are holding.
 */
export const COMPARE_AND_DELETE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;