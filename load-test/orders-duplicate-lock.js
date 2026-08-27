// Benchmark for the write-path entry lock (person 2's task): fires several
// requests for the SAME user + product truly concurrently (http.batch
// dispatches them in parallel, not one after another) and proves the lock
// collapsed them into exactly one job.
//
// Run (from repo root, so the load-test/ path resolves):
//   k6 run -e BASE_URL=http://localhost:8080 -e PRODUCT_ID=p-1001 load-test/orders-duplicate-lock.js
//
// Optional:
//   -e TEST_USER_ID=user-dup-1      (defaults to 'user-dup-lock-test')
//   -e DUPLICATE_COUNT=3            (how many parallel duplicates to fire, default 3)
//
// What "proof" looks like:
//   1. This script's own check: every one of the N concurrent responses
//      carries the SAME orderJobId. Only the request whose SET NX actually
//      won gets to call queue.add(); every other duplicate reads that same
//      job id back out of the lock instead of enqueuing its own — so N
//      identical ids is direct evidence only one job was ever created.
//   2. For the report, pair this with an external check on the queue
//      itself right after running this script, e.g. open Bull Board
//      (http://localhost:4001/admin/queues) and confirm the "orders" queue
//      only grew by 1 job for this productId, not by DUPLICATE_COUNT.

import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const TEST_USER_ID = __ENV.TEST_USER_ID || 'user-dup-lock-test';
const PRODUCT_ID = __ENV.PRODUCT_ID;
const DUPLICATE_COUNT = Number(__ENV.DUPLICATE_COUNT || 3);

export const options = {
  scenarios: {
    duplicate_burst: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
    },
  },
};

export function setup() {
  if (!PRODUCT_ID) {
    throw new Error('Pass -e PRODUCT_ID=<id> for a real, in-stock product (e.g. p-1001) before running this script.');
  }

  const tokenRes = http.post(
    `${BASE_URL}/api/v1/auth/token`,
    JSON.stringify({ userId: TEST_USER_ID }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  const ok = check(tokenRes, { 'got auth token': (r) => r.status === 200 || r.status === 201 });
  if (!ok) {
    throw new Error(`Failed to get auth token: HTTP ${tokenRes.status} — ${tokenRes.body}`);
  }

  return { accessToken: tokenRes.json('accessToken') };
}

export default function (data) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.accessToken}`,
  };
  const body = JSON.stringify({ productId: PRODUCT_ID });

  // http.batch sends all of these over the wire at once — this is what
  // simulates a rapid double/triple click or a client's own network-retry
  // storm, as opposed to sequential requests that wouldn't actually race.
  const requests = Array.from({ length: DUPLICATE_COUNT }, () => ({
    method: 'POST',
    url: `${BASE_URL}/api/v1/orders`,
    body,
    params: { headers },
  }));

  const responses = http.batch(requests);

  const jobIds = responses.map((r, idx) => {
    check(r, { [`request ${idx + 1} status is 202`]: (res) => res.status === 202 });
    return r.json('orderJobId');
  });

  const uniqueJobIds = new Set(jobIds);

  check(null, {
    'all concurrent duplicates resolved to the same orderJobId': () => uniqueJobIds.size === 1,
  });

  console.log(
    `Fired ${DUPLICATE_COUNT} concurrent duplicate requests for user=${TEST_USER_ID} product=${PRODUCT_ID}; ` +
      `got ${uniqueJobIds.size} unique orderJobId(s): ${[...uniqueJobIds].join(', ')}`,
  );
}