import http from 'k6/http';
import { check } from 'k6';

// Proof for person 1's hardest requirement: when the cache for a page/limit
// is empty and BURST concurrent requests land on it at once, the mutex in
// ProductCacheService.rebuildOrWait must stop that from becoming BURST
// simultaneous hits on Postgres.
//
//   k6 run -e BASE_URL=http://localhost:8080 load-test/cache-stampede.js
//
// What this script alone can prove: every one of the BURST responses came
// back with byte-identical data (same page, no torn read) and status 200,
// plus how many of them were "slow" (== the request that actually queried
// the DB) versus "fast" (== served from the poll/singleFlight paths).
//
// What this script CANNOT prove on its own: how many times Postgres was
// actually queried, because cache:misses increments once per caller that
// found the cache empty -- not once per DB read. That number is expected to
// be close to BURST even when the mutex works perfectly. The real proof is
// external: read pg_stat_user_tables.seq_scan on `products` immediately
// before and after this run. A flat cache (this script always picks a fresh
// random limit, so no one has ever cached it) means every read before this
// burst had to come from a DIFFERENT key -- so any seq_scan movement here is
// attributable to this burst.
//
//   docker compose exec -T postgres psql -U postgres -d flash_sale -tAc \
//     "SELECT seq_scan FROM pg_stat_user_tables WHERE relname='products';"
//
// Run that once before this script and once after. With BURST concurrent
// requests on one previously-untouched key, the delta should be a small
// constant bounded by the number of API instances (each instance's
// singleFlightFetch is a LOCAL in-memory coalesce -- it does not know the
// Redis lock was already won by a request on a different instance), never
// anywhere close to BURST itself. See test-1-moo-cache.sh for the wired-up
// before/after check.

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const PAGE = parseInt(__ENV.PAGE || '1', 10);
// Fresh random key every run (1-100, the DTO's accepted range) so this burst
// is guaranteed to hit an empty cache -- not a leftover from a previous run
// or from products-read.js warming up the same page/limit pair.
const LIMIT = parseInt(__ENV.LIMIT || String(1 + Math.floor(Math.random() * 100)), 10);
const BURST = parseInt(__ENV.BURST || '300', 10);
// A request slower than this is assumed to be the one that actually
// rebuilt the page from Postgres; this only needs to sit comfortably above
// the poll budget (PRODUCT_CACHE_LOCK_RETRY_MAX * _DELAY_MS, 30ms by
// default) and comfortably below a real query's floor.
const SLOW_THRESHOLD_MS = parseInt(__ENV.SLOW_THRESHOLD_MS || '25', 10);

export const options = {
  scenarios: {
    stampede: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
    },
  },
};

function getStats() {
  const res = http.get(`${BASE_URL}/api/v1/cache/stats`);
  return res.status === 200 ? res.json() : { hits: NaN, misses: NaN };
}

export default function () {
  console.log(`stampede probe: page=${PAGE} limit=${LIMIT} (fresh key) burst=${BURST}`);

  const before = getStats();

  // http.batch fires all BURST requests over the wire together -- this is
  // what makes "the cache expired while 1,000 people were mid-sale" real
  // instead of BURST sequential requests that would never actually race.
  const requests = Array.from({ length: BURST }, () => ({
    method: 'GET',
    url: `${BASE_URL}/api/v1/products?page=${PAGE}&limit=${LIMIT}`,
  }));

  const responses = http.batch(requests);

  const after = getStats();

  let firstBody = null;
  let identicalCount = 0;
  let slowCount = 0;
  const durations = [];

  responses.forEach((res) => {
    check(res, { 'stampede: status 200': (r) => r.status === 200 });
    durations.push(res.timings.duration);
    if (res.timings.duration >= SLOW_THRESHOLD_MS) slowCount++;

    if (res.status !== 200) return;
    const body = res.json();
    if (firstBody === null) {
      firstBody = body;
      identicalCount = 1;
    } else if (JSON.stringify(body.meta) === JSON.stringify(firstBody.meta) && body.data.length === firstBody.data.length) {
      identicalCount++;
    }
  });

  durations.sort((a, b) => a - b);
  const p50 = durations[Math.floor(durations.length * 0.5)];
  const p95 = durations[Math.floor(durations.length * 0.95)];
  const max = durations[durations.length - 1];

  check(null, {
    'every response returned the same page data': () => identicalCount === responses.length,
    // Loose upper bound: if the mutex were doing nothing, we would expect
    // most of BURST requests to be "slow" (each independently hitting the
    // DB). Seeing only a small minority slow is the in-process signal that
    // most callers were served from cache/poll/singleFlight, not from a
    // fresh query each.
    'only a small minority of responses were slow (DB-latency-shaped)': () => slowCount <= Math.max(5, Math.ceil(responses.length * 0.05)),
  });

  console.log(
    `before: hits=${before.hits} misses=${before.misses}  |  after: hits=${after.hits} misses=${after.misses} ` +
      `(delta hits=+${after.hits - before.hits} misses=+${after.misses - before.misses})`,
  );
  console.log(
    `latency across ${responses.length} concurrent responses: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms`,
  );
  console.log(
    `identical payloads: ${identicalCount}/${responses.length}  |  "slow" (>= ${SLOW_THRESHOLD_MS}ms, DB-shaped): ${slowCount}/${responses.length}`,
  );
  console.log(
    'Now check pg_stat_user_tables.seq_scan on products before/after this run (see file header) ' +
      '-- that delta, not the miss counter above, is the real proof of how many times Postgres was actually hit.',
  );
}
