import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

// Section 3 read load: 1,000 concurrent users hammering the cached
// product list.
//
//   k6 run -e BASE_URL=http://localhost:8080 load-test/products-read.js

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const VUS = parseInt(__ENV.VUS || '1000', 10);
const DURATION = __ENV.DURATION || '30s';
const LIMIT = parseInt(__ENV.LIMIT || '10', 10);
const MAX_PAGE = parseInt(__ENV.MAX_PAGE || '2', 10);

const shapeOk = new Rate('response_shape_ok');

export const options = {
  scenarios: {
    read_flood: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    'http_req_failed': ['rate<0.01'],
    'http_req_duration': ['p(95)<500'],
  },
};

export default function () {
  // Spread across pages so the cache is exercised, not just one hot key.
  const page = ((__ITER + __VU) % MAX_PAGE) + 1;
  const res = http.get(`${BASE_URL}/api/v1/products?page=${page}&limit=${LIMIT}`);

  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'has status:success': (r) => r.json('status') === 'success',
    'has data array': (r) => Array.isArray(r.json('data')),
    'has meta.totalPages': (r) => r.json('meta.totalPages') !== undefined,
  });
  shapeOk.add(ok);
}
