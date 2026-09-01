import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

// Gap group 4 — CACHE INVALIDATION (spec 2.2, "เงื่อนไขสำคัญ").
//
//   bash load-test/reset.sh          # optional, but the numbers are cleaner
//   k6 run -e BASE_URL=http://localhost:8080 load-test/cache-invalidation.js
//   docker compose --profile loadtest run --rm \
//     -e BASE_URL=http://172.30.58.13:8080 k6 /scripts/cache-invalidation.js
//
// The spec's hardest read-side requirement is not "be fast", it is "be fast
// AND never lie about remainingStock". Nothing in the suite measured that as a
// number: cache-blackbox.js answers it once, PASS/FAIL, on an idle system, and
// orders-50.js's teardown only asks whether the value moved at all.
//
// What this script produces instead:
//
//   1. STALENESS, in milliseconds, per round: order committed -> the new
//      stock visible through GET. A Trend, with a threshold, not a verdict.
//   2. PER-VARIANT staleness. The product appears on a page for EVERY page
//      size, so a cache invalidated by one key while the other three keep
//      serving the old page is the classic partial-invalidation bug — it is
//      invisible unless you read every variant, which is why this checks all
//      of them and reports the worst.
//   3. EXACTLY-ONE decrement per order. One order must move stock by 1, not
//      by 2 (double-processed job) and not by 0 (lost job that still reported
//      202).
//   4. MONOTONICITY, asserted as a hard failure rather than a warning: within
//      one reader's own sequential reads, remainingStock must never climb.
//      A rise means a stale cached page was served AFTER a fresher one — the
//      exact defect cache-failure-modes.js only counted as WARN.
//
// All of it runs while READ_VUS readers hammer the same pages, because a
// cache that invalidates correctly on an idle system routinely fails to when
// a rebuild is already in flight for the version being replaced.

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const PRODUCT_ID = __ENV.PRODUCT_ID || '';       // blank = pick one from the catalogue
const READ_VUS = parseInt(__ENV.READ_VUS || '200', 10);
const ROUNDS = parseInt(__ENV.ROUNDS || '10', 10);
// One order per round, each from a user who has never bought this product —
// otherwise round 2 onwards is a duplicate and nothing moves.
const USER_PREFIX = __ENV.USER_PREFIX || `inval-${Date.now()}`;
// How long a stale read is tolerated. Writes are asynchronous by design
// (spec 2.3), so this budget covers queue + worker + invalidation, not just
// the cache. Raise it for a system with a deliberately long queue; what
// matters for the report is the measured number, not the pass/fail.
const MAX_STALE_MS = parseInt(__ENV.MAX_STALE_MS || '3000', 10);
const POLL_INTERVAL_MS = parseInt(__ENV.POLL_INTERVAL_MS || '50', 10);
// Page sizes to verify. Every one of them has a page containing the product,
// and every one of them is a separate cache key.
const VARIANT_LIMITS = (__ENV.VARIANT_LIMITS || '10,20,50,100').split(',').map((n) => parseInt(n, 10));
const MAX_CRAWL_PAGES = parseInt(__ENV.MAX_CRAWL_PAGES || '50', 10);

const staleness = new Trend('invalidation_stale_ms', true);
const worstVariantGap = new Trend('invalidation_variant_spread_ms', true);
const variantStale = {};

const tooStale = new Counter('FAIL_stale_over_budget');
const neverInvalidated = new Counter('FAIL_never_invalidated');
const wrongDelta = new Counter('FAIL_decrement_not_one');
const wentBackwards = new Counter('FAIL_stock_went_backwards');
const aboveAvailable = new Counter('FAIL_stock_above_available');
const negativeStock = new Counter('FAIL_stock_negative');
const partialInvalidation = new Counter('FAIL_partial_invalidation');
const serverError = new Counter('FAIL_server_error');
const orderRejected = new Counter('INFO_order_not_accepted');
const badGateway = new Counter('INFRA_bad_gateway');
const noConnection = new Counter('INFRA_no_connection');

for (const lim of VARIANT_LIMITS) variantStale[lim] = new Trend(`stale_ms_limit_${lim}`, true);

const seen = {};
function sample(tag, detail) {
  if (seen[tag]) return;
  seen[tag] = true;
  console.error(`[${tag}] ${detail}`);
}

export const options = {
  scenarios: {
    // Constant read pressure for the whole run. Without it the cache is idle
    // between rounds and every rebuild wins its lock uncontended, which is
    // the one condition under which invalidation is easy.
    readers: {
      executor: 'constant-vus',
      vus: READ_VUS,
      duration: __ENV.READ_DUR || '90s',
      exec: 'readerLoop',
      startTime: '0s',
    },
    // One writer, one order at a time, so each measured staleness window
    // belongs to exactly one known write.
    invalidator: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: ROUNDS,
      exec: 'invalidationRound',
      startTime: '3s',
      maxDuration: '120s',
    },
  },
  thresholds: {
    FAIL_never_invalidated: ['count==0'],
    FAIL_decrement_not_one: ['count==0'],
    FAIL_stock_went_backwards: ['count==0'],
    FAIL_stock_above_available: ['count==0'],
    FAIL_stock_negative: ['count==0'],
    FAIL_partial_invalidation: ['count==0'],
    FAIL_server_error: ['count==0'],
    invalidation_stale_ms: [`p(95)<${MAX_STALE_MS}`],
    'http_req_failed{scenario:readers}': ['rate<0.01'],
  },
  setupTimeout: '300s',
};

function classify(res) {
  if (res.status === 0) {
    noConnection.add(1);
    sample('no_connection', `error_code=${res.error_code} ${res.error}`);
    return false;
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    badGateway.add(1);
    sample('bad_gateway', `status=${res.status}`);
    return false;
  }
  if (res.status >= 500) {
    serverError.add(1);
    sample('server_error', `status=${res.status} body=${String(res.body).slice(0, 200)}`);
    return false;
  }
  return res.status === 200;
}

function getPage(page, limit, tag) {
  return http.get(`${BASE_URL}/api/v1/products?page=${page}&limit=${limit}`, {
    tags: { name: tag || 'read' },
  });
}

function parse(res) {
  try {
    const b = res.json();
    return b && Array.isArray(b.data) ? b : null;
  } catch (e) {
    return null;
  }
}

/**
 * Find which page a product sits on for a given page size.
 *
 * Never assume page 1. This project orders by createdAt DESC and seeds
 * p-1001 first, so the flash-sale product lands on the LAST page; another
 * group's ordering is their own business. Locating it per page size is also
 * what makes the partial-invalidation check possible at all.
 */
function locate(productId, limit) {
  for (let page = 1; page <= MAX_CRAWL_PAGES; page++) {
    const res = getPage(page, limit, 'locate');
    if (!classify(res)) return null;
    const body = parse(res);
    if (!body) return null;
    const found = body.data.find((p) => p.productId === productId);
    if (found) return { page, limit, stock: found.remainingStock, available: found.availableStock };
    if (body.meta && page >= body.meta.totalPages) return null;
  }
  return null;
}

/** Read this product's remainingStock through one specific cache key. */
function readVariant(v) {
  const res = getPage(v.page, v.limit, `variant_${v.limit}`);
  if (!classify(res)) return null;
  const body = parse(res);
  if (!body) return null;
  const found = body.data.find((p) => p.productId === v.productId);
  return found ? found.remainingStock : null;
}

export function setup() {
  // ---- pick a product ----------------------------------------------------
  const first = getPage(1, 10, 'setup');
  if (first.status !== 200) {
    throw new Error(`target not answering GET /api/v1/products: ${first.status} ${first.body}`);
  }

  let productId = PRODUCT_ID;
  if (!productId) {
    // Walk the catalogue for something we can actually spend: enough stock
    // for every round, so the run measures invalidation rather than sellout.
    let best = null;
    for (let page = 1; page <= MAX_CRAWL_PAGES; page++) {
      const body = parse(getPage(page, 100, 'setup'));
      if (!body) break;
      for (const p of body.data) {
        if (p.remainingStock > (best ? best.remainingStock : ROUNDS)) best = p;
      }
      if (!body.meta || page >= body.meta.totalPages) break;
    }
    if (!best) {
      throw new Error(`no product with more than ${ROUNDS} units in stock — pass -e PRODUCT_ID= explicitly`);
    }
    productId = best.productId;
  }

  // ---- locate it under every page size -----------------------------------
  const variants = [];
  for (const limit of VARIANT_LIMITS) {
    const v = locate(productId, limit);
    if (!v) {
      console.warn(`could not locate ${productId} at limit=${limit} — skipping that variant`);
      continue;
    }
    variants.push({ ...v, productId });
    console.log(`variant limit=${limit}: page ${v.page}, remainingStock=${v.stock}`);
  }
  if (!variants.length) throw new Error(`could not locate ${productId} on any page size`);

  const startStock = variants[0].stock;
  if (startStock < ROUNDS) {
    console.warn(
      `${productId} has ${startStock} units but ROUNDS=${ROUNDS}; later rounds will hit a sold-out product ` +
        'and be reported as "order not accepted", not as invalidation failures.',
    );
  }

  // ---- one fresh user per round ------------------------------------------
  const tokens = [];
  for (let i = 1; i <= ROUNDS; i++) {
    const userId = `${USER_PREFIX}-${i}`;
    const res = http.post(`${BASE_URL}/api/v1/auth/token`, JSON.stringify({ userId }), {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'auth' },
    });
    if (res.status !== 200) {
      throw new Error(`auth for ${userId}: expected 200 (spec 2.1), got ${res.status} — ${res.body}`);
    }
    tokens.push({ userId, accessToken: res.json('accessToken') });
  }

  console.log(`invalidation target: ${productId}, ${variants.length} cache variant(s), ${ROUNDS} round(s)`);
  return { productId, variants, tokens, startStock };
}

/**
 * Background readers.
 *
 * Each VU keeps its OWN last-seen value. That is the whole trick: comparing
 * against a shared value would be meaningless (k6 VUs do not share state and
 * reads race anyway), but a single VU reading the same key twice in sequence
 * must never see the number go UP — stock only falls. A rise is proof a stale
 * cached page was served after a fresher one.
 */
let lastSeen = null;
export function readerLoop(data) {
  const v = data.variants[__VU % data.variants.length];
  const res = getPage(v.page, v.limit, 'readers');
  if (!classify(res)) return;
  const body = parse(res);
  if (!body) return;
  const p = body.data.find((x) => x.productId === data.productId);
  if (!p) return;

  if (p.remainingStock < 0) {
    negativeStock.add(1);
    sample('negative_stock', `${data.productId} remainingStock=${p.remainingStock}`);
  }
  if (p.remainingStock > p.availableStock) {
    aboveAvailable.add(1);
    sample('above_available', `remainingStock=${p.remainingStock} > availableStock=${p.availableStock}`);
  }
  if (lastSeen !== null && p.remainingStock > lastSeen) {
    wentBackwards.add(1);
    sample(
      'stock_went_backwards',
      `VU ${__VU} on limit=${v.limit} saw ${lastSeen} then ${p.remainingStock} — a stale page was served after a fresher one`,
    );
  }
  lastSeen = p.remainingStock;

  check(res, { 'reader: 200 OK': () => true });
}

export function invalidationRound(data) {
  const round = exec.scenario.iterationInTest;
  const me = data.tokens[round];
  const variants = data.variants;

  // ---- baseline through every cache key ----------------------------------
  const before = {};
  for (const v of variants) before[v.limit] = readVariant({ ...v, productId: data.productId });

  const baselineValues = Object.values(before).filter((x) => x !== null);
  if (!baselineValues.length) {
    sample('baseline_unreadable', `round ${round}: could not read ${data.productId} on any variant`);
    return;
  }
  // If the page sizes disagree BEFORE the write, invalidation is already
  // broken from a previous round and the measurement below is meaningless.
  const disagreeBefore = new Set(baselineValues).size > 1;
  if (disagreeBefore) {
    partialInvalidation.add(1);
    sample(
      'baseline_disagreement',
      `round ${round}: page sizes disagree before the write: ${JSON.stringify(before)}`,
    );
  }
  const baseline = Math.max(...baselineValues);

  // ---- the write ---------------------------------------------------------
  const t0 = Date.now();
  const order = http.post(
    `${BASE_URL}/api/v1/orders`,
    JSON.stringify({ productId: data.productId }),
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${me.accessToken}` },
      // 409 (already yours) and 410 (sold out) are correct answers, not
      // failures — they just mean this round has no write to measure.
      responseCallback: http.expectedStatuses(202, 409, 410),
      tags: { name: 'order' },
    },
  );

  if (order.status !== 202) {
    orderRejected.add(1);
    console.log(`round ${round}: order answered ${order.status}, nothing to measure this round`);
    return;
  }

  // ---- poll every variant until it reflects the write --------------------
  // Round-robin over the unresolved variants rather than draining one at a
  // time, so the recorded time for each is when IT became correct, not when
  // its turn came up.
  const resolvedAt = {};
  const finalValue = {};
  const pending = variants.slice();
  let waited = 0;

  while (pending.length && waited < MAX_STALE_MS * 4) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const v = pending[i];
      const now = readVariant({ ...v, productId: data.productId });
      if (now === null) continue;
      if (now < baseline) {
        resolvedAt[v.limit] = Date.now() - t0;
        finalValue[v.limit] = now;
        pending.splice(i, 1);
      }
    }
    if (!pending.length) break;
    sleep(POLL_INTERVAL_MS / 1000);
    waited = Date.now() - t0;
  }

  // ---- report ------------------------------------------------------------
  for (const v of variants) {
    const ms = resolvedAt[v.limit];
    if (ms === undefined) {
      neverInvalidated.add(1);
      sample(
        `never_invalidated_limit_${v.limit}`,
        `round ${round}: limit=${v.limit} still showed ${baseline} after ${waited}ms — the cache for that key never invalidated`,
      );
      continue;
    }
    variantStale[v.limit].add(ms);
    staleness.add(ms);
    if (ms > MAX_STALE_MS) {
      tooStale.add(1);
      sample(`stale_over_budget_limit_${v.limit}`, `round ${round}: limit=${v.limit} took ${ms}ms (budget ${MAX_STALE_MS}ms)`);
    }
  }

  const times = Object.values(resolvedAt);
  if (times.length > 1) {
    // The spread between page sizes IS the partial-invalidation measurement:
    // one key refreshing instantly while another lags a second means they are
    // not being invalidated together.
    worstVariantGap.add(Math.max(...times) - Math.min(...times));
  }

  // One order must consume exactly one unit. A 2 means a job ran twice; a
  // value that moved without our order means someone else is writing, and the
  // whole measurement should be redone on a quiet system.
  const settled = Object.values(finalValue);
  if (settled.length) {
    const delta = baseline - Math.min(...settled);
    if (delta !== 1) {
      wrongDelta.add(1);
      sample(
        'decrement_not_one',
        `round ${round}: one accepted order moved stock by ${delta} (${baseline} -> ${Math.min(...settled)})`,
      );
    }
    const allAgree = new Set(settled).size === 1 && settled.length === variants.length;
    if (!allAgree) {
      partialInvalidation.add(1);
      sample('variants_disagree_after', `round ${round}: page sizes settled on different values ${JSON.stringify(finalValue)}`);
    }
  }

  check(null, {
    'every page size reflected the write': () => Object.keys(resolvedAt).length === variants.length,
    'one order moved stock by exactly one': () =>
      settled.length > 0 && baseline - Math.min(...settled) === 1,
  });

  console.log(
    `round ${round}: baseline=${baseline} -> ${JSON.stringify(finalValue)} | stale ms per limit ${JSON.stringify(resolvedAt)}`,
  );
}

export function handleSummary(data) {
  const out = __ENV.OUT || 'load-test/results/cache-invalidation.json';
  const m = data.metrics;
  const c = (n) => (m[n] && m[n].values.count !== undefined ? m[n].values.count : 0);
  const t = (n, f) => (m[n] && m[n].values[f] !== undefined ? m[n].values[f].toFixed(1) : 'n/a');

  const lines = ['', '=== cache invalidation (spec 2.2) ==='];
  lines.push(`  staleness  p50=${t('invalidation_stale_ms', 'med')}ms  p95=${t('invalidation_stale_ms', 'p(95)')}ms  max=${t('invalidation_stale_ms', 'max')}ms  (budget ${MAX_STALE_MS}ms)`);
  lines.push(`  spread between page sizes  p95=${t('invalidation_variant_spread_ms', 'p(95)')}ms  max=${t('invalidation_variant_spread_ms', 'max')}ms`);
  for (const lim of VARIANT_LIMITS) {
    const key = `stale_ms_limit_${lim}`;
    if (m[key]) lines.push(`    limit=${String(lim).padEnd(4)} p95=${t(key, 'p(95)')}ms max=${t(key, 'max')}ms`);
  }
  lines.push('');
  const fails = [
    ['a page size never invalidated', 'FAIL_never_invalidated'],
    ['stale beyond the budget', 'FAIL_stale_over_budget'],
    ['one order != one unit', 'FAIL_decrement_not_one'],
    ['stock climbed (stale served after fresh)', 'FAIL_stock_went_backwards'],
    ['remainingStock > availableStock', 'FAIL_stock_above_available'],
    ['remainingStock < 0', 'FAIL_stock_negative'],
    ['page sizes invalidated apart', 'FAIL_partial_invalidation'],
    ['app 5xx', 'FAIL_server_error'],
  ];
  let broken = 0;
  for (const [label, metric] of fails) {
    const n = c(metric);
    // Over-budget staleness is a tuning signal, not a correctness break, so
    // it is printed as WARN and left out of the verdict count.
    const soft = metric === 'FAIL_stale_over_budget';
    if (n > 0 && !soft) broken++;
    lines.push(`  ${n === 0 ? 'PASS' : soft ? 'WARN' : 'FAIL'}  ${label.padEnd(42)} ${n}`);
  }
  lines.push('');
  lines.push(`  rounds with no write to measure: ${c('INFO_order_not_accepted')} (409 already-ordered / 410 sold out)`);
  lines.push(`  rig, not the system: bad_gateway=${c('INFRA_bad_gateway')} no_connection=${c('INFRA_no_connection')}`);
  lines.push(
    broken === 0
      ? '  -> invalidation is correct on every cache key, under concurrent read load'
      : `  -> ${broken} invalidation defect(s); the [tag] lines above name each one once`,
  );
  lines.push('');

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }) + lines.join('\n'),
    [out]: JSON.stringify(data, null, 2),
  };
}
