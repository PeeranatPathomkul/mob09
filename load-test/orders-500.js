import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

// Section 3 write load: 500 unique users race for p-1001 (50 units).
// A slice of them double/triple-click to exercise the duplicate guard.
//
//   k6 run -e BASE_URL=http://localhost:8080 load-test/orders-500.js

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const USER_COUNT = parseInt(__ENV.USER_COUNT || '500', 10);
const PRODUCT_ID = __ENV.PRODUCT_ID || 'p-1001';
const DUPLICATE_USER_COUNT = parseInt(__ENV.DUPLICATE_USER_COUNT || '20', 10);
const DUPLICATE_REQUESTS = parseInt(__ENV.DUPLICATE_REQUESTS || '3', 10);

const accepted = new Counter('orders_accepted');
const rejectedDuplicate = new Counter('orders_rejected_duplicate');
const failedOther = new Counter('orders_failed_other');

export const options = {
  scenarios: {
    order_rush: {
      executor: 'per-vu-iterations',
      vus: USER_COUNT,
      iterations: 1,
      maxDuration: '60s',
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
  const me = data.tokens[(__VU - 1) % data.tokens.length];
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

  const shots = __VU <= DUPLICATE_USER_COUNT ? DUPLICATE_REQUESTS : 1;
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
