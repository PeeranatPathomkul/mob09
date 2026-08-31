import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

// Estimate another group's cache hit-rate from the outside.
//
//   docker compose --profile loadtest run --rm \
//     -e BASE_URL=http://172.30.58.13:8080 k6 /scripts/cache-blackbox.js
//
// You cannot observe another system's cache. Nothing in the spec obliges them
// to expose X-Cache or /api/v1/cache/stats, and most will not. What you CAN do
// is run a controlled experiment: the same request served from memory and
// served from Postgres take measurably different amounts of time, so "was that
// a hit?" becomes "which of two latency populations does this sample fall in?".
//
//   0 RECON       read anything they volunteered - X-Cache, Age, a stats
//                 endpoint. If present, use it and skip the guessing.
//   1 CALIBRATE   run a single prober ALONGSIDE the load, alternating a key
//                 that is certainly warm with a key nothing has touched. Those
//                 are known-hit and known-miss samples taken under the same
//                 queueing conditions as the traffic being classified.
//   2 CLASSIFY    split the load on a threshold derived from those two live
//                 populations.
//   3 INVALIDATE  place an order, then watch whether a later read shows the
//                 new stock - the spec 2.2 requirement, testable from outside.
//
// WHY CALIBRATION RUNS DURING THE LOAD, NOT BEFORE IT
// The first version of this script calibrated first, sequentially, and got a
// warm p50 of 1.7 ms and a cold p50 of 3.8 ms - a clean 3.0 ms threshold. Then
// it classified 91,961 requests under 100 VUs and called every single one a
// miss, because at 4,600 rps even a cache hit takes ~20 ms: queueing delay
// dwarfs the thing being measured. Scored against X-Cache, that run agreed
// with the truth on 0.0% of requests while reporting a confident 0% hit-rate.
// An idle-system baseline is worthless for classifying a busy one.
//
// Run it against your OWN system first. We emit X-Cache, so the estimate gets
// scored against ground truth and you learn how far to trust it before quoting
// it about someone else's system.

const BASE_URL = __ENV.BASE_URL || 'http://nginx';
const PRODUCT_ID = __ENV.PRODUCT_ID || 'p-1001';
const USER_ID = __ENV.USER_ID || `probe-${Date.now()}`;
const LOAD_VUS = parseInt(__ENV.LOAD_VUS || '100', 10);
const LOAD_DUR = __ENV.LOAD_DUR || '20s';

// Live calibration samples, gathered under load.
const liveWarm = new Trend('calib_live_warm_ms', true);
const liveCold = new Trend('calib_live_cold_ms', true);
const coldSlower = new Rate('calib_cold_slower_than_warm');

// k6 Trends expose percentiles, never raw samples, and the threshold is not
// known until the run ends - so classification cannot be a single comparison.
// Instead every response is scored against a ladder of candidate thresholds at
// request time, and the summary reads off whichever rung the live calibration
// turned out to justify.
const LADDER = [2, 3, 5, 8, 12, 20, 30, 45, 65, 90, 130, 180, 250, 350, 500, 750];
const ladderRate = {};
for (const t of LADDER) ladderRate[t] = new Rate(`hit_le_${t}ms`);

// Ground truth, only when the target volunteers X-Cache.
const truthHit = new Counter('truth_hit');
const truthMiss = new Counter('truth_miss');
const agreeAt = {};
for (const t of LADDER) agreeAt[t] = new Rate(`agree_le_${t}ms`);

const failed = new Counter('failed_requests');

export const options = {
  scenarios: {
    load: {
      executor: 'constant-vus',
      vus: LOAD_VUS,
      duration: LOAD_DUR,
      exec: 'classifyLoad',
      startTime: '0s',
    },
    // One VU, running for the same window, producing the known-hit and
    // known-miss samples the classifier is built from.
    calibrator: {
      executor: 'constant-vus',
      vus: 1,
      duration: LOAD_DUR,
      exec: 'calibrateLive',
      startTime: '0s',
    },
  },
  thresholds: {
    // Measurement, not judgement: nothing here passes or fails the target. The
    // one thing that would invalidate the run is the target falling over.
    failed_requests: ['count<100'],
  },
  setupTimeout: '300s',
};

function get(page, limit, tag) {
  return http.get(`${BASE_URL}/api/v1/products?page=${page}&limit=${limit}`, {
    tags: { name: tag || 'probe' },
  });
}

function parse(res) {
  if (res.status !== 200) return null;
  try {
    const b = res.json();
    return b && Array.isArray(b.data) ? b : null;
  } catch (e) {
    return null;
  }
}

/**
 * Find PRODUCT_ID's remaining stock, wherever it happens to sit.
 *
 * It is NOT safe to assume page 1. This project orders by createdAt DESC and
 * seeds p-1001 first, so the flash-sale product lands on the LAST page - which
 * silently returned null in the first version of this script and skipped the
 * invalidation test entirely. Another group's ordering is their business, so
 * walk the pages instead of guessing.
 */
function findStock(tag) {
  const first = parse(get(1, 100, tag));
  if (!first) return null;

  const hit = first.data.find((x) => x.productId === PRODUCT_ID);
  if (hit && typeof hit.remainingStock === 'number') return hit.remainingStock;

  const pages = first.meta && first.meta.totalPages ? first.meta.totalPages : 1;
  for (let p = 2; p <= Math.min(pages, 20); p++) {
    const body = parse(get(p, 100, tag));
    if (!body) continue;
    const found = body.data.find((x) => x.productId === PRODUCT_ID);
    if (found && typeof found.remainingStock === 'number') return found.remainingStock;
  }
  return null;
}

export function setup() {
  const f = { hints: [] };

  // ---- phase 0: RECON -----------------------------------------------------
  const first = get(1, 10, 'recon');
  if (first.status !== 200) {
    throw new Error(
      `target not answering GET /api/v1/products: ${first.status} ${first.body}`,
    );
  }
  for (const h of ['X-Cache', 'X-Cache-Status', 'CF-Cache-Status', 'Age', 'X-Cached']) {
    if (first.headers[h]) f.hints.push(`${h}: ${first.headers[h]}`);
  }
  const stats = http.get(`${BASE_URL}/api/v1/cache/stats`, { tags: { name: 'recon' } });
  if (stats.status === 200) {
    f.hints.push(`GET /api/v1/cache/stats -> ${String(stats.body).slice(0, 120)}`);
  }

  // ---- phase 3 (run first, while the system is quiet) ---------------------
  // Invalidation is a correctness question, and answering it under 100 VUs of
  // load would confuse "the cache did not invalidate" with "the queue was
  // backed up". Done here, the only thing between the order and the read is
  // the worker.
  const before = findStock('invalidation');
  f.stockBefore = before;
  f.invalidation = before === null
    ? `not tested - could not find ${PRODUCT_ID} in the catalogue`
    : 'not tested';

  if (before !== null) {
    const auth = http.post(
      `${BASE_URL}/api/v1/auth/token`,
      JSON.stringify({ userId: USER_ID }),
      { headers: { 'Content-Type': 'application/json' }, tags: { name: 'invalidation' } },
    );

    let token = null;
    if (auth.status === 200) {
      try {
        token = auth.json('accessToken');
      } catch (e) {
        token = null;
      }
    }

    if (!token) {
      f.invalidation = `not tested - POST /auth/token answered ${auth.status}`;
    } else {
      const order = http.post(
        `${BASE_URL}/api/v1/orders`,
        JSON.stringify({ productId: PRODUCT_ID }),
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          responseCallback: http.expectedStatuses(202, 409, 410),
          tags: { name: 'invalidation' },
        },
      );

      if (order.status !== 202) {
        f.invalidation = `order not accepted (${order.status}) - cannot test`;
      } else {
        // Writes are asynchronous by design (spec 2.3), so poll. Reading once
        // would measure the queue, not the invalidation.
        let after = before;
        let waited = 0;
        for (let i = 0; i < 30 && after === before; i++) {
          sleep(0.25);
          waited += 250;
          after = findStock('invalidation');
        }
        f.stockAfter = after;
        f.invalidation =
          after !== null && after < before
            ? `PASS - stock ${before} -> ${after}, visible after ~${waited} ms`
            : `FAIL - stock still ${before} after ~${waited} ms ` +
              `(cache never invalidated, or the order never committed)`;
      }
    }
  }

  console.log(
    `recon: ${f.hints.length ? f.hints.join(' | ') : 'no cache hints exposed'}`,
  );
  console.log(`invalidation: ${f.invalidation}`);
  return f;
}

/**
 * Known-hit and known-miss samples, taken while the load runs.
 *
 * warm: page 1 limit 10 - the same key the load hammers, so it is certainly
 *       cached if the target caches anything at all.
 * cold: a page nothing has touched, a fresh one each iteration. Its first read
 *       cannot be a hit.
 *
 * Caveat worth knowing before trusting the cold figure: on a small catalogue a
 * deep page returns no rows, so its query may be cheap enough that the miss
 * penalty is understated. It still exercises the cache lookup, the lock and
 * the round trip to the database, which is what the threshold is separating.
 */
export function calibrateLive() {
  const warm = get(1, 10, 'calib_warm');
  if (warm.status === 200) liveWarm.add(warm.timings.duration);

  // __ITER climbs, so each iteration asks for a page the run has not used.
  // Kept under 1000 so a target that bounds page answers 200, not 400.
  const coldPage = 50 + (__ITER % 900);
  const cold = get(coldPage, 10, 'calib_cold');
  if (cold.status === 200) liveCold.add(cold.timings.duration);

  if (warm.status === 200 && cold.status === 200) {
    coldSlower.add(cold.timings.duration > warm.timings.duration);
  }

  sleep(0.05);
}

export function classifyLoad() {
  const page = ((__ITER + __VU) % 2) + 1;
  const res = get(page, 10, 'load');

  if (res.status !== 200) {
    failed.add(1);
    check(res, { 'load: 200': () => false });
    return;
  }

  const ms = res.timings.duration;
  const xc = res.headers['X-Cache'] || res.headers['x-cache'];
  const actualHit = xc ? String(xc).toUpperCase() === 'HIT' : null;

  if (actualHit !== null) {
    if (actualHit) truthHit.add(1);
    else truthMiss.add(1);
  }

  for (const t of LADDER) {
    const guess = ms <= t;
    ladderRate[t].add(guess);
    if (actualHit !== null) agreeAt[t].add(guess === actualHit);
  }
}

export function handleSummary(data) {
  const out = __ENV.OUT || '/scripts/results/cache-blackbox.json';
  const m = data.metrics;
  const g = (name, field = 'count') =>
    m[name] && m[name].values[field] !== undefined ? m[name].values[field] : 0;
  const f = data.setup_data || {};
  const n = (v) => Number(v || 0).toFixed(1);

  const warmP50 = g('calib_live_warm_ms', 'med');
  const warmP95 = g('calib_live_warm_ms', 'p(95)');
  const coldP50 = g('calib_live_cold_ms', 'med');
  const coldSlowerRate = m['calib_cold_slower_than_warm']
    ? m['calib_cold_slower_than_warm'].values.rate
    : 0;

  // A cache is only credible if the untouched key was slower than the hot one
  // most of the time, and the two populations actually separate.
  const detected = coldSlowerRate >= 0.7 && coldP50 > warmP95;
  const threshold = detected ? (warmP95 + coldP50) / 2 : warmP95;

  // Read off the ladder rung closest to the threshold the calibration implies.
  let rung = LADDER[0];
  for (const t of LADDER) {
    if (Math.abs(t - threshold) < Math.abs(rung - threshold)) rung = t;
  }

  const rate = m[`hit_le_${rung}ms`] ? m[`hit_le_${rung}ms`].values.rate : 0;
  const classified = m[`hit_le_${rung}ms`]
    ? m[`hit_le_${rung}ms`].values.passes + m[`hit_le_${rung}ms`].values.fails
    : 0;

  const truthTotal = g('truth_hit') + g('truth_miss');
  const truthRate = truthTotal ? g('truth_hit') / truthTotal : 0;
  const agreement = m[`agree_le_${rung}ms`] ? m[`agree_le_${rung}ms`].values.rate : 0;

  // When ground truth exists, also report the rung that WOULD have been best.
  // The gap between it and the chosen rung is the calibration's own error.
  let bestRung = rung;
  let bestAgree = agreement;
  if (truthTotal) {
    for (const t of LADDER) {
      const a = m[`agree_le_${t}ms`] ? m[`agree_le_${t}ms`].values.rate : 0;
      if (a > bestAgree) {
        bestAgree = a;
        bestRung = t;
      }
    }
  }

  const lines = [
    '',
    `  BLACK-BOX CACHE ESTIMATE   target ${BASE_URL}`,
    '',
    '  0 RECON - what the target volunteers',
    ...(f.hints && f.hints.length
      ? f.hints.map((h) => `      ${h}`)
      : [
          '      nothing: no X-Cache/Age header, no /api/v1/cache/stats.',
          '      Everything below is inferred from timing alone.',
        ]),
    '',
    '  1 LIVE CALIBRATION   (sampled during the load, not before it)',
    `      known hit  (hot key)      p50 ${n(warmP50)} ms   p95 ${n(warmP95)} ms`,
    `      known miss (fresh key)    p50 ${n(coldP50)} ms`,
    `      fresh key was slower      ${(coldSlowerRate * 100).toFixed(1)}% of the time`,
    '',
    `      cache detected: ${detected ? 'YES' : 'NO'}`,
    ...(detected
      ? [`      classifier: <= ${rung} ms counts as a hit (threshold ${n(threshold)} ms)`]
      : [
          '      The two populations did not separate. Either there is no cache,',
          '      or the database is fast enough that timing cannot tell them',
          '      apart. Treat the hit-rate below as unreliable.',
        ]),
    '',
    '  2 INFERRED HIT-RATE UNDER LOAD',
    `      requests classified   ${classified}`,
    `      inferred hit-rate     ${(rate * 100).toFixed(1)}%`,
    '',
  ];

  if (truthTotal) {
    lines.push(
      '  ACCURACY - target emitted X-Cache, so the estimate can be scored',
      `      actual hit-rate       ${(truthRate * 100).toFixed(1)}%`,
      `      inferred hit-rate     ${(rate * 100).toFixed(1)}%`,
      `      per-request agreement ${(agreement * 100).toFixed(1)}%`,
      `      best possible rung    <= ${bestRung} ms -> ${(bestAgree * 100).toFixed(1)}% agreement`,
      '',
      '      Agreement is the number that matters: a hit-rate can land close',
      '      by having its errors cancel out. The gap between the chosen rung',
      '      and the best possible one is the calibration error alone.',
      '',
    );
  } else {
    lines.push(
      '      No X-Cache from this target, so accuracy is unknown. Run this',
      '      same script against your own system to see how far the timing',
      '      method can be trusted before quoting it about someone else.',
      '',
    );
  }

  lines.push(
    '  3 CACHE INVALIDATION (spec 2.2)',
    `      ${f.invalidation || 'not tested'}`,
    '',
    '  CAVEATS',
    '      Timing is a proxy, not a measurement. A miss that waits on another',
    '      request rebuild lock looks exactly like a slow hit, because it is',
    '      one. Calibration is sampled by a single prober, so a target whose',
    '      latency drifts during the run will blur the split.',
    '',
    `      failed requests during load: ${g('failed_requests')}`,
    '',
  );

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }) + '\n' + lines.join('\n'),
    [out]: JSON.stringify(data, null, 2),
  };
}
