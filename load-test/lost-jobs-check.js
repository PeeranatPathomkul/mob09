import http from 'k6/http';
import { check } from 'k6';

// Diagnostic for the worker/DB layer — NOT part of the assignment spec.
//
// The spec scenario (500 users, 50 units) cannot tell "sold out correctly"
// apart from "jobs were silently lost", because 450 users were always going
// to leave empty-handed. This one can: 500 users race for p-1003, which is
// seeded with 500 units, so the ONLY correct outcome is 500 orders and
// remaining_stock = 0. Any shortfall is jobs dying, not stock running out.
//
//   k6 run -e BASE_URL=http://localhost:8080 load-test/lost-jobs-check.js
//
// Then:
//   SELECT remaining_stock FROM products WHERE id='p-1003';   -- must be 0
//   SELECT count(*) FROM orders WHERE product_id='p-1003';    -- must be 500

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const USER_COUNT = parseInt(__ENV.USER_COUNT || '500', 10);
const PRODUCT_ID = __ENV.PRODUCT_ID || 'p-1003';

export const options = {
  scenarios: {
    everyone_should_win: {
      executor: 'per-vu-iterations',
      vus: USER_COUNT,
      iterations: 1,
      maxDuration: '60s',
    },
  },
};

export function setup() {
  const tokens = [];
  for (let i = 1; i <= USER_COUNT; i++) {
    const res = http.post(
      `${BASE_URL}/api/v1/auth/token`,
      JSON.stringify({ userId: `user-${i}` }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    // Spec 2.1: 200 OK exactly. See the note in orders-500.js.
    if (res.status !== 200) {
      throw new Error(`auth failed for user-${i}: expected 200, got ${res.status} — ${res.body}`);
    }
    tokens.push(res.json('accessToken'));
  }
  return { tokens };
}

export default function (data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const res = http.post(
    `${BASE_URL}/api/v1/orders`,
    JSON.stringify({ productId: PRODUCT_ID }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } },
  );
  check(res, { 'queued (202)': (r) => r.status === 202 });
}
