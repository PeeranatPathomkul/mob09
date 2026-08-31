import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

// Small-scale rehearsal (50 users) of the write-heavy "buy p-1001" scenario
// from section 2.3, before scaling the same script up to the full 500 VUs.
//
// Run:
//   k6 run -e BASE_URL=http://localhost:8080 load-test/orders-50.js
//
// Useful overrides:
//   -e USER_COUNT=50            number of unique users to prepare tokens for
//   -e PRODUCT_ID=p-1001        product being fought over
//   -e DUPLICATE_USER_COUNT=5   how many users fire multiple near-simultaneous requests
//   -e DUPLICATE_REQUESTS=3     how many requests each of those users fires at once
//   -e SEND_QUANTITY=true       add a `quantity: 1` field to the order body (CreateOrderDto
//                               doesn't require it any more; kept as an override in case that changes back)

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const USER_COUNT = parseInt(__ENV.USER_COUNT || '50', 10);
const PRODUCT_ID = __ENV.PRODUCT_ID || 'p-1001';
const DUPLICATE_USER_COUNT = parseInt(__ENV.DUPLICATE_USER_COUNT || '5', 10);
const DUPLICATE_REQUESTS = parseInt(__ENV.DUPLICATE_REQUESTS || '3', 10);
const SEND_QUANTITY = (__ENV.SEND_QUANTITY || 'false') === 'true';

const ordersAccepted = new Counter('orders_accepted');
const ordersFailed = new Counter('orders_failed');
// Fires only if a user's own concurrent double/triple-click produced more
// than one distinct orderJobId — i.e. the Redis SETNX lock in
// orders.service.ts failed to collapse them into a single idempotent reply.
const duplicateLockViolations = new Counter('duplicate_lock_violations');

export const options = {
  scenarios: {
    order_rush: {
      executor: 'per-vu-iterations',
      vus: USER_COUNT,
      iterations: 1,
      maxDuration: '30s',
    },
  },
};

// setup() runs once, outside the VU pool: get a JWT for each unique test user.
export function setup() {
  const tokens = [];
  for (let i = 1; i <= USER_COUNT; i++) {
    const userId = `user-${i}`;
    const res = http.post(
      `${BASE_URL}/api/v1/auth/token`,
      JSON.stringify({ userId }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    const issued = check(res, {
      // Spec 2.1 says 200 OK, so check exactly that. Accepting 201 as well is
      // how our own 201 regression went unnoticed until another group's
      // stricter script hit it.
      [`token issued for ${userId}`]: (r) => r.status === 200,
    });
    tokens.push(issued ? { userId, accessToken: res.json('accessToken') } : { userId, accessToken: null });
  }
  return { tokens };
}

export default function (data) {
  const me = data.tokens[(__VU - 1) % data.tokens.length];
  if (!me || !me.accessToken) {
    ordersFailed.add(1);
    return;
  }

  const payload = { productId: PRODUCT_ID };
  if (SEND_QUANTITY) payload.quantity = 1;

  const params = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${me.accessToken}`,
    },
  };

  // A handful of users double/triple-click "buy" almost simultaneously,
  // to exercise the API-level duplicate-request guard (SETNX lock).
  const shots = __VU <= DUPLICATE_USER_COUNT ? DUPLICATE_REQUESTS : 1;
  const body = JSON.stringify(payload);
  const requests = Array.from({ length: shots }, () => ({
    method: 'POST',
    url: `${BASE_URL}/api/v1/orders`,
    body,
    params,
  }));

  const responses = shots > 1 ? http.batch(requests) : [http.post(requests[0].url, requests[0].body, requests[0].params)];

  const jobIds = responses.map((res, idx) => {
    // The API always answers 202 here, even for a duplicate — orders.service.ts
    // treats a lock collision as "hand back the original request's result",
    // not as an error. So 202 + a valid body is the only success shape;
    // there is no 409/429 to accept as an alternative.
    const okStatus = check(res, {
      [`${me.userId} attempt ${idx + 1} is 202 Accepted`]: (r) => r.status === 202,
    });

    if (!okStatus) {
      ordersFailed.add(1);
      return null;
    }

    const responseBody = res.json();
    const wellFormed = check(res, {
      [`${me.userId} attempt ${idx + 1} body has status:'processing' and an orderJobId`]: () =>
        responseBody &&
        responseBody.status === 'processing' &&
        typeof responseBody.orderJobId === 'string' &&
        responseBody.orderJobId.length > 0,
    });

    if (!wellFormed) {
      ordersFailed.add(1);
      return null;
    }

    ordersAccepted.add(1);
    return responseBody.orderJobId;
  });

  if (shots > 1) {
    // The real assertion for "duplicate protection works": every concurrent
    // submission from this one user must resolve to the *same* orderJobId —
    // proof the lock collapsed them into one order instead of queueing N.
    const successfulJobIds = jobIds.filter((id) => id !== null);
    const allCollapsedToOne = successfulJobIds.length === shots && new Set(successfulJobIds).size === 1;

    const collapsed = check(null, {
      [`${me.userId}: ${shots} concurrent submissions collapsed to 1 orderJobId`]: () => allCollapsedToOne,
    });

    if (!collapsed) duplicateLockViolations.add(1);
  }

  sleep(1);
}

// teardown() runs once, after every VU has finished. BullMQ processes orders
// asynchronously, so this polls briefly to give the worker a chance to catch
// up — it's a quick sanity check (stock must never go negative), not a
// substitute for load-test/verify.sql or Bull Board for the authoritative
// final numbers. It also doubles as a live check that cache invalidation
// works: every GET here goes through the same page cache the read-load test
// hits, so a stuck/stale value here would mean the version-bump
// invalidation isn't wired correctly.
export function teardown() {
  let remainingStock = null;

  for (let attempt = 0; attempt < 10; attempt++) {
    const res = http.get(`${BASE_URL}/api/v1/products?page=1&limit=100`);
    if (res.status === 200) {
      const body = res.json();
      const product = (body.data || []).find((p) => p.productId === PRODUCT_ID);
      if (product) remainingStock = product.remainingStock;
    }
    sleep(0.5);
  }

  check(null, {
    [`${PRODUCT_ID} remainingStock is known and never negative`]: () => remainingStock !== null && remainingStock >= 0,
  });

  console.log(`${PRODUCT_ID} remainingStock after run (best-effort, worker may still be draining): ${remainingStock}`);
}
