import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

// Gap group 5 — CONCURRENCY & BUSINESS RULES (spec 2.3).
//
//   bash load-test/reset.sh
//   k6 run -e BASE_URL=http://localhost:8080 load-test/order-concurrency.js
//   docker compose --profile loadtest run --rm \
//     -e BASE_URL=http://172.30.58.13:8080 k6 /scripts/order-concurrency.js
//
// orders-duplicate-lock.js proves ONE thing: N clicks in the same instant
// collapse into one job. Everything else spec 2.3 demands was either untested
// or only verifiable through our own Postgres — useless against another
// group's system. This script proves the rest from the outside, using
// remainingStock as the only instrument, so it runs unchanged anywhere:
//
//   A  BURST DUPLICATE      N simultaneous clicks -> one unit, not N
//   B  TWO PRODUCTS AT ONCE the same user buying two different products
//                           concurrently must succeed twice: a lock keyed on
//                           the user alone (not user+product) passes A and
//                           fails here
//   C  QUANTITY IS IGNORED  sending quantity: 5 must still cost 1 unit
//                           (spec 2.3: "ไม่ต้องส่ง quantity") — a server that
//                           trusts the field lets one caller drain the sale
//   D  DELAYED DUPLICATE    the same user ordering again AFTER the entry lock
//                           has expired must still get only one unit. This is
//                           the case the Redis lock cannot catch and only a
//                           DB unique constraint can, and nothing tested it.
//   E  RUSH                 RUSH_USERS at once on a limited product: stock
//                           must never go below 0 and never sell more than it
//                           had, and POST must stay fast while the queue is
//                           deep (spec 2.3 forbids a synchronous DB update in
//                           the controller — measured as the gap between POST
//                           latency and how long the stock actually took to
//                           settle).
//
// TWO CORRECT CONTRACTS FOR A DUPLICATE. Ours answers 202 with the SAME
// orderJobId (idempotent replay); another group may answer 409. Both keep the
// promise. What neither may do is hand out two different accepted jobs, or
// take two units. So the assertions are on UNITS CONSUMED, with the status
// codes reported rather than judged.

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const RUSH_PRODUCT = __ENV.PRODUCT_ID || 'p-1001';
const RUSH_USERS = parseInt(__ENV.RUSH_USERS || '200', 10);
const BURST = parseInt(__ENV.BURST || '5', 10);
// Must exceed the target's entry-lock TTL or phase D measures nothing. Ours
// is 30s (LOCK_TTL_SECONDS in orders.service.ts); 35 leaves a margin.
const DELAY_SEC = parseInt(__ENV.DELAY_SEC || '35', 10);
const USER_PREFIX = __ENV.USER_PREFIX || `conc-${Date.now()}`;
// How long to wait for an asynchronous write to show up in GET before calling
// it lost. Generous: this is a settling budget, not an SLA.
const SETTLE_MS = parseInt(__ENV.SETTLE_MS || '15000', 10);
// Stock must stay unchanged this long before it counts as settled — a value
// read mid-drain is not a final answer.
const QUIET_MS = parseInt(__ENV.QUIET_MS || '2000', 10);
const POLL_MS = parseInt(__ENV.POLL_MS || '100', 10);
const MAX_CRAWL_PAGES = parseInt(__ENV.MAX_CRAWL_PAGES || '50', 10);
// POST /orders must answer from the queue, not from the database.
const ASYNC_MAX_MS = parseInt(__ENV.ASYNC_MAX_MS || '2000', 10);
// The probe phases run first, quietly, so their unit-accounting is exact.
const RUSH_START = __ENV.RUSH_START || `${DELAY_SEC + 45}s`;

// --- business-rule failures ------------------------------------------------
const burstOversold = new Counter('FAIL_burst_took_more_than_one');
const lockTooBroad = new Counter('FAIL_lock_blocks_other_product');
const quantityHonoured = new Counter('FAIL_quantity_field_honoured');
const delayedDuplicate = new Counter('FAIL_delayed_duplicate_accepted');
const oversold = new Counter('FAIL_oversold');
const negativeStock = new Counter('FAIL_stock_negative');
const lostWrite = new Counter('FAIL_write_lost');          // 202 accepted, stock never moved
const twoJobIds = new Counter('FAIL_two_accepted_job_ids'); // duplicates got separate accepted jobs
const notAsync = new Counter('FAIL_post_not_async');
const serverError = new Counter('FAIL_server_error');
const badGateway = new Counter('INFRA_bad_gateway');
const noConnection = new Counter('INFRA_no_connection');

// --- reported, not judged --------------------------------------------------
const dupAccepted = new Counter('INFO_duplicate_answered_202');
const dupRefused = new Counter('INFO_duplicate_answered_409');
const dupRateLimited = new Counter('INFO_duplicate_answered_429');
const soldOut = new Counter('INFO_sold_out_410');
const rushAccepted = new Counter('rush_accepted_202');

const postLatency = new Trend('order_post_ms', true);
const settleTime = new Trend('rush_settle_ms', true);

const seen = {};
function sample(tag, detail) {
  if (seen[tag]) return;
  seen[tag] = true;
  console.error(`[${tag}] ${detail}`);
}

export const options = {
  scenarios: {
    probes: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      exec: 'probePhases',
      startTime: '0s',
      maxDuration: `${DELAY_SEC + 120}s`,
    },
    rush: {
      executor: 'per-vu-iterations',
      vus: RUSH_USERS,
      iterations: 1,
      exec: 'rushPhase',
      startTime: RUSH_START,
      maxDuration: '60s',
    },
  },
  thresholds: {
    FAIL_burst_took_more_than_one: ['count==0'],
    FAIL_lock_blocks_other_product: ['count==0'],
    FAIL_quantity_field_honoured: ['count==0'],
    FAIL_delayed_duplicate_accepted: ['count==0'],
    FAIL_oversold: ['count==0'],
    FAIL_stock_negative: ['count==0'],
    FAIL_write_lost: ['count==0'],
    FAIL_two_accepted_job_ids: ['count==0'],
    FAIL_server_error: ['count==0'],
    'order_post_ms{scenario:rush}': [`p(95)<${ASYNC_MAX_MS}`],
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
  return true;
}

function parse(res) {
  try {
    const b = res.json();
    return b && Array.isArray(b.data) ? b : null;
  } catch (e) {
    return null;
  }
}

function token(userId) {
  const res = http.post(`${BASE_URL}/api/v1/auth/token`, JSON.stringify({ userId }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'auth' },
  });
  if (res.status !== 200) {
    throw new Error(`auth for ${userId}: expected 200 (spec 2.1), got ${res.status} — ${res.body}`);
  }
  return res.json('accessToken');
}

/** Read a product's remainingStock, walking pages because it may not be on page 1. */
function stockOf(productId, tag) {
  for (let page = 1; page <= MAX_CRAWL_PAGES; page++) {
    const res = http.get(`${BASE_URL}/api/v1/products?page=${page}&limit=100`, {
      tags: { name: tag || 'stock' },
    });
    if (!classify(res) || res.status !== 200) return null;
    const body = parse(res);
    if (!body) return null;
    const found = body.data.find((p) => p.productId === productId);
    if (found) {
      if (found.remainingStock < 0) {
        negativeStock.add(1);
        sample('negative_stock', `${productId} remainingStock=${found.remainingStock}`);
      }
      return found.remainingStock;
    }
    if (body.meta && page >= body.meta.totalPages) return null;
  }
  return null;
}

/**
 * Wait until a product's stock stops moving, and report where it landed.
 *
 * Reading once after an order would measure the queue, not the rule under
 * test: a value that is still draining looks like "only one unit taken" for a
 * moment even when three are on their way. Requiring QUIET_MS of no movement
 * is what makes a unit count trustworthy.
 */
function settle(productId, tag) {
  const t0 = Date.now();
  let last = stockOf(productId, tag);
  let lastChange = Date.now();

  while (Date.now() - t0 < SETTLE_MS) {
    sleep(POLL_MS / 1000);
    const now = stockOf(productId, tag);
    if (now === null) continue;
    if (now !== last) {
      last = now;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= QUIET_MS) {
      return { stock: last, ms: Date.now() - t0 };
    }
  }
  return { stock: last, ms: Date.now() - t0, timedOut: true };
}

function order(accessToken, productId, extra, tag) {
  const body = Object.assign({ productId }, extra || {});
  const res = http.post(`${BASE_URL}/api/v1/orders`, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    // 409 already-yours and 410 sold-out are correct answers, not failures.
    responseCallback: http.expectedStatuses(202, 400, 409, 410, 429),
    tags: { name: tag || 'order' },
  });
  classify(res);
  postLatency.add(res.timings.duration);
  return res;
}

/** Count the answers to a burst the way the two valid contracts allow. */
function tallyDuplicates(responses) {
  const jobIds = new Set();
  let accepted = 0;
  for (const r of responses) {
    if (r.status === 202) {
      accepted++;
      dupAccepted.add(1);
      try {
        const id = r.json('orderJobId');
        if (id) jobIds.add(String(id));
      } catch (e) {
        // A 202 without a parseable body is a contract break of its own, but
        // pagination-integrity.js is not this script's job — count it as an
        // unknown id so it cannot silently look like a collapse.
        jobIds.add(`unparseable-${Math.random()}`);
      }
    } else if (r.status === 409) dupRefused.add(1);
    else if (r.status === 429) dupRateLimited.add(1);
    else if (r.status === 410) soldOut.add(1);
  }
  return { accepted, jobIds };
}

export function setup() {
  // Pick two spare products for the probe phases, so nothing there competes
  // with the rush product for units.
  const catalogue = [];
  for (let page = 1; page <= MAX_CRAWL_PAGES; page++) {
    const res = http.get(`${BASE_URL}/api/v1/products?page=${page}&limit=100`, { tags: { name: 'setup' } });
    if (res.status !== 200) throw new Error(`target not answering GET /api/v1/products: ${res.status} ${res.body}`);
    const body = parse(res);
    if (!body) throw new Error(`unparseable products response: ${String(res.body).slice(0, 200)}`);
    catalogue.push(...body.data);
    if (!body.meta || page >= body.meta.totalPages) break;
  }

  const spares = catalogue
    .filter((p) => p.productId !== RUSH_PRODUCT && p.remainingStock >= 3)
    .sort((a, b) => b.remainingStock - a.remainingStock);
  if (spares.length < 2) {
    throw new Error('need two products other than the rush product with at least 3 units each for the probe phases');
  }

  const rush = catalogue.find((p) => p.productId === RUSH_PRODUCT);
  if (!rush) {
    throw new Error(`${RUSH_PRODUCT} is not in the catalogue — pass -e PRODUCT_ID= for a product that is`);
  }

  console.log(
    `rush: ${RUSH_PRODUCT} (${rush.remainingStock} units) vs ${RUSH_USERS} users | ` +
      `probes: ${spares[0].productId} (${spares[0].remainingStock}), ${spares[1].productId} (${spares[1].remainingStock})`,
  );

  // One JWT per rush user, prepared outside the VU pool (spec 3.1).
  const tokens = [];
  for (let i = 1; i <= RUSH_USERS; i++) tokens.push(token(`${USER_PREFIX}-rush-${i}`));

  return {
    probeA: spares[0].productId,
    probeB: spares[1].productId,
    rushProduct: RUSH_PRODUCT,
    rushStartStock: rush.remainingStock,
    tokens,
  };
}

export function probePhases(data) {
  // ---- A) burst duplicate ------------------------------------------------
  // http.batch dispatches these together, so they genuinely race. Whatever
  // status codes come back, exactly one unit may leave the shelf.
  const userA = `${USER_PREFIX}-burst`;
  const tokA = token(userA);
  const beforeA = stockOf(data.probeA, 'probe_a');
  const burst = http.batch(
    Array.from({ length: BURST }, () => ({
      method: 'POST',
      url: `${BASE_URL}/api/v1/orders`,
      body: JSON.stringify({ productId: data.probeA }),
      params: {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokA}` },
        responseCallback: http.expectedStatuses(202, 400, 409, 410, 429),
        tags: { name: 'burst' },
      },
    })),
  );
  const tally = tallyDuplicates(burst);
  const afterA = settle(data.probeA, 'probe_a');
  const consumedA = beforeA === null || afterA.stock === null ? null : beforeA - afterA.stock;

  if (tally.jobIds.size > 1) {
    twoJobIds.add(1);
    sample('two_job_ids', `${BURST} clicks produced ${tally.jobIds.size} distinct accepted orderJobIds`);
  }
  if (consumedA !== 1) {
    if (consumedA !== null && consumedA > 1) {
      burstOversold.add(1);
      sample('burst_oversold', `${BURST} simultaneous clicks consumed ${consumedA} units`);
    } else if (consumedA === 0) {
      lostWrite.add(1);
      sample('burst_lost', `${tally.accepted} request(s) answered 202 but stock never moved`);
    }
  }
  check(null, {
    'A: simultaneous duplicate clicks consume exactly one unit': () => consumedA === 1,
  });
  console.log(
    `A burst: ${BURST} clicks -> ${tally.accepted}x202 (${tally.jobIds.size} distinct jobId), ` +
      `stock ${beforeA} -> ${afterA.stock} (consumed ${consumedA}) in ${afterA.ms}ms`,
  );

  // ---- B) two products at once, same user --------------------------------
  // A lock keyed on the user alone passes phase A and fails here: the second
  // product gets swallowed as a "duplicate" of the first, and the user is
  // silently refused a purchase they were entitled to.
  const userB = `${USER_PREFIX}-two-products`;
  const tokB = token(userB);
  const beforeB1 = stockOf(data.probeA, 'probe_b');
  const beforeB2 = stockOf(data.probeB, 'probe_b');
  const both = http.batch([
    {
      method: 'POST',
      url: `${BASE_URL}/api/v1/orders`,
      body: JSON.stringify({ productId: data.probeA }),
      params: {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokB}` },
        responseCallback: http.expectedStatuses(202, 400, 409, 410, 429),
        tags: { name: 'two_products' },
      },
    },
    {
      method: 'POST',
      url: `${BASE_URL}/api/v1/orders`,
      body: JSON.stringify({ productId: data.probeB }),
      params: {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokB}` },
        responseCallback: http.expectedStatuses(202, 400, 409, 410, 429),
        tags: { name: 'two_products' },
      },
    },
  ]);
  const afterB1 = settle(data.probeA, 'probe_b');
  const afterB2 = settle(data.probeB, 'probe_b');
  const gotFirst = beforeB1 !== null && afterB1.stock !== null && beforeB1 - afterB1.stock === 1;
  const gotSecond = beforeB2 !== null && afterB2.stock !== null && beforeB2 - afterB2.stock === 1;
  if (!(gotFirst && gotSecond)) {
    lockTooBroad.add(1);
    sample(
      'lock_too_broad',
      `one user buying two different products got ${gotFirst ? 1 : 0} + ${gotSecond ? 1 : 0} units ` +
        `(statuses ${both.map((r) => r.status).join(',')}) — the entry lock is not scoped to user+product`,
    );
  }
  check(null, { 'B: one user can buy two different products concurrently': () => gotFirst && gotSecond });
  console.log(`B two products: statuses ${both.map((r) => r.status).join(',')} -> units ${gotFirst ? 1 : 0} and ${gotSecond ? 1 : 0}`);

  // ---- C) the quantity field must not be honoured ------------------------
  // Spec 2.3 says the body carries only productId. A server that reads a
  // quantity it was never supposed to accept lets one caller empty the sale
  // in a single request — and it answers 202 while doing it, so nothing but a
  // unit count catches it.
  const userC = `${USER_PREFIX}-quantity`;
  const tokC = token(userC);
  const beforeC = stockOf(data.probeB, 'probe_c');
  const resC = order(tokC, data.probeB, { quantity: 5 }, 'quantity');
  const afterC = settle(data.probeB, 'probe_c');
  const consumedC = beforeC === null || afterC.stock === null ? null : beforeC - afterC.stock;
  // 400 is a perfectly good answer too: rejecting an unexpected field is
  // stricter than ignoring it, and costs zero units either way.
  const quantityIgnored = resC.status === 400 ? consumedC === 0 : consumedC === 1;
  if (!quantityIgnored) {
    if (consumedC !== null && consumedC > 1) {
      quantityHonoured.add(1);
      sample('quantity_honoured', `quantity:5 consumed ${consumedC} units — the field reached the worker`);
    } else if (consumedC === 0 && resC.status === 202) {
      lostWrite.add(1);
      sample('quantity_lost', '202 accepted but stock never moved');
    }
  }
  check(null, { 'C: a quantity field never buys more than one unit': () => quantityIgnored });
  console.log(`C quantity:5 -> ${resC.status}, consumed ${consumedC} unit(s)`);

  // ---- D) delayed duplicate ----------------------------------------------
  // The same user, the same product, but far enough apart that the Redis
  // entry lock has expired. Nothing in the suite covered this: the lock
  // cannot help here, so only a DB unique constraint (spec 2.3.3) stands
  // between the user and a second unit. The API is free to answer 202 —
  // what it must not do is take another unit.
  const userD = `${USER_PREFIX}-delayed`;
  const tokD = token(userD);
  const beforeD = stockOf(data.probeA, 'probe_d');
  const first = order(tokD, data.probeA, null, 'delayed_first');
  const settledFirst = settle(data.probeA, 'probe_d');
  console.log(`D first order -> ${first.status}, waiting ${DELAY_SEC}s for the entry lock to expire...`);
  sleep(DELAY_SEC);
  const second = order(tokD, data.probeA, null, 'delayed_second');
  const settledSecond = settle(data.probeA, 'probe_d');
  const consumedD =
    beforeD === null || settledSecond.stock === null ? null : beforeD - settledSecond.stock;
  if (consumedD !== null && consumedD > 1) {
    delayedDuplicate.add(1);
    sample(
      'delayed_duplicate',
      `the same user got ${consumedD} units of ${data.probeA} by ordering again ${DELAY_SEC}s later ` +
        `(statuses ${first.status} then ${second.status}) — no durable per-user constraint`,
    );
  }
  check(null, { 'D: re-ordering after the lock expires still costs one unit': () => consumedD === 1 });
  console.log(
    `D delayed duplicate: ${first.status} then ${second.status}, stock ${beforeD} -> ` +
      `${settledFirst.stock} -> ${settledSecond.stock} (consumed ${consumedD})`,
  );
}

export function rushPhase(data) {
  // iterationInTest, not __VU: __VU is global across scenarios, so with the
  // probe scenario also running the rush users would index past the token
  // array and reuse each other's identities.
  const idx = exec.scenario.iterationInTest % data.tokens.length;
  const res = order(data.tokens[idx], data.rushProduct, null, 'rush');
  if (res.status === 202) rushAccepted.add(1);
  else if (res.status === 410) soldOut.add(1);
  else if (res.status === 409) dupRefused.add(1);
  else if (res.status === 429) dupRateLimited.add(1);
  check(res, {
    'E: rush request answered 202/409/410/429, never 5xx': () =>
      res.status === 202 || res.status === 409 || res.status === 410 || res.status === 429,
  });
}

export function teardown(data) {
  // ---- E) oversell + async accounting ------------------------------------
  const t0 = Date.now();
  const final = settle(data.rushProduct, 'rush_settle');
  settleTime.add(Date.now() - t0);

  const sold = final.stock === null ? null : data.rushStartStock - final.stock;

  if (final.stock !== null && final.stock < 0) {
    negativeStock.add(1);
    sample('rush_negative', `${data.rushProduct} finished at ${final.stock}`);
  }
  if (sold !== null && sold > data.rushStartStock) {
    oversold.add(1);
    sample('oversold', `${sold} units sold from a shelf that held ${data.rushStartStock}`);
  }

  check(null, {
    'E: stock never went below zero': () => final.stock !== null && final.stock >= 0,
    'E: never sold more units than existed': () => sold !== null && sold <= data.rushStartStock,
  });

  console.log(
    `E rush: ${data.rushStartStock} units, ${RUSH_USERS} users -> sold ${sold}, ` +
      `stock left ${final.stock}, queue settled ${final.timedOut ? `NOT within ${SETTLE_MS}ms` : `in ${final.ms}ms`}`,
  );
  console.log(
    'Async proof (spec 2.3): compare order_post_ms against the settle time above — a controller doing the ' +
      'stock update inline cannot answer in a fraction of the time the drain took.',
  );
}

export function handleSummary(data) {
  const out = __ENV.OUT || 'load-test/results/order-concurrency.json';
  const m = data.metrics;
  const c = (n) => (m[n] && m[n].values.count !== undefined ? m[n].values.count : 0);
  const t = (n, f) => (m[n] && m[n].values[f] !== undefined ? m[n].values[f].toFixed(1) : 'n/a');

  const postP95 = m['order_post_ms'] ? m['order_post_ms'].values['p(95)'] : null;
  const drain = m['rush_settle_ms'] ? m['rush_settle_ms'].values.max : null;
  // A controller that updates the database inline answers on the same clock
  // the drain runs on. One that queues answers on a different one entirely.
  const asyncRatio = postP95 && drain ? (drain / postP95).toFixed(1) : 'n/a';
  if (postP95 !== null && postP95 > ASYNC_MAX_MS) notAsync.add(1);

  const lines = ['', '=== concurrency & business rules (spec 2.3) ==='];
  const rows = [
    ['A  simultaneous duplicates cost one unit', 'FAIL_burst_took_more_than_one'],
    ['A  duplicates share one accepted job', 'FAIL_two_accepted_job_ids'],
    ['B  lock is scoped to user+product', 'FAIL_lock_blocks_other_product'],
    ['C  quantity field cannot buy extra units', 'FAIL_quantity_field_honoured'],
    ['D  duplicate after lock expiry still one unit', 'FAIL_delayed_duplicate_accepted'],
    ['E  never oversold', 'FAIL_oversold'],
    ['E  stock never negative', 'FAIL_stock_negative'],
    ['   accepted write never lost', 'FAIL_write_lost'],
    ['   no app 5xx', 'FAIL_server_error'],
  ];
  let broken = 0;
  for (const [label, metric] of rows) {
    const n = c(metric);
    if (n > 0) broken++;
    lines.push(`  ${n === 0 ? 'PASS' : 'FAIL'}  ${label.padEnd(44)} ${n}`);
  }
  lines.push('');
  lines.push(`  POST /orders  p50=${t('order_post_ms', 'med')}ms  p95=${t('order_post_ms', 'p(95)')}ms  max=${t('order_post_ms', 'max')}ms`);
  lines.push(`  queue drain   ${t('rush_settle_ms', 'max')}ms  ->  drain is ${asyncRatio}x the POST p95 (higher = more clearly asynchronous)`);
  lines.push(`  rush answers: 202=${c('rush_accepted_202')} 409=${c('INFO_duplicate_answered_409')} 410=${c('INFO_sold_out_410')} 429=${c('INFO_duplicate_answered_429')}`);
  lines.push(`  duplicate contract observed: ${c('INFO_duplicate_answered_202')}x 202-replay, ${c('INFO_duplicate_answered_409')}x 409-refused (both valid)`);
  lines.push(`  rig, not the system: bad_gateway=${c('INFRA_bad_gateway')} no_connection=${c('INFRA_no_connection')}`);
  lines.push(
    broken === 0
      ? '  -> every business rule in spec 2.3 held under concurrency'
      : `  -> ${broken} rule break(s); the [tag] lines above name each one once`,
  );
  lines.push('');

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }) + lines.join('\n'),
    [out]: JSON.stringify(data, null, 2),
  };
}
