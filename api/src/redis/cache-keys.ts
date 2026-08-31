/**
 * Redis key names shared between the read side and the write side.
 *
 * The product cache's correctness rests on one thing: the worker bumping the
 * *same* key that readers derive their page keys from. Those two live in
 * different processes (AppModule vs WorkerModule) and never talk, so nothing
 * at runtime can detect a disagreement — a reader would simply keep serving
 * pages under a version nobody is incrementing, and `remainingStock` would
 * stay wrong until each key's TTL expired. No error, no log, no failed job.
 *
 * Both sides therefore resolve the name through here rather than repeating
 * the literal. This file sits under redis/ because both already depend on
 * that module for REDIS_CLIENT, and OrdersWorkerModule deliberately does not
 * import the cache module (see its header comment).
 */

export const DEFAULT_CACHE_VERSION_KEY = 'products:cache:version';

/**
 * Resolve the configured cache version key, falling back to the default.
 *
 * Takes the raw value rather than a ConfigService so both callers can use it:
 * the API reads it via ConfigService, the worker straight off process.env.
 * A blank or whitespace-only setting is treated as unset — an empty key name
 * would otherwise be accepted by one side and silently break invalidation.
 */
export function resolveCacheVersionKey(
  configured?: string | null,
): string {
  const trimmed = configured?.trim();
  return trimmed ? trimmed : DEFAULT_CACHE_VERSION_KEY;
}
