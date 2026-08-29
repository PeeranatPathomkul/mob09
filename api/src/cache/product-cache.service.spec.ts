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
  const mock: RedisMock = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    incr: jest.fn().mockResolvedValue(1),
    eval: jest.fn(),
  };

  // The service reads the version and the page for it through a single Lua
  // script. Emulating that script on top of the same get() mock means tests
  // still seed plain keys, the way they would against a real Redis, instead
  // of having to know the script's reply shape.
  mock.eval.mockImplementation(
    async (script: string, _numKeys: number, key: string, arg: string) => {
      // The other script is the compare-and-delete lock release.
      if (!String(script).includes('pageKey')) return 1;

      const raw = (await mock.get(key)) as string | null;
      const version =
        raw !== null && raw !== '' && Number.isFinite(Number(raw))
          ? String(raw)
          : '0';
      const pageKey = `${arg}:v:${version}`;
      const cached = (await mock.get(pageKey)) as string | null;
      return [version, pageKey, cached ?? ''];
    },
  );

  return mock;
}

/** Lock releases only — the read path goes through eval() too now. */
function lockReleaseCalls(redis: RedisMock): unknown[][] {
  return (redis.eval.mock.calls as unknown[][]).filter((call) =>
    String(call[0]).includes('del'),
  );
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
    expect(lockReleaseCalls(redis)).toHaveLength(1); // compare-and-delete
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
    // One poll round with the rebuild still in flight.
    await jest.advanceTimersByTimeAsync(10);

    resolveDb(emptyPage());
    // Let the winner write the page and release the lock. Draining the
    // microtask queue via the timer helper rather than a fixed number of
    // Promise.resolve() hops, so this does not need updating whenever the
    // await chain in the rebuild path changes length.
    await jest.advanceTimersByTimeAsync(0);

    // Next poll round: the losers now find the page key populated.
    await jest.advanceTimersByTimeAsync(10);

    const results = await Promise.all(requests);

    expect(productsService.findPageFromDb).toHaveBeenCalledTimes(1);
    results.forEach((r) =>
      expect(r).toEqual({ status: 'success', ...emptyPage() }),
    );
  });

  it('lock retries exhausted: falls back to a single-flight DB read and does not write the cache', async () => {
    const sleepSpy = jest
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

    expect(sleepSpy).toHaveBeenCalledTimes(3); // every retry used up
    expect(productsService.findPageFromDb).toHaveBeenCalledTimes(1);
    expect(redis.set).not.toHaveBeenCalledWith(
      'products:page:1:limit:10:v:0',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(result).toEqual({ status: 'success', ...emptyPage() });
  });

  it('version moves while polling: bails out after one poll instead of waiting for a rebuild that is already stale', async () => {
    const sleepSpy = jest
      .spyOn(
        service as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep',
      )
      .mockResolvedValue(undefined);

    // This caller loses the rebuild lock, so it polls.
    redis.set.mockImplementation((key: string) =>
      Promise.resolve(key.startsWith('products:rebuild_lock:') ? null : 'OK'),
    );

    // A worker commits another order between the first read and the first
    // poll, moving the version from 0 to 1.
    let versionReads = 0;
    redis.get.mockImplementation((key: string) => {
      if (key === VERSION_KEY) {
        versionReads += 1;
        return Promise.resolve(versionReads === 1 ? '0' : '1');
      }
      return Promise.resolve(null); // no page cached under either version
    });
    productsService.findPageFromDb.mockResolvedValue(emptyPage());

    const result = await service.getProductsPage(1, 10);

    // Gave up on the first poll rather than spending all 3 retries waiting
    // for a v:0 rebuild that no longer describes current stock.
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(productsService.findPageFromDb).toHaveBeenCalledTimes(1);
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
