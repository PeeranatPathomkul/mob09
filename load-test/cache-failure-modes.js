import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

// Every way this project's product cache can fail, in one run, with the
// HIT/MISS/BYPASS breakdown reported per phase instead of as one blended
// number.
//
//   bash load-test/reset.sh          # REQUIRED: phase 1 measures a COLD cache
//   docker compose --profile loadtest run --rm k6 /scripts/cache-failure-modes.js
//
// Run it from inside the compose network. From the Windows host, Docker
// Desktop's port forwarder refuses a large share of connections at these VU
// counts and they surface as failures that belong to the rig, not the cache
// (see the k6 service comment in docker-compose.yml).
//
// Reads X-Cache off every response. That header is the only per-request view
// of cache behaviour: /api/v1/cache/stats reports process-wide totals shared
// by all three API instances and every client, so differencing it around one
// request is only valid when nothing else is running.
//
//   HIT    served from Redis (found on arrival, or after waiting for the rebuilder)
//   MISS   this request held the rebuild lock, queried Postgres, refilled the cache
//   BYPASS read through to Postgres using neither the cache nor the lock

const BASE_URL = __ENV.BASE_URL || 'http://nginx';
const READ_VUS = parseInt(__ENV.READ_VUS || '300', 10);
const WRITE_USERS = parseInt(__ENV.WRITE_USERS || '300', 10);
const PRODUCT_ID = __ENV.PRODUCT_ID || 'p-1001';
const LIMIT = parseInt(__ENV.LIMIT || '10', 10);
const MAX_PAGE = parseInt(__ENV.MAX_PAGE || '2', 10);

// Phase boundaries. Each phase is its own scenario so k6 keeps their metrics
// apart; a single scenario with time-based branching would blend them.
const COLD_DUR = __ENV.COLD_DUR || '5s';
const STEADY_DUR = __ENV.STEADY_DUR || '15s';
const SALE_DUR = __ENV.SALE_DUR || '15s';
const PROBE_DUR = __ENV.PROBE_DUR || '5s';

const PHASES = ['cold', 'steady', 'sale', 'probe'];
const STATUSES = ['hit', 'miss', 'bypass', 'none'];

// One named counter per phase/status rather than a single tagged counter:
// k6 only materialises a tagged submetric that some threshold names, so a
// tagged version would silently report nothing for the combinations we did
// not think to name in advance.
const count = {};
for (const p of PHASES) {
  for (const s of STATUSES) count[`${p}_${s}`] = new Counter(`${p}_${s}`);
}

// Rates, so hit-rate per phase can carry a threshold. A Counter cannot: k6
// thresholds cannot divide one counter by another.
const hitRate = {};
for (const p of PHASES) hitRate[p] = new Rate(`${p}_hit_rate`);

const latency = {};
for (const s of STATUSES) latency[s] = new Trend(`latency_${s}`, true);

// --- failure modes that are not about hit/miss -----------------------------

// A 5xx FROM THE APP means the cache path threw rather than degrading. The
// whole design claims it never does: every Redis error is supposed to fall
// back to Postgres, so any of these is a real defect.
const serverError = new Counter('FAIL_server_error');

// 502/504 is nginx, not the app: it could not get an answer from an upstream.
// Counted apart because the two have completely different causes and the
// distinction was worth 3,938 phantom "app errors" the first time this script
// ran. The usual cause here is nginx holding a stale upstream IP after
// `docker compose up -d --build api1 api2 api3` recreated the containers —
// nginx resolves those names once at startup and caches the result, so it
// keeps dialling addresses that no longer exist. Restart nginx too.
const badGateway = new Counter('INFRA_bad_gateway');
// Never reached the server. Rig problem, reported apart so it cannot be read
// as the system failing.
const noConnection = new Counter('FAIL_no_connection');
// Malformed shape on a 200 — a cached body that did not round-trip.
const badShape = new Counter('FAIL_bad_shape');
// A 200 with no X-Cache header: the controller stopped reporting, and every
// hit-rate number below would be silently meaningless.
const missingHeader = new Counter('FAIL_missing_x_cache');
// Extreme page/limit that should have been clamped to a 200 but 4xx'd.
const probeRejected = new Counter('FAIL_probe_rejected');
// remainingStock for PRODUCT_ID moving UP over the run. See recordStock().
const stockWentBackwards = new Counter('WARN_stock_went_backwards');

const writeAccepted = new Counter('writes_accepted');
const writeDuplicate = new Counter('writes_duplicate');
const writeSoldOut = new Counter('writes_sold_out');
const writeRejected = new Counter('writes_rejected_unexpected');

// 202 queued / 409 already yours / 410 sold out are all correct answers to
// "can I buy this?". Counting 409 and 410 as failures would penalise a system
// for answering honestly and immediately.
const WRITE_EXPECTED = http.expectedStatuses(202, 409, 410);

const SAMPLE_EVERY_NTH_VU = parseInt(__ENV.SAMPLE_EVERY_NTH_VU || '60', 10);
let sampled = false;

export const options = {
  scenarios: {
    // 1) COLD STAMPEDE — everyone arrives at once on an empty cache.
    //    Exercises the SET NX rebuild lock. Healthy: a couple of MISSes (one
    //    per page/limit key) and the rest HIT, because the losers wait for the
    //    winner instead of piling onto Postgres.
    cold: {
      executor: 'constant-vus',
      vus: READ_VUS,
      duration: COLD_DUR,
      startTime: '0s',
      exec: 'readPhase',
      env: { PHASE: 'cold' },
    },

    // 2) STEADY STATE — same load, cache warm, nothing invalidating.
    //    Healthy: hit rate near 1. Anything else means keys are dying for a
    //    reason other than a version bump (TTL too short, evictions, a stray
    //    writer).
    steady: {
      executor: 'constant-vus',
      vus: READ_VUS,
      duration: STEADY_DUR,
      startTime: COLD_DUR,
      exec: 'readPhase',
      env: { PHASE: 'steady' },
    },

    // 3) FLASH SALE — reads while the worker commits orders and bumps the
    //    version. Hit rate is EXPECTED to fall here; that is the design, not a
    //    bug. What matters is that BYPASS stays bounded and no 5xx appears.
    sale: {
      executor: 'constant-vus',
      vus: READ_VUS,
      duration: SALE_DUR,
      startTime: `${parseInt(COLD_DUR) + parseInt(STEADY_DUR)}s`,
      exec: 'readPhase',
      env: { PHASE: 'sale' },
    },
    sale_writes: {
      executor: 'per-vu-iterations',
      vus: WRITE_USERS,
      iterations: 1,
      // A second into the read phase, so the reads are already in flight.
      startTime: `${parseInt(COLD_DUR) + parseInt(STEADY_DUR) + 1}s`,
      maxDuration: '60s',
      exec: 'writePhase',
    },

    // 4) PENETRATION — absurd page/limit values, the shape that used to
    //    create an unbounded key space (every value a guaranteed miss on a key
    //    nobody shares). With clamping they must collapse onto a handful of
    //    keys and start HITting.
    probe: {
      executor: 'constant-vus',
      vus: 50,
      duration: PROBE_DUR,
      startTime: `${parseInt(COLD_DUR) + parseInt(STEADY_DUR) + parseInt(SALE_DUR)}s`,
      exec: 'probePhase',
      env: { PHASE: 'probe' },
    },
  },

  thresholds: {
    // Non-negotiable: the cache path must never throw, whatever happens to
    // Redis. Its entire failure story is "fall back to Postgres".
    FAIL_server_error: ['count==0'],
    FAIL_bad_shape: ['count==0'],
    // If this fires, every hit-rate figure in the report is meaningless.
    FAIL_missing_x_cache: ['count==0'],
    // Clamping must turn extreme input into a 200, not a 4xx.
    FAIL_probe_rejected: ['count==0'],

    // A warm cache with nothing invalidating it should serve almost everything
    // from Redis. This is the number that says the cache works at all.
    steady_hit_rate: ['rate>0.95'],

    // Deliberately loose. During a sale the version moves constantly, so a low
    // hit rate is correct behaviour — this only catches the cache dropping out
    // completely, which would mean invalidation is firing when it should not.
    sale_hit_rate: ['rate>0.10'],

    'http_req_duration{scenario:steady}': ['p(95)<500'],
    'http_req_failed{scenario:steady}': ['rate<0.01'],
  },
};

export function setup() {
  const tokens = [];
  for (let i = 1; i <= WRITE_USERS; i++) {
    const userId = `user-${i}`;
    const res = http.post(
      `${BASE_URL}/api/v1/auth/token`,
      JSON.stringify({ userId }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    if (res.status !== 200) {
      throw new Error(`auth for ${userId}: expected 200 (spec 2.1), got ${res.status} — ${res.body}`);
    }
    tokens.push({ userId, accessToken: res.json('accessToken') });
  }
  console.log(
    `phases: cold ${COLD_DUR} -> steady ${STEADY_DUR} -> sale ${SALE_DUR} -> probe ${PROBE_DUR} · ` +
      `${READ_VUS} readers · ${tokens.length} writers`,
  );
  return { tokens };
}

/**
 * Classify one read by its X-Cache header.
 *
 * The header is read case-insensitively because k6 normalises header names
 * but proxies in between may not, and a lookup miss here would quietly
 * reclassify every response as 'none'.
 */
function recordRead(phase, res) {
  latencyFor(res);

  if (res.status === 0) {
    noConnection.add(1);
    count[`${phase}_none`].add(1);
    hitRate[phase].add(false);
    return null;
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    badGateway.add(1);
    sample(phase, res);
    count[`${phase}_none`].add(1);
    hitRate[phase].add(false);
    return null;
  }
  if (res.status >= 500) {
    serverError.add(1);
    sample(phase, res);
    count[`${phase}_none`].add(1);
    hitRate[phase].add(false);
    return null;
  }
  if (res.status !== 200) {
    count[`${phase}_none`].add(1);
    hitRate[phase].add(false);
    return res.status;
  }

  const header = res.headers['X-Cache'] || res.headers['x-cache'];
  if (!header) {
    missingHeader.add(1);
    sample(phase, res);
    count[`${phase}_none`].add(1);
    hitRate[phase].add(false);
    return 200;
  }

  const key = String(header).toLowerCase();
  if (count[`${phase}_${key}`]) count[`${phase}_${key}`].add(1);
  else count[`${phase}_none`].add(1);
  hitRate[phase].add(key === 'hit');
  latency[key] && latency[key].add(res.timings.duration);

  return 200;
}

function latencyFor(res) {
  // Overall per-status latency is filled in recordRead; this only guards the
  // status-0 case, where timings are meaningless.
  if (res.status === 0) return;
}

function sample(phase, res) {
  if (sampled || __VU % SAMPLE_EVERY_NTH_VU !== 0) return;
  sampled = true;
  const body = res.body === null ? '<no response>' : String(res.body).slice(0, 200);
  console.error(
    `[${phase}] unexpected  status=${res.status}  error_code=${res.error_code}  ` +
      `x-cache=${res.headers['X-Cache'] || '-'}  body=${body}`,
  );
}

/** Highest remainingStock seen for PRODUCT_ID, per VU. */
let peakStock = -1;

/**
 * Flag stock appearing to go UP.
 *
 * Stock only ever decreases, so an increase means a response carried a value
 * older than one already served — the signature of a cache that was not
 * invalidated. It is a WARN and not a threshold on purpose: with many VUs in
 * flight, a request issued earlier can legitimately return later carrying a
 * higher value, so a small count here is noise. A large one is not.
 */
function recordStock(body) {
  if (!body || !Array.isArray(body.data)) return;
  const p = body.data.find((x) => x.productId === PRODUCT_ID);
  if (!p || typeof p.remainingStock !== 'number') return;
  if (peakStock >= 0 && p.remainingStock > peakStock) stockWentBackwards.add(1);
  else peakStock = Math.max(peakStock, p.remainingStock);
}

export function readPhase() {
  const phase = __ENV.PHASE;
  const page = ((__ITER + __VU) % MAX_PAGE) + 1;
  const res = http.get(`${BASE_URL}/api/v1/products?page=${page}&limit=${LIMIT}`);

  const status = recordRead(phase, res);
  if (status !== 200) {
    check(res, { [`${phase}: 200 OK`]: () => false });
    return;
  }

  // Body checks only after the status check: a request that never connected
  // has a null body and r.json() on it throws a GoError per call.
  const body = res.json();
  const ok =
    body && body.status === 'success' && Array.isArray(body.data) && body.meta !== undefined;
  if (!ok) badShape.add(1);
  check(res, { [`${phase}: 200 OK`]: () => true, [`${phase}: shape ok`]: () => ok });

  recordStock(body);
}

/**
 * Extreme and malformed page/limit.
 *
 * Numbers out of range must clamp to a 200 (they are answerable); genuinely
 * unparseable input must still 400, which is why those two are asserted
 * differently rather than lumped into "does not 500".
 */
export function probePhase() {
  const clampable = [
    `page=${1 + Math.floor(Math.random() * 10_000_000)}&limit=10`,
    `page=1&limit=${1 + Math.floor(Math.random() * 100_000)}`,
    'page=999999999&limit=999999999',
    'page=1&limit=15',
    'page=1&limit=3',
  ];
  const rejectable = ['page=0&limit=10', 'page=-5&limit=10', 'page=abc&limit=10', 'page=1&limit=0'];

  const q = clampable[__ITER % clampable.length];
  const res = http.get(`${BASE_URL}/api/v1/products?${q}`);
  const status = recordRead('probe', res);
  if (status !== null && status !== 200) {
    probeRejected.add(1);
    sample('probe', res);
  }
  check(res, { [`probe: extreme input clamps to 200`]: () => res.status === 200 });

  const bad = rejectable[__ITER % rejectable.length];
  const badRes = http.get(`${BASE_URL}/api/v1/products?${bad}`, {
    responseCallback: http.expectedStatuses(400),
  });
  if (badRes.status === 502 || badRes.status === 503 || badRes.status === 504) badGateway.add(1);
  else if (badRes.status >= 500) serverError.add(1);
  check(badRes, {
    'probe: unparseable input still 400': () => badRes.status === 400,
  });
}

export function writePhase(data) {
  // NOT __VU: that id is global across the whole test, so with read scenarios
  // also running the writers are numbered above WRITE_USERS and index into
  // tokens incorrectly. iterationInTest is scoped to this scenario.
  const me = data.tokens[exec.scenario.iterationInTest % data.tokens.length];
  if (!me || !me.accessToken) {
    writeRejected.add(1);
    return;
  }

  const res = http.post(
    `${BASE_URL}/api/v1/orders`,
    JSON.stringify({ productId: PRODUCT_ID }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${me.accessToken}`,
      },
      responseCallback: WRITE_EXPECTED,
    },
  );

  if (res.status === 202) writeAccepted.add(1);
  else if (res.status === 409) writeDuplicate.add(1);
  else if (res.status === 410) writeSoldOut.add(1);
  else {
    writeRejected.add(1);
    if (res.status === 502 || res.status === 503 || res.status === 504) badGateway.add(1);
    else if (res.status >= 500) serverError.add(1);
  }
}

export function handleSummary(data) {
  const out = __ENV.OUT || 'load-test/results/cache-failure-modes.json';
  const m = data.metrics;
  const g = (name, field = 'count') =>
    m[name] && m[name].values[field] !== undefined ? m[name].values[field] : 0;
  const pct = (v) => `${(v * 100).toFixed(1)}%`;

  const row = (label, phase) => {
    const h = g(`${phase}_hit`);
    const mi = g(`${phase}_miss`);
    const b = g(`${phase}_bypass`);
    const n = g(`${phase}_none`);
    const tot = h + mi + b + n;
    const rate = tot > 0 ? h / tot : 0;
    return (
      `    ${label.padEnd(22)} ` +
      `${String(h).padStart(7)} ${String(mi).padStart(6)} ${String(b).padStart(7)} ` +
      `${String(n).padStart(6)} ${String(tot).padStart(8)}   ${pct(rate).padStart(6)}`
    );
  };

  const report = [
    '',
    '  CACHE BEHAVIOUR BY PHASE   (from the X-Cache header, per request)',
    '',
    '    phase                      HIT   MISS  BYPASS   other    total   hit-rate',
    '    ' + '-'.repeat(72),
    row('1 cold stampede', 'cold'),
    row('2 steady state', 'steady'),
    row('3 flash sale', 'sale'),
    row('4 penetration probe', 'probe'),
    '',
    '    How to read this:',
    '      cold    a few MISSes and the rest HIT means the rebuild lock is',
    '              collapsing the herd. MISS ~= total means it is not.',
    '      steady  should be ~100% HIT. Anything else means keys are dying',
    '              for a reason other than a version bump.',
    '      sale    a LOW hit rate here is correct — every committed order',
    '              bumps the version by design. BYPASS is the tell: it counts',
    '              readers whose version moved while they waited.',
    '      probe   extreme page/limit must clamp onto a few shared keys and',
    '              start HITting. Sustained MISS means the key space is still',
    '              unbounded (cache penetration).',
    '',
    `    latency  HIT p95 ${g('latency_hit', 'p(95)').toFixed(1)} ms` +
      `   MISS p95 ${g('latency_miss', 'p(95)').toFixed(1)} ms` +
      `   BYPASS p95 ${g('latency_bypass', 'p(95)').toFixed(1)} ms`,
    '',
    '  FAILURE MODES   (every line below should be 0)',
    `    5xx from the app         ${g('FAIL_server_error')}   cache path threw instead of falling back to Postgres`,
    `    malformed 200 body       ${g('FAIL_bad_shape')}   a cached body did not round-trip`,
    `    missing X-Cache header   ${g('FAIL_missing_x_cache')}   if >0, every hit-rate above is meaningless`,
    `    extreme input rejected   ${g('FAIL_probe_rejected')}   clamping should have made these 200`,
    '',
    `    stock appeared to rise   ${g('WARN_stock_went_backwards')}   WARN, not a failure — a few are races between`,
    '                                 concurrent VUs; many mean stale reads survived',
    '                                 a version bump',
    `    no connection            ${g('FAIL_no_connection')}   rig/network, NOT the system (run inside the compose network)`,
    `    502/504 from nginx       ${g('INFRA_bad_gateway')}   nginx could not reach an upstream — NOT the cache.`,
    '                                 Usually a stale upstream IP: nginx resolves api1/2/3',
    '                                 once at startup, so restart nginx after rebuilding them.',
    '',
    '  WRITES DURING PHASE 3   (202/409/410 are all correct answers)',
    `    accepted (202)           ${g('writes_accepted')}`,
    `    duplicate (409)          ${g('writes_duplicate')}`,
    `    sold out (410)           ${g('writes_sold_out')}`,
    `    unexpected               ${g('writes_rejected_unexpected')}`,
    '',
    '    202 counts jobs queued, not units sold — confirm the real outcome',
    '    with load-test/verify.sql',
    '',
  ].join('\n');

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }) + '\n' + report,
    [out]: JSON.stringify(data, null, 2),
  };
}
