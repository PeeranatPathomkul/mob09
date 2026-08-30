import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import exec from 'k6/execution';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

// Read load and write load at the same time — the shape a real flash sale
// actually has, and the one thing the separate scripts can never show.
//
// Running them apart hides how they interact. Measured on this project: POST
// /orders answers in ~14ms on its own, but sits at p95 ≈ 29s once 1,000
// readers are competing for the same three API instances. Neither
// orders-500.js nor products-read.js can surface that, because each only ever
// runs alone.
//
//   docker compose --profile loadtest run --rm k6 /scripts/moo_ja_test.js
//   docker compose --profile loadtest run --rm -e BASE_URL=http://10.0.0.5:8080 k6 /scripts/moo_ja_test.js
//
// Run it from inside the compose network. 1,500 VUs opening connections
// through Docker Desktop's Windows port forwarder gets a large share refused
// before they leave the host, which shows up as failures that belong to the
// test rig rather than the system.

const BASE_URL = __ENV.BASE_URL || 'http://nginx';
const USER_COUNT = parseInt(__ENV.USER_COUNT || '500', 10);
const READ_VUS = parseInt(__ENV.READ_VUS || '1000', 10);
const PRODUCT_ID = __ENV.PRODUCT_ID || 'p-1001';
const DUPLICATE_USER_COUNT = parseInt(__ENV.DUPLICATE_USER_COUNT || '20', 10);
const DUPLICATE_REQUESTS = parseInt(__ENV.DUPLICATE_REQUESTS || '3', 10);
const LIMIT = parseInt(__ENV.LIMIT || '10', 10);
const MAX_PAGE = parseInt(__ENV.MAX_PAGE || '2', 10);
const READ_DURATION = __ENV.READ_DURATION || '30s';
const STRICT_AUTH = (__ENV.STRICT_AUTH || 'true') !== 'false';

// The readers get a head start so the cache is warm before the sale opens.
// Firing both from a cold cache would measure a cache stampede rather than
// the steady-state contention this script exists to look at.
const WRITE_START = __ENV.WRITE_START || '5s';

// A flash sale has three correct answers to "can I buy this?", and only one
// of them is a 2xx: queued (202), you already have one (409), and they're
// gone (410). Counting the last two as failures penalises a system that
// answers the user immediately and honestly — a run against another group
// scored 90.74% "failed writes" when it had in fact sold exactly its 50
// units and told the other 454 buyers so on the spot.
const WRITE_EXPECTED = http.expectedStatuses(202, 409, 410);

const accepted = new Counter('orders_accepted');
// 409 and 429 are counted apart on purpose. Lumping them reads a rate limiter
// as a working duplicate guard: a run against another group's system reported
// "88 duplicates blocked" when only 40 duplicate clicks were ever fired, and
// the extra 48 were 429s from their rate limiter.
const rejectedDuplicate = new Counter('orders_rejected_duplicate');
const soldOut = new Counter('orders_sold_out');
const rateLimited = new Counter('orders_rate_limited');
const unauthorized = new Counter('orders_rejected_auth');
const badRequest = new Counter('orders_rejected_bad_request');
const serverError = new Counter('orders_server_error');
const failedOther = new Counter('orders_failed_other');
const readShapeOk = new Rate('read_shape_ok');

// A failed read is not one thing, and the difference is the whole diagnosis.
// status 0 means the request never reached the server at all — a rig or
// network problem, not a system one. 502/504 means nginx reached the app and
// gave up on it. 5xx means the app itself threw. Reporting them as a single
// "64% failed" hides which of the three actually happened: a run through the
// published port instead of the compose network scored 64.2% failed reads,
// and no line of the summary said whether the server had even seen them.
const readNoConnection = new Counter('reads_no_connection');
const readBadGateway = new Counter('reads_bad_gateway');
const readUnavailable = new Counter('reads_unavailable');
const readRateLimited = new Counter('reads_rate_limited');
const readServerError = new Counter('reads_server_error');
const readFailedOther = new Counter('reads_failed_other');

// "other failures: 452" is not a diagnosis. Each VU prints at most one
// unexpected response so the status and body reach the console without 500
// VUs flooding it.
const SAMPLE_BODY_CHARS = 200;
let sampledThisVu = false;

// The write sampler can afford one line per VU; 1,000 readers cannot. Only
// every Nth reader is allowed to speak, which keeps the sample around ten
// lines while still covering every distinct failure mode in play.
const READ_SAMPLE_EVERY_NTH_VU = parseInt(__ENV.READ_SAMPLE_EVERY_NTH_VU || '100', 10);
let sampledReadThisVu = false;

function classifyRead(res) {
  if (res.status === 200) return true;

  if (res.status === 0) readNoConnection.add(1);
  else if (res.status === 502 || res.status === 504) readBadGateway.add(1);
  else if (res.status === 503) readUnavailable.add(1);
  else if (res.status === 429) readRateLimited.add(1);
  else if (res.status >= 500) readServerError.add(1);
  else readFailedOther.add(1);

  if (!sampledReadThisVu && __VU % READ_SAMPLE_EVERY_NTH_VU === 0) {
    sampledReadThisVu = true;
    // error_code is the part that matters on a status 0 — it separates
    // "connection refused" from "reset by peer" from "i/o timeout", which
    // is the difference between a full accept queue, a dying upstream, and
    // a NAT table that ran out of room.
    const body = res.body === null ? '<no response>' : String(res.body).slice(0, SAMPLE_BODY_CHARS);
    console.error(
      `read failed  status=${res.status}  error_code=${res.error_code}  ` +
        `error=${res.error || '-'}  body=${body}`,
    );
  }
  return false;
}

function classifyWrite(res, userId, attempt) {
  if (res.status === 202) { accepted.add(1); return true; }
  if (res.status === 409) { rejectedDuplicate.add(1); return true; }
  if (res.status === 410) { soldOut.add(1); return true; }

  if (res.status === 429) rateLimited.add(1);
  else if (res.status === 401 || res.status === 403) unauthorized.add(1);
  else if (res.status === 400 || res.status === 404 || res.status === 422) badRequest.add(1);
  else if (res.status >= 500) serverError.add(1);
  else failedOther.add(1);

  if (!sampledThisVu) {
    sampledThisVu = true;
    const body = res.body === null ? '<no response>' : String(res.body).slice(0, SAMPLE_BODY_CHARS);
    console.error(`write rejected ${res.status} (${userId} attempt ${attempt}): ${body}`);
  }
  return false;
}

export const options = {
  scenarios: {
    read_load: {
      executor: 'constant-vus',
      vus: READ_VUS,
      duration: READ_DURATION,
      exec: 'readLoad',
    },
    write_load: {
      executor: 'per-vu-iterations',
      vus: USER_COUNT,
      iterations: 1,
      startTime: WRITE_START,
      maxDuration: '60s',
      exec: 'writeLoad',
    },
  },
  // Judged per scenario on purpose. A single global threshold would let the
  // 100k fast reads bury the write latency this test is designed to expose.
  thresholds: {
    'http_req_failed{scenario:read_load}': ['rate<0.01'],
    'http_req_duration{scenario:read_load}': ['p(95)<500'],
    // Not a judgement — the condition is always true. k6 only materialises a
    // submetric that some threshold names, and without this one the summary
    // can only report the p95 across ALL reads. That number drops when reads
    // start failing, because a connection refused in 30ms is faster than any
    // real answer: 64% failures reported p95 352ms while the reads that
    // actually returned a page were sitting at 746ms.
    'http_req_duration{scenario:read_load,expected_response:true}': ['p(95)>=0'],
    'http_req_failed{scenario:write_load}': ['rate<0.01'],
    'http_req_duration{scenario:write_load}': ['p(95)<2000'],
  },
};

// Runs once for both scenarios.
export function setup() {
  const tokens = [];
  let warned = false;

  for (let i = 1; i <= USER_COUNT; i++) {
    const userId = `user-${i}`;
    const res = http.post(
      `${BASE_URL}/api/v1/auth/token`,
      JSON.stringify({ userId }),
      { headers: { 'Content-Type': 'application/json' } },
    );

    if (res.status !== 200) {
      const detail = `auth for ${userId}: expected 200 (spec 2.1), got ${res.status}`;
      if (STRICT_AUTH) {
        throw new Error(
          `${detail} — ${res.body}\n` +
            `  This system does not follow spec 2.1. To test it anyway: -e STRICT_AUTH=false`,
        );
      }
      if (res.status < 200 || res.status >= 300) throw new Error(`${detail} — ${res.body}`);
      if (!warned) {
        console.warn(`SPEC DEVIATION — ${detail}. Continuing because STRICT_AUTH=false.`);
        warned = true;
      }
    }
    tokens.push({ userId, accessToken: res.json('accessToken') });
  }

  console.log(`prepared ${tokens.length} tokens · readers ${READ_VUS} · writers ${USER_COUNT}`);
  return { tokens };
}

// ---------------------------------------------------------------- read
export function readLoad() {
  const page = ((__ITER + __VU) % MAX_PAGE) + 1;
  const res = http.get(`${BASE_URL}/api/v1/products?page=${page}&limit=${LIMIT}`);

  // Body checks only after the status check — a request that never connected
  // has a null body, and r.json() on it throws a GoError per call.
  if (!classifyRead(res)) {
    check(res, { 'read: status 200': () => false });
    readShapeOk.add(false);
    return;
  }
  const ok = check(res, {
    'read: status 200': () => true,
    'read: status success': (r) => r.json('status') === 'success',
    'read: data is array': (r) => Array.isArray(r.json('data')),
    'read: meta.totalPages': (r) => r.json('meta.totalPages') !== undefined,
  });
  readShapeOk.add(ok);
}

// ---------------------------------------------------------------- write
export function writeLoad(data) {
  // NOT __VU. That id is global across the whole test, so with a read
  // scenario also running the writers are numbered 1001-1500 — every
  // "is this one of the first N users" test silently reads false and the
  // duplicate burst never fires. iterationInTest is scoped to this scenario,
  // so it runs 0-499 no matter what else is in flight.
  const idx = exec.scenario.iterationInTest;
  const me = data.tokens[idx % data.tokens.length];
  if (!me || !me.accessToken) {
    failedOther.add(1);
    return;
  }

  const params = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${me.accessToken}`,
    },
    // Scoped to the write requests: a 409/410 on a READ would still be a
    // genuine failure, so the reader keeps k6's default 2xx/3xx rule.
    responseCallback: WRITE_EXPECTED,
  };
  const body = JSON.stringify({ productId: PRODUCT_ID });

  // http.batch dispatches these together, which is what makes them a real
  // double-click rather than three sequential requests.
  const shots = idx < DUPLICATE_USER_COUNT ? DUPLICATE_REQUESTS : 1;
  const responses =
    shots > 1
      ? http.batch(
          Array.from({ length: shots }, () => ({
            method: 'POST',
            url: `${BASE_URL}/api/v1/orders`,
            body,
            params,
          })),
        )
      : [http.post(`${BASE_URL}/api/v1/orders`, body, params)];

  responses.forEach((res, i) => {
    // 202 (queued) and 409 (duplicate refused) are both correct answers; a
    // 429 is not — it means the system shed our load rather than handling it.
    const ok = classifyWrite(res, me.userId, i + 1);
    check(res, {
      [`write: ${me.userId} attempt ${i + 1} accepted or duplicate-rejected`]: () => ok,
    });
  });

  sleep(1);
}

export function handleSummary(data) {
  const out = __ENV.OUT || 'load-test/results/moo_ja_test.json';
  const m = data.metrics;
  const g = (name, field) => (m[name] && m[name].values[field] !== undefined ? m[name].values[field] : 0);
  const n = (v, d = 1) => Number(v).toFixed(d);

  const readP95 = g('http_req_duration{scenario:read_load}', 'p(95)');
  const readAnsweredP95 = g(
    'http_req_duration{scenario:read_load,expected_response:true}',
    'p(95)',
  );
  const writeP95 = g('http_req_duration{scenario:write_load}', 'p(95)');

  // The headline of this test is the gap between the two, so state it rather
  // than leaving the reader to find two rows in the metric dump.
  const ratio = readP95 > 0 ? writeP95 / readP95 : 0;

  const report = [
    '',
    '  READ vs WRITE UNDER COMBINED LOAD',
    `    readers            ${READ_VUS} VUs for ${READ_DURATION}`,
    `    writers            ${USER_COUNT} VUs, starting at +${WRITE_START}`,
    '',
    `    GET  /products     p95 ${n(readP95)} ms   (all reads)`,
    `    GET  /products     p95 ${n(readAnsweredP95)} ms   (reads that answered)`,
    `    POST /orders       p95 ${n(writeP95)} ms`,
    `    write is           ${n(ratio)}x the read latency`,
    '',
    '    reads that failed — read the counts before the latency above: a',
    '    refused connection is faster than any real answer, so failures pull',
    '    the all-reads p95 down rather than up:',
    `      no connection    ${g('reads_no_connection', 'count')}   (status 0 — never reached the server)`,
    `      bad gateway      ${g('reads_bad_gateway', 'count')}   (502/504 — nginx could not get an answer)`,
    `      unavailable      ${g('reads_unavailable', 'count')}   (503)`,
    `      rate limited     ${g('reads_rate_limited', 'count')}   (429)`,
    `      server error     ${g('reads_server_error', 'count')}   (5xx from the app)`,
    `      other            ${g('reads_failed_other', 'count')}`,
    '',
    '    answered correctly — 202/409/410 are all legitimate replies:',
    `      accepted         ${g('orders_accepted', 'count')}   (202)`,
    `      duplicate user   ${g('orders_rejected_duplicate', 'count')}   (409)`,
    `      sold out         ${g('orders_sold_out', 'count')}   (410)`,
    '',
    '    rejected — every line below is the system failing, not passing:',
    `      rate limited     ${g('orders_rate_limited', 'count')}   (429)`,
    `      auth refused     ${g('orders_rejected_auth', 'count')}   (401/403)`,
    `      bad request      ${g('orders_rejected_bad_request', 'count')}   (400/404/422)`,
    `      server error     ${g('orders_server_error', 'count')}   (5xx)`,
    `      unclassified     ${g('orders_failed_other', 'count')}`,
    '',
    '    202 counts jobs queued, not units sold — confirm the real outcome',
    '    in the database with load-test/verify.sql',
    '',
  ].join('\n');

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }) + '\n' + report,
    [out]: JSON.stringify(data, null, 2),
  };
}
