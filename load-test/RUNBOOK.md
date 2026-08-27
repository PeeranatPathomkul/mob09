# Load-test runbook

## 0. Install k6 (once)

Windows:

```powershell
winget install k6 --source winget
# or: choco install k6
```

Verify: `k6 version`. Open a **new** terminal afterwards so PATH refreshes.

No k6 and can't install it? See "Fallback without k6" at the bottom.

---

## 1. Bring the stack up

```bash
docker compose up -d --build
```

Wait until all 8 containers are healthy:

```bash
docker compose ps
```

## 2. Seed the products

```bash
docker compose exec api1 node dist/database/seed.js
```

`p-1001` must start at 50 units — check it:

```bash
docker compose exec postgres psql -U postgres -d flash_sale -c \
  "SELECT id, remaining_stock FROM products WHERE id IN ('p-1001','p-1003');"
```

> Re-run the seed before **every** test run. It upserts, so it resets stock
> back to the seed values. Also clear old orders first:
> ```bash
> docker compose exec postgres psql -U postgres -d flash_sale -c "TRUNCATE orders;"
> docker compose exec redis redis-cli FLUSHALL
> ```

---

## 3. Read load — spec section 3

1,000 concurrent users on the cached product list.

```bash
k6 run -e BASE_URL=http://localhost:8080 load-test/products-read.js
```

Report from the k6 summary: `http_reqs` rate (Req/s), `http_req_duration` p(95),
`http_req_failed` rate (Error Rate).

## 4. Write load — spec section 3

500 unique users racing for `p-1001` (50 units); the first 20 fire 3 requests each.

```bash
k6 run -e BASE_URL=http://localhost:8080 load-test/orders-500.js
```

Every request should come back **202 Accepted**. The API only queues here, so
this measures the entry path, not the stock decrement.

## 5. Wait for the queue, then prove integrity

The write load finishes long before the worker does. Watch Bull Board at
<http://localhost:4001/admin/queues> until `waiting` and `active` are both 0.

Then:

```bash
docker compose exec -T postgres psql -U postgres -d flash_sale < load-test/verify.sql
```

Expected:

| Check | Expected |
|---|---|
| `remaining_stock` of `p-1001` | exactly `0` |
| orders for `p-1001` | `50` |
| distinct users | `50` |
| anyone with >1 order | 0 rows |
| any product with negative stock | 0 rows |
| `remaining_stock + sold` | `50` |

---

## 6. Lost-jobs check (worker/DB diagnostic)

The spec scenario cannot distinguish "sold out correctly" from "jobs silently
died", because 450 of the 500 users were always going to lose. This one can.

```bash
docker compose exec postgres psql -U postgres -d flash_sale -c "TRUNCATE orders;"
docker compose exec redis redis-cli FLUSHALL
docker compose exec api1 node dist/database/seed.js

k6 run -e BASE_URL=http://localhost:8080 load-test/lost-jobs-check.js
```

`p-1003` has 500 units and 500 users want one each, so the only correct
outcome is everybody wins:

```bash
docker compose exec postgres psql -U postgres -d flash_sale -c \
  "SELECT remaining_stock FROM products WHERE id='p-1003';"   -- must be 0
docker compose exec postgres psql -U postgres -d flash_sale -c \
  "SELECT count(*) FROM orders WHERE product_id='p-1003';"    -- must be 500
```

If `remaining_stock > 0` here, jobs are being lost. Check why in Bull Board:
`failedReason` of `Insufficient stock` is legitimate; `Could not acquire stock
lock` is not — it means the job died without ever being retried.

---

## 7. Numbers to collect for the report

| Requirement | Where it comes from |
|---|---|
| Req/s, p95 latency, error rate | k6 summary (steps 3 and 4) |
| Jobs waiting / completed / failed | Bull Board, or `redis-cli ZCARD bull:orders:completed` / `bull:orders:failed` |
| Cache hit / miss ratio | needs instrumentation in `products.service.ts` — not built yet |
| Data integrity proof | step 5 |

Queue counters straight from Redis:

```bash
docker compose exec redis redis-cli LLEN  bull:orders:wait
docker compose exec redis redis-cli LLEN  bull:orders:active
docker compose exec redis redis-cli ZCARD bull:orders:completed
docker compose exec redis redis-cli ZCARD bull:orders:failed
```

Why a job failed:

```bash
docker compose exec redis redis-cli HGET "bull:orders:order:user-7:p-1001" failedReason
```

---

## Fallback without k6

`node-load.js` reproduces the write load using plain Node (v18+, uses global
`fetch`). It is less capable than k6 — no p95, no thresholds — but it is enough
to drive the queue and prove data integrity.

```bash
node load-test/node-load.js                          # 500 users vs p-1001
node load-test/node-load.js --product p-1003 --users 500   # lost-jobs check
```

Point it elsewhere with `--base http://localhost:8080`.
