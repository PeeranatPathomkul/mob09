# Load-test runbook

Everything lives in this folder. Run every command **from the repo root**.

| File | What it's for |
|---|---|
| `orders-50.js` | 50-user warm-up — check the write path works before the real run |
| `orders-500.js` | **Spec write load**: 500 users race for `p-1001` (50 units) |
| `orders-duplicate-lock.js` | Proves the entry lock collapses a triple-click into one job |
| `products-read.js` | **Spec read load**: 1,000 concurrent users on the cached product list |
| `lost-jobs-check.js` | Catches silently-dying jobs — see "Why this one exists" below |
| `reset.sh` | Put DB + Redis back to a clean pre-load state |
| `verify.sql` | Data Integrity Proof (the 5 required queries) |
| `measure.js` | Throughput / p50 / p95 / failure breakdown from the queue |
| `sweep.sh` | Automated benchmark sweep, writes CSV |

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
