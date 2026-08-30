import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { resolveCacheVersionKey } from '../redis/cache-keys';
import { ProductDto, ProductsService } from '../products/products.service';

export interface ProductsPageResponse {
  status: 'success';
  data: ProductDto[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

/**
 * How a single response was produced. Surfaced per-request as the `X-Cache`
 * header, because `cache:hits`/`cache:misses` are process-wide totals shared
 * by every instance and every client — you can difference them around one
 * request only when nothing else is running, which is useless under load.
 *
 * BYPASS is deliberately not folded into MISS. A MISS still populated the
 * cache for whoever comes next; a BYPASS read straight through and wrote
 * nothing, so a run full of them means the cache is not participating at all.
 * Telling them apart is the difference between "cold" and "broken".
 */
export type CacheStatus =
  /** Served out of Redis — either found on arrival, or after waiting for the rebuilder. */
  | 'HIT'
  /** This request held the rebuild lock, queried Postgres, and repopulated the cache. */
  | 'MISS'
  /** Read through to Postgres without using or writing the cache: Redis errored, the version moved mid-wait, or the lock wait ran out. */
  | 'BYPASS';

/** A page plus how it was obtained. */
export interface ProductsPageResult {
  body: ProductsPageResponse;
  cacheStatus: CacheStatus;
}

export interface CacheStats {
  hits: number;
  misses: number;
  errors: number;
  hitRate: number;
  currentVersion: number;
  redisAvailable: boolean;
}

/**
 * Release a distributed lock only if we still own it. Same compare-and-delete
 * pattern as orders.processor.ts's RELEASE_LOCK_SCRIPT: a bare DEL would risk
 * deleting a *new* lock taken by someone else after ours expired.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Read the version counter and the page cached under that version in ONE
 * round trip.
 *
 * As two sequential GETs this cost two RTTs on every single read, which at
 * 1,000 concurrent readers is the largest avoidable latency in the path.
 * Bundling them also makes the pair atomic: the version can no longer move
 * between the two reads, so the page we get back always belongs to the
 * version we got back.
 *
 * The script builds the page key itself and returns it, keeping the key
 * format in exactly one place — the caller writes back to whatever key comes
 * out of here instead of re-deriving it and risking a mismatch.
 *
 * A missing or non-numeric version counts as 0, and a cache miss comes back
 * as an empty string: a nil inside a Lua table truncates the reply array,
 * and a real cached body is always JSON, never empty.
 *
 * Note: the page key is computed inside the script rather than declared in
 * KEYS, which standalone Redis allows but Redis Cluster does not. That is
 * fine here (docker-compose runs a single redis service) — but a move to
 * Cluster would need the version read split back out so both keys can be
 * declared, and they would have to hash to the same slot.
 */
const READ_PAGE_SCRIPT = `
local version = redis.call("get", KEYS[1])
if not version or not tonumber(version) then version = "0" end
local pageKey = ARGV[1] .. ":v:" .. version
local cached = redis.call("get", pageKey)
return { version, pageKey, cached or "" }
`;

/** One atomic look at the version counter and the page cached under it. */
interface PageSnapshot {
  version: number;
  pageKey: string;
  cached: string | null;
}

/**
 * Read-path cache for GET /api/v1/products: hybrid page cache + version
 * counter.
 *
 * Design intent (see module README): during a flash sale every successful
 * order bumps the version, killing every cached page for it immediately.
 * Hit-rate is expected to be low by design — the job of this module is to
 * cap how many requests hit Postgres per version (via the rebuild mutex),
 * not to maximize hit-rate.
 */
@Injectable()
export class ProductCacheService {
  private readonly logger = new Logger(ProductCacheService.name);

  private readonly cacheVersionKey: string;
  private readonly ttlMinSeconds: number;
  private readonly ttlMaxSeconds: number;
  private readonly lockTtlSeconds: number;
  private readonly lockRetryMax: number;
  private readonly lockRetryDelayMs: number;

  // request-coalescing for the last-resort DB fallback (lock retries
  // exhausted, or Redis itself is unavailable) — key is `${page}:${limit}`.
  private readonly inFlight = new Map<string, Promise<ProductsPageResponse>>();

  constructor(
    private readonly productsService: ProductsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {
    // Resolved through the shared helper, not a local literal — the worker
    // must bump exactly this key or invalidation breaks silently.
    this.cacheVersionKey = resolveCacheVersionKey(
      this.config.get<string>('CACHE_VERSION_KEY'),
    );
    this.ttlMinSeconds = Number(
      this.config.get('PRODUCT_CACHE_TTL_MIN_SECONDS') ?? 30,
    );
    this.ttlMaxSeconds = Number(
      this.config.get('PRODUCT_CACHE_TTL_MAX_SECONDS') ?? 60,
    );
    this.lockTtlSeconds = Number(
      this.config.get('PRODUCT_CACHE_LOCK_TTL_SECONDS') ?? 5,
    );
    this.lockRetryMax = Number(
      this.config.get('PRODUCT_CACHE_LOCK_RETRY_MAX') ?? 3,
    );
    this.lockRetryDelayMs = Number(
      this.config.get('PRODUCT_CACHE_LOCK_RETRY_DELAY_MS') ?? 10,
    );
  }

  /** The page alone. Unchanged for callers that do not care how it was obtained. */
  async getProductsPage(
    page: number,
    limit: number,
  ): Promise<ProductsPageResponse> {
    const { body } = await this.getProductsPageWithStatus(page, limit);
    return body;
  }

  /** The page plus its CacheStatus, for the controller to report as `X-Cache`. */
  async getProductsPageWithStatus(
    page: number,
    limit: number,
  ): Promise<ProductsPageResult> {
    let snapshot: PageSnapshot;
    try {
      snapshot = await this.readPage(page, limit);
    } catch (err) {
      await this.incrErrors(err);
      return this.bypass(page, limit);
    }

    if (snapshot.cached) {
      this.incrCounter('cache:hits');
      return {
        body: JSON.parse(snapshot.cached) as ProductsPageResponse,
        cacheStatus: 'HIT',
      };
    }

    this.incrCounter('cache:misses');
    return this.rebuildOrWait(page, limit, snapshot);
  }

  /** Called after a stock-changing write commits — bumps the version so every cached page for it goes stale at once. */
  async invalidateProductCache(): Promise<void> {
    try {
      await this.redis.incr(this.cacheVersionKey);
    } catch (err) {
      this.logger.error(`cache version bump failed: ${(err as Error).message}`);
    }
  }

  async getStats(): Promise<CacheStats> {
    let redisAvailable = true;

    const safeGet = async (key: string): Promise<number> => {
      try {
        const raw = await this.redis.get(key);
        const num = Number(raw);
        return Number.isFinite(num) ? num : 0;
      } catch {
        redisAvailable = false;
        return 0;
      }
    };

    const [hits, misses, errors, currentVersion] = await Promise.all([
      safeGet('cache:hits'),
      safeGet('cache:misses'),
      safeGet('cache:errors'),
      safeGet(this.cacheVersionKey),
    ]);

    const hitRate = hits + misses > 0 ? hits / (hits + misses) : 0;

    return { hits, misses, errors, hitRate, currentVersion, redisAvailable };
  }

  // -- mutex: exactly one caller rebuilds a given page/limit/version, the rest wait on it --

  private async rebuildOrWait(
    page: number,
    limit: number,
    snapshot: PageSnapshot,
  ): Promise<ProductsPageResult> {
    const { version, pageKey } = snapshot;
    const lockKey = this.lockKey(page, limit, version);
    const token = randomUUID();

    let gotLock: boolean;
    try {
      const setResult = await this.redis.set(
        lockKey,
        token,
        'PX',
        this.lockTtlSeconds * 1000,
        'NX',
      );
      gotLock = setResult === 'OK';
    } catch (err) {
      await this.incrErrors(err);
      return this.bypass(page, limit);
    }

    if (gotLock) {
      try {
        const body = await this.buildResponse(page, limit);
        try {
          await this.redis.set(
            pageKey,
            JSON.stringify(body),
            'EX',
            this.randomTtlSeconds(),
          );
        } catch (err) {
          // Query already succeeded; a failed cache write just means the
          // next reader rebuilds too. Not fatal to this request.
          await this.incrErrors(err);
        }
        // MISS, not BYPASS: this request is the one that refilled the cache.
        return { body, cacheStatus: 'MISS' };
      } finally {
        await this.releaseLock(lockKey, token);
      }
    }

    // Someone else is rebuilding — poll for the page key rather than piling
    // another query onto Postgres.
    for (let attempt = 0; attempt < this.lockRetryMax; attempt++) {
      await this.sleep(this.lockRetryDelayMs);

      let polled: PageSnapshot;
      try {
        polled = await this.readPage(page, limit);
      } catch (err) {
        await this.incrErrors(err);
        return this.bypass(page, limit);
      }

      // The worker committed another order while we slept. Whatever the lock
      // holder is about to write belongs to the version we came in on, which
      // is already stale — stop waiting for it and read through to the DB.
      if (polled.version !== version) {
        return this.bypass(page, limit);
      }

      if (polled.cached) {
        this.incrCounter('cache:hits');
        return {
          body: JSON.parse(polled.cached) as ProductsPageResponse,
          cacheStatus: 'HIT',
        };
      }
    }

    // Retries exhausted (rebuild is unusually slow, or the lock holder died
    // without writing). Fetch it ourselves; don't write the cache — the
    // lock holder still owns that.
    return this.bypass(page, limit);
  }

  /** Read through to Postgres, coalesced, without touching the cache. */
  private async bypass(
    page: number,
    limit: number,
  ): Promise<ProductsPageResult> {
    return {
      body: await this.singleFlightFetch(page, limit),
      cacheStatus: 'BYPASS',
    };
  }

  // -- last-resort DB read, coalesced per page/limit within this instance --

  private singleFlightFetch(
    page: number,
    limit: number,
  ): Promise<ProductsPageResponse> {
    const key = `${page}:${limit}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = this.buildResponse(page, limit).finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, promise);
    return promise;
  }

  private async buildResponse(
    page: number,
    limit: number,
  ): Promise<ProductsPageResponse> {
    const { data, meta } = await this.productsService.findPageFromDb(
      page,
      limit,
    );
    return { status: 'success', data, meta };
  }

  // -- redis plumbing --

  private async readPage(page: number, limit: number): Promise<PageSnapshot> {
    const [versionRaw, pageKey, cached] = (await this.redis.eval(
      READ_PAGE_SCRIPT,
      1,
      this.cacheVersionKey,
      this.pagePrefix(page, limit),
    )) as [string, string, string];

    return {
      // The Lua guard already forced this to a numeric string.
      version: Number(versionRaw),
      pageKey,
      cached: cached === '' ? null : cached,
    };
  }

  /**
   * Everything in the page key except the `:v:<version>` suffix, which
   * READ_PAGE_SCRIPT appends from whatever version it read.
   */
  private pagePrefix(page: number, limit: number): string {
    return `products:page:${page}:limit:${limit}`;
  }

  private lockKey(page: number, limit: number, version: number): string {
    return `products:rebuild_lock:page:${page}:limit:${limit}:v:${version}`;
  }

  private randomTtlSeconds(): number {
    const { ttlMinSeconds: min, ttlMaxSeconds: max } = this;
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  private async releaseLock(lockKey: string, token: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, token);
    } catch (err) {
      this.logger.error(
        `lock release failed for ${lockKey}: ${(err as Error).message}`,
      );
    }
  }

  /** Fire-and-forget: a hit/miss counter must never slow down or fail a request. */
  private incrCounter(key: string): void {
    this.redis.incr(key).catch((err) => {
      this.logger.warn(`incr ${key} failed: ${(err as Error).message}`);
    });
  }

  private async incrErrors(cause: unknown): Promise<void> {
    this.logger.warn(
      `redis error, falling back to DB: ${(cause as Error).message}`,
    );
    try {
      await this.redis.incr('cache:errors');
    } catch {
      // best-effort; the original error is already the thing that matters
    }
  }

  /** Its own method (not inline setTimeout) so tests can mock/spy it instead of waiting out real retry delays. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
