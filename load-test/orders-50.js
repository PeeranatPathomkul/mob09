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
//   -e SEND_QUANTITY=true       add a `quantity: 1` field to the order body

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const USER_COUNT = parseInt(__ENV.USER_COUNT || '50', 10);
const PRODUCT_ID = __ENV.PRODUCT_ID || 'p-1001';
const DUPLICATE_USER_COUNT = parseInt(__ENV.DUPLICATE_USER_COUNT || '5', 10);
const DUPLICATE_REQUESTS = parseInt(__ENV.DUPLICATE_REQUESTS || '3', 10);
// NOTE: the current CreateOrderDto still requires `quantity` (and a UUID
// productId), which conflicts with the section 2.3 spec ("no quantity needed,
// productId like p-1001"). Flip this on if the DTO hasn't been relaxed yet.
const SEND_QUANTITY = (__ENV.SEND_QUANTITY || 'false') === 'true';

const ordersAccepted = new Counter('orders_accepted');
const ordersRejectedDuplicate = new Counter('orders_rejected_duplicate');
const ordersFailedOther = new Counter('orders_failed_other');

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
    ordersFailedOther.add(1);
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
  // to exercise the API-level duplicate-request guard (SETNX/SADD lock).
  const shots = __VU <= DUPLICATE_USER_COUNT ? DUPLICATE_REQUESTS : 1;
  const body = JSON.stringify(payload);
  const requests = Array.from({ length: shots }, () => ({
    method: 'POST',
    url: `${BASE_URL}/api/v1/orders`,
    body,
    params,
  }));

  const responses = shots > 1 ? http.batch(requests) : [http.post(requests[0].url, requests[0].body, requests[0].params)];

  responses.forEach((res, idx) => {
    // Spec 2.3 is explicit: 202 Accepted. 200/201 here would mean the
    // controller did the work synchronously instead of queueing it.
    const queued = res.status === 202;
    const rejectedAsDuplicate = res.status === 409 || res.status === 429;

    check(res, {
      [`${me.userId} attempt ${idx + 1} handled (queued or rejected as duplicate)`]: () => queued || rejectedAsDuplicate,
    });

    if (queued) ordersAccepted.add(1);
    else if (rejectedAsDuplicate) ordersRejectedDuplicate.add(1);
    else ordersFailedOther.add(1);
  });

  sleep(1);
}
