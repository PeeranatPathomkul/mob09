/**
 * k6-free write load. Node 18+ (uses global fetch). No dependencies.
 *
 *   node load-test/node-load.js
 *   node load-test/node-load.js --product p-1003 --users 500
 *   node load-test/node-load.js --base http://localhost:8080 --dup-users 20
 *
 * k6 is the tool the spec asks for — use that when it's installed. This
 * exists so the queue can still be driven and data integrity proven when
 * it isn't.
 */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = arg('base', 'http://localhost:8080');
const USERS = parseInt(arg('users', '500'), 10);
const PRODUCT = arg('product', 'p-1001');
const DUP_USERS = parseInt(arg('dup-users', '20'), 10);
const DUP_SHOTS = parseInt(arg('dup-shots', '3'), 10);

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function getToken(userId) {
  const r = await fetch(`${BASE}/api/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, token: body.accessToken };
}

async function main() {
  console.log(`target ${BASE}  product ${PRODUCT}  users ${USERS}`);

  // --- preparation phase -------------------------------------------------
  const t0 = Date.now();
  const tokens = [];
  const authStatus = {};
  for (let i = 0; i < USERS; i += 50) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(50, USERS - i) }, (_, k) => getToken(`user-${i + k + 1}`)),
    );
    for (const b of batch) {
      authStatus[b.status] = (authStatus[b.status] || 0) + 1;
      if (b.token) tokens.push(b.token);
    }
  }
  console.log(`prep: ${tokens.length}/${USERS} tokens in ${Date.now() - t0}ms  statuses=${JSON.stringify(authStatus)}`);
  if (!tokens.length) {
    console.error('no tokens issued — is the stack up and seeded?');
    process.exit(1);
  }

  // --- write load: everything in flight at once --------------------------
  const latencies = [];
  const tasks = [];
  tokens.forEach((tok, idx) => {
    const shots = idx < DUP_USERS ? DUP_SHOTS : 1;
    for (let s = 0; s < shots; s++) {
      tasks.push(
        (async () => {
          const s0 = Date.now();
          try {
            const r = await fetch(`${BASE}/api/v1/orders`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
              body: JSON.stringify({ productId: PRODUCT }),
            });
            latencies.push(Date.now() - s0);
            return r.status;
          } catch {
            latencies.push(Date.now() - s0);
            return 0;
          }
        })(),
      );
    }
  });

  console.log(`firing ${tasks.length} POST /api/v1/orders ...`);
  const t1 = Date.now();
  const statuses = await Promise.all(tasks);
  const ms = Date.now() - t1;

  const by = {};
  statuses.forEach((s) => { by[s] = (by[s] || 0) + 1; });
  latencies.sort((a, b) => a - b);

  console.log(`\n--- write load ---`);
  console.log(`  requests   ${tasks.length}`);
  console.log(`  duration   ${ms}ms`);
  console.log(`  throughput ${Math.round((tasks.length / ms) * 1000)} req/s`);
  console.log(`  latency    p50 ${pct(latencies, 50)}ms   p95 ${pct(latencies, 95)}ms   max ${latencies[latencies.length - 1]}ms`);
  console.log(`  statuses   ${JSON.stringify(by)}   (spec 2.3 wants 202)`);
  console.log(`\nQueue is still draining. Watch Bull Board, then run load-test/verify.sql.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
