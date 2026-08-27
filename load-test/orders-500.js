import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import exec from 'k6/execution';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

// Section 3 write load: 500 unique users race for p-1001 (50 units).
// A slice of them double/triple-click to exercise the duplicate guard.
//
//   k6 run -e BASE_URL=http://localhost:8080 load-test/orders-500.js
//
// RAMP controls how quickly the 500 virtual users come online.
//
// Opening all 500 TCP connections in the same instant does not fail on the
// server — the same load driven from inside the docker network completes
// 540/540 — but from a Windows host it does: Docker Desktop's localhost port
// forwarder refuses the burst and k6 reports "connectex: No connection could
// be made". That is a measurement artifact, not a system limit.
//
// Every ramp weakens the test, so this is a fallback, not the default.
// Measured on this machine:
//
//   RAMP    failed    accepted    req/s   in-flight (Little's law)
//   0s      24.61%    284/540     314     ~36   <- default, matches the spec
//   1s       0.00%    540/540     215      ~6
//   2s       0.00%    540/540     177      ~4
//   3s       0.00%    540/540     151      ~3
//   5s       0.00%    540/540      61      ~1   <- barely concurrent at all
//
// A green run at RAMP=5s is not a better system, it is a weaker test. If the
// host cannot drive the burst, prefer running k6 from inside the docker
// network (real 500-concurrency, no forwarder in the way) over ramping.
//
//   -e RAMP=0s   (default) all at once, as the spec describes
//   -e RAMP=1s   shortest ramp that lands every request from a Windows host

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const USER_COUNT = parseInt(__ENV.USER_COUNT || '500', 10);
const PRODUCT_ID = __ENV.PRODUCT_ID || 'p-1001';
const DUPLICATE_USER_COUNT = parseInt(__ENV.DUPLICATE_USER_COUNT || '20', 10);
const DUPLICATE_REQUESTS = parseInt(__ENV.DUPLICATE_REQUESTS || '3', 10);
// Default 0s = all 500 at once, which is what "500 Concurrent requests" in the
// spec plainly means. The spec says nothing about ramping; RAMP exists only as
// a workaround for the client-side limit described above, not as a way to make
// the numbers look better.
const RAMP = __ENV.RAMP || '0s';
// Short on purpose: every user has normally ordered before the ramp finishes,
// so this is only a safety margin. A long hold leaves hundreds of VUs idling
// in the guard below, which inflates the `iterations` count and drags the
// per-second rates down until they say nothing useful.
const HOLD = __ENV.HOLD || '2s';

const accepted = new Counter('orders_accepted');
const rejectedDuplicate = new Counter('orders_rejected_duplicate');
const failedOther = new Counter('orders_failed_other');

export const options = {
  scenarios: {
    order_rush: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: USER_COUNT },
        // Hold at full strength so every user still gets their one shot even
        // if the ramp itself did not cover all of them.
        { duration: HOLD, target: USER_COUNT },
      ],
      gracefulRampDown: '0s',
    },
  },
  thresholds: {
    // Spec 2.3: the API must accept and queue, never 5xx under load.
    'http_req_failed': ['rate<0.01'],
    'http_req_duration{scenario:order_rush}': ['p(95)<2000'],
  },
};

// Preparation phase — one JWT per unique user, outside the VU pool.
export function setup() {
  const tokens = [];
  for (let i = 1; i <= USER_COUNT; i++) {
    const userId = `user-${i}`;
    const res = http.post(
      `${BASE_URL}/api/v1/auth/token`,
      JSON.stringify({ userId }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    tokens.push({ userId, accessToken: res.json('accessToken') });
  }
  console.log(`prepared ${tokens.length} tokens`);
  return { tokens };
}

export default function (data) {
  // ramping-vus keeps calling this for the whole stage, so the user cannot be
  // keyed off __VU: one VU would place several orders and the "500 unique
  // users, one each" requirement would break. iterationInTest is a global
  // counter across every VU, so each iteration claims the next unused user
  // and every user is used exactly once.
  const idx = exec.scenario.iterationInTest;
  if (idx >= data.tokens.length) {
    // All 500 users have ordered. Idle out the rest of the stage rather than
    // spinning — extra orders here would be duplicates, not load.
    sleep(1);
    return;
  }

  const me = data.tokens[idx];
  if (!me || !me.accessToken) {
    failedOther.add(1);
    return;
  }

  const params = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${me.accessToken}`,
    },
  };
  const body = JSON.stringify({ productId: PRODUCT_ID });

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

  responses.forEach((res, idx) => {
    const queued = res.status === 202;
    const dup = res.status === 409 || res.status === 429;
    check(res, {
      [`${me.userId} attempt ${idx + 1}: 202 Accepted or duplicate-rejected`]: () => queued || dup,
    });
    if (queued) accepted.add(1);
    else if (dup) rejectedDuplicate.add(1);
    else failedOther.add(1);
  });
}

// Keeps the normal console output AND writes the raw metrics to disk, so the
// report can quote Req/s, p95 and error rate from a file instead of a
// screenshot of scrollback. Set -e OUT= to a different name per run
// (e.g. -e OUT=results/orders-500-ramp0.json) when comparing configurations.
//
// Paths are relative to the directory k6 was launched from, which is why the
// runbook says to run from the repo root. Absolute POSIX paths like /tmp/x
// do not exist on Windows and k6 will fail the summary step.
export function handleSummary(data) {
  const out = __ENV.OUT || 'load-test/results/orders-500.json';
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [out]: JSON.stringify(data, null, 2),
  };
}
