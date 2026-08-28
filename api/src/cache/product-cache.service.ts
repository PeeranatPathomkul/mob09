import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { ProductDto, ProductsService } from '../products/products.service';

export interface ProductsPageResponse {
  status: 'success';
  data: ProductDto[];
  meta: { total: number; page: number; limit: number; totalPages: number };
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
    this.cacheVersionKey =
      this.config.get<string>('CACHE_VERSION_KEY') ?? 'products:cache:version';
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
      this.config.get('PRODUCT_CACHE_LOCK_RETRY_MAX') ?? 5,
    );
    this.lockRetryDelayMs = Number(
      this.config.get('PRODUCT_CACHE_LOCK_RETRY_DELAY_MS') ?? 50,
    );
  }

  async getProductsPage(
    page: number,
    limit: number,
  ): Promise<ProductsPageResponse> {
    let version: number;
    try {
      version = await this.readVersion();
    } catch (err) {
      await this.incrErrors(err);
      return this.singleFlightFetch(page, limit);
    }

    const pageKey = this.pageKey(page, limit, version);

    let cached: string | null;
    try {
      cached = await this.redis.get(pageKey);
    } catch (err) {
      await this.incrErrors(err);
      return this.singleFlightFetch(page, limit);
    }

    if (cached) {
      this.incrCounter('cache:hits');
      return JSON.parse(cached) as ProductsPageResponse;
    }

    this.incrCounter('cache:misses');
    return this.rebuildOrWait(page, limit, version, pageKey);
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
    version: number,
    pageKey: string,
  ): Promise<ProductsPageResponse> {
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
      return this.singleFlightFetch(page, limit);
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
        return body;
      } finally {
        await this.releaseLock(lockKey, token);
      }
    }

    // Someone else is rebuilding — poll for the page key rather than piling
    // another query onto Postgres.
    for (let attempt = 0; attempt < this.lockRetryMax; attempt++) {
      await this.sleep(this.lockRetryDelayMs);

      let polled: string | null;
      try {
        polled = await this.redis.get(pageKey);
      } catch (err) {
        await this.incrErrors(err);
        return this.singleFlightFetch(page, limit);
      }

      if (polled) {
        this.incrCounter('cache:hits');
        return JSON.parse(polled) as ProductsPageResponse;
      }
    }

    // Retries exhausted (rebuild is unusually slow, or the lock holder died
    // without writing). Fetch it ourselves; don't write the cache — the
    // lock holder still owns that.
    return this.singleFlightFetch(page, limit);
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

  private async readVersion(): Promise<number> {
    const raw = await this.redis.get(this.cacheVersionKey);
    const version = Number(raw);
    return Number.isFinite(version) ? version : 0;
  }

  private pageKey(page: number, limit: number, version: number): string {
    return `products:page:${page}:limit:${limit}:v:${version}`;
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
