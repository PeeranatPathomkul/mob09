# Product cache module (read path)

Caches `GET /api/v1/products?page&limit`. Owns nothing about writes — the
orders worker (`orders.processor.ts`) is the only writer of stock, and it
invalidates this cache itself by incrementing `CACHE_VERSION_KEY` directly;
`ProductCacheService.invalidateProductCache()` does the same `INCR` and is
exported for any other caller that needs it, but the worker does not call it.

## Strategy: hybrid page cache + version counter

- `${CACHE_VERSION_KEY}` (default `products:cache:version`) is a counter
  bumped once per committed stock change.
- Each page is cached under `products:page:{page}:limit:{limit}:v:{version}`.
  Bumping the version doesn't delete anything — it just changes which key the
  next read looks for, so every old page for the previous version goes stale
  atomically, in O(1), with no SCAN/DEL pass over Redis.
- A per-key TTL (jittered 30–60s by default) is a safety net that eventually
  cleans up keys from versions nobody reads anymore. It is not what keeps the
  cache correct — the version bump is.
- On a miss, a `SET NX PX` rebuild lock ensures only one request per
  `page:limit:version` queries Postgres; everyone else polls the page key
  briefly and then, if it still isn't there, falls back to querying the DB
  themselves (coalesced per-instance via a single-flight map, so a Redis
  outage doesn't turn into a thundering herd on Postgres either).

## Accepted trade-offs

- **Hit-rate is expected to be low during a flash sale, on purpose.** Every
  successful order bumps the version, which invalidates every cached page for
  it immediately. This module's job is to cap how many requests reach
  Postgres per version (via the rebuild mutex — at most one query per
  `page:limit` combination actually in use), not to maximize hit-rate.
- **`remainingStock` can be briefly stale.** It's baked into the cached page
  blob rather than read live, so there's a short window between a version
  bump and the next rebuild where a cached page still shows the pre-bump
  stock. Bounded by the rebuild mutex's latency, not by TTL.
- **Only stock changes bump the version.** Editing a product's name/price,
  adding/removing a product, or toggling `isFlashSaleActive` does not — the
  dataset is assumed static during a load test. If that stops being true,
  those code paths need their own `invalidateProductCache()` call.
- **No stats reset endpoint.** `load-test/reset.sh` clears `cache:hits` /
  `cache:misses` (and the rest of the Redis state) between runs instead.
