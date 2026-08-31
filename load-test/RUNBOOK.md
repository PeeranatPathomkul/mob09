# Load-test runbook

Everything lives in this folder. Run every command **from the repo root**.

| File | What it's for |
|---|---|
| `orders-50.js` | 50-user warm-up — check the write path works before the real run |
| `orders-500.js` | **Spec write load**: 500 users race for `p-1001` (50 units) |
| `orders-duplicate-lock.js` | Proves the entry lock collapses a triple-click into one job |
| `products-read.js` | **Spec read load**: 1,000 concurrent users on the cached product list |
| `cache-hit-miss.js` | Deterministic miss -> hit -> hit proof + latency, single VU |
| `cache-stampede.js` | Fires a concurrent burst on one never-cached key; proves the rebuild mutex, not "everyone queries Postgres at once" |
| `cache-failure-modes.js` | Every way this cache can fail, in one run, with HIT/MISS/BYPASS reported per phase (read `X-Cache` per request). Needs `reset.sh` first — phase 1 measures a cold cache |
| `pagination-integrity.js` | **Spec 2.2 correctness**: meta arithmetic, page disjointness, cross-limit agreement, every documented field + type, out-of-range pages — asserted on every response while `LOAD_VUS` readers hammer the endpoint |
| `cache-invalidation.js` | **Spec 2.2 invalidation, as a number**: staleness in ms per round *per page size* (catches partial invalidation), exactly-one decrement per order, and stock-never-climbs as a hard failure — all under read load |
| `order-concurrency.js` | **Spec 2.3 business rules**: burst duplicate, one user buying two products at once, `quantity` field ignored, duplicate *after the lock expires*, oversell + async-controller proof. Judges units consumed, not status codes, so it runs against any group |
| `cache-blackbox.js` | **For testing another group**: estimates their cache hit-rate from the outside, by calibrating known-hit vs known-miss latency under their own load. Use when they expose no `X-Cache` / no stats endpoint |
| `lost-jobs-check.js` | Catches silently-dying jobs — see "Why this one exists" below |
| `moo_ja_test.js` | Read load + write load running together — the shape a real flash sale has, and the only script that shows how they contend |
| `reset.sh` | Put DB + Redis back to a clean pre-load state |
| `verify.sql` | Data Integrity Proof (the 5 required queries) |
| `measure.js` | Throughput / p50 / p95 / failure breakdown from the queue |
| `sweep.sh` | Automated benchmark sweep, writes CSV |
| `test-1-moo-cache.sh` | Runs both cache scripts + a `pg_stat_user_tables.seq_scan` before/after check, prints everything person 1 needs for the report |
| `test-2-kao-lock.sh` | Runs the duplicate-lock probe for two users, checks the queue + `orders` table to prove N clicks -> 1 job, for person 2 |
| `test-3-gus-throughput.sh` | Runs the 500-user write load, `verify.sql`, and `measure.js` in one go, for person 3 |
| `test-4-full-system.sh` | All three parts running together (read + write at once) — the combined shape a real flash sale has, plus integrity/throughput/cache checks on that run |
| `watch-cache-stats.sh` | Background poller: logs `/api/v1/cache/stats` every few seconds to a timestamped CSV — run this before someone else load-tests your system so you have a timeline, not just a before/after snapshot |

Prerequisites: `winget install GrafanaLabs.k6`, then open a **new** terminal.

---

## 1. Start and seed

```bash
docker compose up -d --build
docker compose exec api1 node dist/database/seed.js
```

## 2. Reset before EVERY run

```bash
bash load-test/reset.sh
```

On PowerShell you need the `bash` prefix (or use Git Bash).

Clearing `bull:orders:*` matters: `measure.js` derives its throughput window
from `min(processedOn)`/`max(finishedOn)` across every job still in the queue,
so leftovers from the previous run would stretch that window and understate
the result.

## 3. Run the load

```bash
# warm-up
k6 run -e BASE_URL=http://localhost:8080 load-test/orders-50.js

# read load — 1,000 concurrent
k6 run -e BASE_URL=http://localhost:8080 load-test/products-read.js

# write load — 500 users vs 50 units
k6 run -e BASE_URL=http://localhost:8080 load-test/orders-500.js

# duplicate guard — one user, 3 simultaneous clicks
k6 run -e BASE_URL=http://localhost:8080 -e PRODUCT_ID=p-1001 \
       -e DUPLICATE_COUNT=3 load-test/orders-duplicate-lock.js
```

### Correctness under load (run these against another group too)

```bash
# spec 2.2 response + pagination contract, asserted under 200 concurrent readers
k6 run -e BASE_URL=http://localhost:8080 load-test/pagination-integrity.js

# spec 2.2 invalidation: how many ms the cache lies, per page size
bash load-test/reset.sh
k6 run -e BASE_URL=http://localhost:8080 load-test/cache-invalidation.js

# spec 2.3 business rules. Takes ~2.5 min: phase D deliberately waits out the
# 30s entry lock, which is the only way to test the duplicate the lock cannot
# catch. -e DELAY_SEC= must stay above the target's lock TTL.
bash load-test/reset.sh
k6 run -e BASE_URL=http://localhost:8080 load-test/order-concurrency.js
```

All three read stock through `GET /api/v1/products` only — no Redis, no
Postgres, no `X-Cache` — so they work unchanged against a group whose
internals you cannot see.

## 4. Wait for the queue to drain

The load finishes long before the worker does. Watch
<http://localhost:4001/admin/queues> until `waiting` and `active` are both 0.

## 5. Collect the evidence

```bash
# Data Integrity Proof
docker compose exec -T postgres psql -U postgres -d flash_sale < load-test/verify.sql

# throughput, p50/p95, failures by reason
node load-test/measure.js
```

Expected after `orders-500.js`:

| Check | Expected |
|---|---|
| `remaining_stock` of `p-1001` | exactly `0` |
| orders / distinct users | `50` / `50` |
| anyone with >1 order | 0 rows |
| consumed vs sold drift | `0` |
| `measure.js` failures | 450 × `OUT_OF_STOCK`, `retried 0` |

---

## Benchmark sweeps

```bash
bash load-test/sweep.sh strategy      # pessimistic vs optimistic vs atomic
bash load-test/sweep.sh concurrency   # 1,2,4,8,16,32
```

Each run resets, restarts the worker with new env, loads, waits, measures, and
appends a row to `bench-results.csv`. No rebuild needed — the worker reads
`STOCK_CLAIM_STRATEGY` / `WORKER_CONCURRENCY` / `DB_POOL_MAX` from the
environment (see the `worker` service in `docker-compose.yml`).

## Why `lost-jobs-check.js` exists

The spec scenario cannot tell "sold out correctly" apart from "jobs silently
died", because 450 of the 500 users were always going to lose. This one can:
`p-1003` holds 500 units and 500 users each want one, so the only correct
outcome is **500 orders, `remaining_stock` 0**. Any shortfall means jobs were
lost, not that stock ran out.

```bash
bash load-test/reset.sh
k6 run -e BASE_URL=http://localhost:8080 load-test/lost-jobs-check.js
docker compose exec postgres psql -U postgres -d flash_sale -c \
  "SELECT remaining_stock FROM products WHERE id='p-1003';"   -- must be 0
```

In Bull Board, `OUT_OF_STOCK` is a legitimate failure; anything else on this
run is a bug.

## Queue counters by hand

```bash
docker compose exec redis redis-cli LLEN  bull:orders:wait
docker compose exec redis redis-cli LLEN  bull:orders:active
docker compose exec redis redis-cli ZCARD bull:orders:completed
docker compose exec redis redis-cli ZCARD bull:orders:failed
docker compose exec redis redis-cli HGET "bull:orders:order:user-7:p-1001" failedReason
```
