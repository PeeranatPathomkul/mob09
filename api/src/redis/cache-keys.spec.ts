import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_CACHE_VERSION_KEY,
  resolveCacheVersionKey,
} from './cache-keys';

describe('resolveCacheVersionKey', () => {
  it('returns the configured key when one is set', () => {
    expect(resolveCacheVersionKey('custom:version')).toBe('custom:version');
  });

  it('falls back to the default when unset', () => {
    expect(resolveCacheVersionKey(undefined)).toBe(DEFAULT_CACHE_VERSION_KEY);
    expect(resolveCacheVersionKey(null)).toBe(DEFAULT_CACHE_VERSION_KEY);
  });

  // An empty CACHE_VERSION_KEY in the environment must not become an empty
  // Redis key name on one side and the default on the other.
  it('treats a blank or whitespace-only setting as unset', () => {
    expect(resolveCacheVersionKey('')).toBe(DEFAULT_CACHE_VERSION_KEY);
    expect(resolveCacheVersionKey('   ')).toBe(DEFAULT_CACHE_VERSION_KEY);
  });

  it('trims surrounding whitespace off a configured key', () => {
    expect(resolveCacheVersionKey('  spaced:key  ')).toBe('spaced:key');
  });
});

/**
 * The bug this guards against: the reader and the worker each held their own
 * copy of the literal `'products:cache:version'`. Changing one and not the
 * other would leave the worker bumping a key nobody reads — invalidation
 * dead, `remainingStock` stale until TTL, and not one error anywhere to show
 * for it. Nothing at runtime can catch that, so it is caught here instead.
 */
describe('cache version key has exactly one definition', () => {
  const sources = [
    'cache/product-cache.service.ts',
    'orders/orders.processor.ts',
  ];

  it.each(sources)('%s resolves the key instead of hardcoding it', (file) => {
    const source = readFileSync(join(__dirname, '..', file), 'utf-8');

    expect(source).toContain('resolveCacheVersionKey');
    expect(source).not.toContain(DEFAULT_CACHE_VERSION_KEY);
  });
});
