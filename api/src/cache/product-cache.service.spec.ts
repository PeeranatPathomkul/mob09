import { Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { ProductCacheService } from './product-cache.service';
import { ProductsService, ProductsPage } from '../products/products.service';

const VERSION_KEY = 'products:cache:version';

type RedisMock = {
  get: jest.Mock;
  set: jest.Mock;
  incr: jest.Mock;
  eval: jest.Mock;
};

function createRedisMock(): RedisMock {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    incr: jest.fn().mockResolvedValue(1),
    eval: jest.fn().mockResolvedValue(1),
  };
}

function emptyPage(page = 1, limit = 10): ProductsPage {
  return { data: [], meta: { total: 0, page, limit, totalPages: 1 } };
}

describe('ProductCacheService', () => {
  let redis: RedisMock;
  let productsService: jest.Mocked<Pick<ProductsService, 'findPageFromDb'>>;
  let service: ProductCacheService;

  beforeEach(() => {
    redis = createRedisMock();
    productsService = { findPageFromDb: jest.fn() };
    const config = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    service = new ProductCacheService(
      productsService as unknown as ProductsService,
      redis as unknown as Redis,
      config,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('cache hit: reads straight from the page key, never touches the DB', async () => {
    const cachedBody = {
      status: 'success',
      data: [{ productId: 'p-1001' }],
      meta: emptyPage().meta,
    };
    redis.get.mockImplementation((key: string) => {
      if (key === VERSION_KEY) return Promise.resolve(null);
      if (key === 'products:page:1:limit:10:v:0')
        return Promise.resolve(JSON.stringify(cachedBody));
      return Promise.resolve(null);
    });

    const result = await service.getProductsPage(1, 10);

    expect(result).toEqual(cachedBody);
    expect(productsService.findPageFromDb).not.toHaveBeenCalled();
    expect(redis.incr).toHaveBeenCalledWith('cache:hits');
  });

  it('cache miss, lock acquired: queries the DB once, writes the page cache, releases the lock', async () => {
    productsService.findPageFromDb.mockResolvedValue(emptyPage());

    const result = await service.getProductsPage(1, 10);

    expect(productsService.findPageFromDb).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      'products:rebuild_lock:page:1:limit:10:v:0',
      expect.any(String),
      'PX',
      5000,
      'NX',
    );
    expect(redis.set).toHaveBeenCalledWith(
      'products:page:1:limit:10:v:0',
      JSON.stringify(result),
      'EX',
      expect.any(Number),
    );
    expect(redis.eval).toHaveBeenCalledTimes(1); // compare-and-delete lock release
    expect(redis.incr).toHaveBeenCalledWith('cache:misses');
    expect(result).toEqual({ status: 'success', ...emptyPage() });
  });

  it('5 concurrent requests on a miss: exactly one query hits the DB, the rest poll into the fresh cache', async () => {
    jest.useFakeTimers();

    let lockClaimed = false;
    let written: string | null = null;
    const pageKey = 'products:page:1:limit:10:v:0';

    redis.get.mockImplementation((key: string) => {
      if (key === VERSION_KEY) return Promise.resolve(null);
      if (key === pageKey) return Promise.resolve(written);
      return Promise.resolve(null);
    });
    redis.set.mockImplementation((key: string, value: string) => {
      if (key.startsWith('products:rebuild_lock:')) {
        if (lockClaimed) return Promise.resolve(null);
        lockClaimed = true;
        return Promise.resolve('OK');
      }
      written = value;
      return Promise.resolve('OK');
    });

    let resolveDb!: (page: ProductsPage) => void;
    productsService.findPageFromDb.mockReturnValue(
      new Promise<ProductsPage>((resolve) => {
        resolveDb = resolve;
      }),
    );

    const requests = Array.from({ length: 5 }, () =>
      service.getProductsPage(1, 10),
    );

    // Let all 5 reach their first blocking point: the winner inside the DB
    // call, the 4 losers inside their poll-loop sleep().
    await jest.advanceTimersByTimeAsync(0);
    // One retry round with nothing written yet.
    await jest.advanceTimersByTimeAsync(50);

    resolveDb(emptyPage());
    await Promise.resolve(); // let the winner's .then chain write the cache
    await Promise.resolve();

    // Next retry round: the losers now find the page key populated.
    await jest.advanceTimersByTimeAsync(50);

    const results = await Promise.all(requests);

    expect(productsService.findPageFromDb).toHaveBeenCalledTimes(1);
    results.forEach((r) =>
      expect(r).toEqual({ status: 'success', ...emptyPage() }),
    );
  });

  it('lock retries exhausted: falls back to a single-flight DB read and does not write the cache', async () => {
    jest
      .spyOn(
        service as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep',
      )
      .mockResolvedValue(undefined);
    redis.set.mockImplementation((key: string) => {
      // Someone else always holds the rebuild lock; the page key never appears.
      if (key.startsWith('products:rebuild_lock:'))
        return Promise.resolve(null);
      return Promise.resolve('OK');
    });
    productsService.findPageFromDb.mockResolvedValue(emptyPage());

    const result = await service.getProductsPage(1, 10);

    expect(productsService.findPageFromDb).toHaveBeenCalledTimes(1);
    expect(redis.set).not.toHaveBeenCalledWith(
      'products:page:1:limit:10:v:0',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(result).toEqual({ status: 'success', ...emptyPage() });
  });

  it('invalidateProductCache bumps the version; the next read looks up the new version key', async () => {
    await service.invalidateProductCache();
    expect(redis.incr).toHaveBeenCalledWith(VERSION_KEY);

    redis.get.mockImplementation((key: string) =>
      key === VERSION_KEY ? Promise.resolve('1') : Promise.resolve(null),
    );
    productsService.findPageFromDb.mockResolvedValue(emptyPage());

    await service.getProductsPage(1, 10);

    expect(redis.get).toHaveBeenCalledWith('products:page:1:limit:10:v:1');
  });

  it('Redis down: 3 concurrent requests coalesce into a single DB query, never throw', async () => {
    redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
    redis.incr.mockRejectedValue(new Error('ECONNREFUSED'));
    productsService.findPageFromDb.mockResolvedValue(emptyPage());

    const results = await Promise.all([
      service.getProductsPage(1, 10),
      service.getProductsPage(1, 10),
      service.getProductsPage(1, 10),
    ]);

    expect(productsService.findPageFromDb).toHaveBeenCalledTimes(1);
    results.forEach((r) =>
      expect(r).toEqual({ status: 'success', ...emptyPage() }),
    );
    expect(redis.incr).toHaveBeenCalledWith('cache:errors');
  });

  it('invalidateProductCache swallows a Redis error instead of throwing', async () => {
    redis.incr.mockRejectedValue(new Error('down'));
    await expect(service.invalidateProductCache()).resolves.toBeUndefined();
  });

  it('empty result page: still writes the cache entry, with correct meta', async () => {
    productsService.findPageFromDb.mockResolvedValue(emptyPage(5, 10));

    const result = await service.getProductsPage(5, 10);

    expect(result).toEqual({ status: 'success', ...emptyPage(5, 10) });
    expect(redis.set).toHaveBeenCalledWith(
      'products:page:5:limit:10:v:0',
      JSON.stringify(result),
      'EX',
      expect.any(Number),
    );
  });

  describe('getStats', () => {
    it('computes hitRate from hits/misses and reports the current version', async () => {
      const values: Record<string, string> = {
        'cache:hits': '8',
        'cache:misses': '2',
        'cache:errors': '1',
        [VERSION_KEY]: '3',
      };
      redis.get.mockImplementation((key: string) =>
        Promise.resolve(values[key] ?? null),
      );

      const stats = await service.getStats();

      expect(stats).toEqual({
        hits: 8,
        misses: 2,
        errors: 1,
        hitRate: 0.8,
        currentVersion: 3,
        redisAvailable: true,
      });
    });

    it('hitRate is 0, not NaN, when hits + misses is 0', async () => {
      const stats = await service.getStats();
      expect(stats.hitRate).toBe(0);
    });

    it('Redis down: returns zeros and redisAvailable=false instead of throwing', async () => {
      redis.get.mockRejectedValue(new Error('down'));

      await expect(service.getStats()).resolves.toEqual({
        hits: 0,
        misses: 0,
        errors: 0,
        hitRate: 0,
        currentVersion: 0,
        redisAvailable: false,
      });
    });
  });
});
