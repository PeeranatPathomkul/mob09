import http from 'k6/http';
import { check, sleep } from 'k6';

// Deterministic proof that GET /api/v1/products actually goes through the
// page cache: not a load test (see products-read.js for that) — a single VU,
// single pass that shows miss -> hit -> hit against /api/v1/cache/stats.
//
//   k6 run -e BASE_URL=http://localhost:8080 load-test/cache-hit-miss.js
//
// LIMIT defaults to a random value so each run starts on a page key nothing
// has warmed up yet. Pinning it (-e LIMIT=10) is fine for a repeat run, but
// then the first request only registers as a miss if the previous run's key
// has already aged out (TTL is 30-60s).

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const PAGE = parseInt(__ENV.PAGE || '1', 10);
// 1-100 is the range the DTO accepts. Random, so a re-run within the cache
// TTL does not land on the key the previous run just populated.
const LIMIT = parseInt(__ENV.LIMIT || String(1 + Math.floor(Math.random() * 100)), 10);
const REPEAT_HITS = parseInt(__ENV.REPEAT_HITS || '3', 10);

export const options = {
  scenarios: {
    cache_probe: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
    },
  },
};

function getStats() {
  const res = http.get(`${BASE_URL}/api/v1/cache/stats`);
  const ok = check(res, { 'stats: 200 OK': (r) => r.status === 200 });
  // A null body (e.g. server unreachable) would otherwise throw out of
  // res.json() and abort the whole run with an opaque GoError.
  return ok ? res.json() : { hits: NaN, misses: NaN, currentVersion: NaN };
}

function getProducts(tagName) {
  // Tagging separates these two call sites in the k6 summary
  // (http_req_duration{name:products_miss} vs {name:products_hit}) instead of
  // lumping every /products call — miss and hit alike — into one average.
  return http.get(`${BASE_URL}/api/v1/products?page=${PAGE}&limit=${LIMIT}`, {
    tags: { name: tagName },
  });
}

/**
 * Compare two responses field by field, never via JSON.stringify.
 *
 * k6 runs on goja and res.json() hands back Go maps, whose key iteration
 * order Go randomises on purpose. Stringifying `meta` therefore produces a
 * different string on every call for byte-identical payloads, which made an
 * earlier version of this script report differences that did not exist.
 * Reading scalars out by name sidesteps that entirely.
 */
function describe(body) {
  const data = body.data || [];
  return {
    status: body.status,
    total: body.meta ? body.meta.total : null,
    page: body.meta ? body.meta.page : null,
    limit: body.meta ? body.meta.limit : null,
    totalPages: body.meta ? body.meta.totalPages : null,
    count: data.length,
    // join() keeps array order, which IS stable — only map key order is not.
    ids: data.map((p) => p.productId).join(','),
    stock: data.map((p) => p.remainingStock).join(','),
  };
}

function sameData(a, b) {
  const x = describe(a);
  const y = describe(b);
  return (
    x.status === y.status &&
    x.total === y.total &&
    x.page === y.page &&
    x.limit === y.limit &&
    x.totalPages === y.totalPages &&
    x.count === y.count &&
    x.ids === y.ids &&
    x.stock === y.stock
  );
}

export default function () {
  console.log(`probing page=${PAGE} limit=${LIMIT}`);

  const before = getStats();
  console.log(`before: hits=${before.hits} misses=${before.misses} version=${before.currentVersion}`);

  // --- 1) first hit on this page/limit: must be a miss ---
  const missRes = getProducts('products_miss');
  check(missRes, { 'first request: 200 OK': (r) => r.status === 200 });
  const missBody = missRes.json();
  console.log(`1st request (miss, hits DB): ${missRes.timings.duration.toFixed(2)}ms`);

  sleep(0.2); // let the fire-and-forget INCR land before we read stats back
  const afterMiss = getStats();
  console.log(
    `after 1st request: hits=${afterMiss.hits} (+${afterMiss.hits - before.hits}) ` +
      `misses=${afterMiss.misses} (+${afterMiss.misses - before.misses}) version=${afterMiss.currentVersion}`,
  );

  const wasMiss = afterMiss.misses === before.misses + 1;
  if (!wasMiss) {
    console.warn(
      `first request did NOT register as a miss — the key for limit=${LIMIT} was ` +
        `already cached (a previous run inside the 30-60s TTL). Re-run, or pass a different -e LIMIT=.`,
    );
  }
  check(null, {
    'first request registered as a cache miss': () => wasMiss,
    'first request did not register as a hit': () => afterMiss.hits === before.hits,
  });

  // --- 2) repeat the exact same request: must be a hit, same data, misses unchanged ---
  let hits = afterMiss.hits;
  const misses = afterMiss.misses;

  for (let i = 0; i < REPEAT_HITS; i++) {
    const hitRes = getProducts('products_hit');
    check(hitRes, { [`repeat request ${i + 1}: 200 OK`]: (r) => r.status === 200 });

    const identical = sameData(hitRes.json(), missBody);
    if (!identical) {
      console.error(`repeat ${i + 1} differs!`);
      console.error(`  first : ${JSON.stringify(describe(missBody))}`);
      console.error(`  repeat: ${JSON.stringify(describe(hitRes.json()))}`);
    }
    check(null, {
      [`repeat request ${i + 1}: same data as the first response`]: () => identical,
    });
    console.log(`repeat ${i + 1} (hit, served from Redis): ${hitRes.timings.duration.toFixed(2)}ms`);

    sleep(0.2);
    const afterHit = getStats();
    console.log(`after repeat ${i + 1}: hits=${afterHit.hits} misses=${afterHit.misses}`);

    check(null, {
      [`repeat request ${i + 1} registered as a cache hit`]: () => afterHit.hits === hits + 1,
      [`repeat request ${i + 1} did not register as a miss`]: () => afterHit.misses === misses,
    });

    hits = afterHit.hits;
  }
}
