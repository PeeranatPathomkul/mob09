# mob09 — Flash Sale System

Backend Assignment (Mobile Application Development)

A flash-sale backend built to survive 1,000 concurrent readers and 500 concurrent
buyers racing for 50 units, without ever overselling.

**Stack:** NestJS · PostgreSQL (TypeORM) · Redis · BullMQ · Nginx · JWT (stateless)

---

## Architecture

```
                            Clients / k6
                                 |
                          Nginx  :8080
                        (least_conn LB)
                                 |
              +------------------+------------------+
              |                  |                  |
           api1:3000         api2:3000          api3:3000     <- stateless, JWT only
              |                  |                  |
              +--------+---------+---------+--------+
                       |                   |
                   Postgres              Redis  :6380
                  (products,          (page cache, version
                   orders)             counter, entry locks,
                       |                BullMQ queue)
                       |                   |
                       +-------- worker ---+                  <- BullMQ consumer,
                                 |                               claims stock
                            Bull Board :4001                     in a transaction
```

**Why the worker is a separate service:** `POST /api/v1/orders` must answer fast
(spec 2.3), so the API only takes a Redis lock and enqueues. All database work —
the stock decrement and the order row — happens in the worker, inside one
transaction. `api1/api2/api3` load `AppModule`, which deliberately never imports
the BullMQ processor; only `worker` loads `WorkerModule`.

---

## Quick start

```bash
cp .env.example .env          # then edit JWT_SECRET
docker compose up -d --build
docker compose exec api1 node dist/database/seed.js
```

Seeding is only needed once — the Postgres volume keeps the data. To check
whether it is already seeded:

```bash
docker compose exec -T postgres psql -U postgres -d flash_sale -tAc "SELECT count(*) FROM products;"
```

| Service | URL |
|---|---|
| API (through nginx) | http://localhost:8080 |
| Bull Board (queue dashboard) | http://localhost:4001/admin/queues |
| Redis (host-side tools) | localhost:6380 |

Postgres and the API instances are not published to the host — reach them with
`docker compose exec`, or through nginx.

---

## API

All endpoints follow the shared spec so load-test scripts are interchangeable
between groups.

### `POST /api/v1/auth/token`

```json
{ "userId": "user-999" }
```
→ `200 OK` · `{ "status": "success", "accessToken": "eyJ..." }`

An empty or missing `userId` is rejected with `400`, not handed a token with no
subject.

### `GET /api/v1/products?page=1&limit=10`

→ `200 OK` · `{ "status": "success", "data": [...], "meta": { total, page, limit, totalPages } }`

Served through the Redis page cache. Every response also carries an `X-Cache`
header — `HIT`, `MISS`, or `BYPASS` — which is the only per-request view of what
the cache did.

`page` is clamped to 1000 and `limit` snaps up to one of `10 / 20 / 50 / 100`.
Both bound the cache key space: an unbounded `page`/`limit` would make every
request a guaranteed miss on a key nobody else shares.

### `POST /api/v1/orders`

Header: `Authorization: Bearer <token>` · Body: `{ "productId": "p-1001" }`

→ `202 Accepted` · `{ "status": "processing", "orderJobId": "...", "message": "..." }`

Quantity is never accepted from the client — one unit per user per product is a
server-side rule. Duplicate clicks get the **same** `orderJobId` back rather than
an error, so a client retry is idempotent.

### `GET /api/v1/cache/stats`

→ `{ hits, misses, errors, hitRate, currentVersion, redisAvailable }` — process-wide
totals for the report. Read-only; polling it does not move the counters.

---

## How the two concurrency problems are solved

### Duplicate orders (API layer)

`SET key value NX EX 30` — one atomic Redis command, no separate check-then-set,
so two simultaneous requests for the same `(user, product)` cannot both win. The
loser reads the winner's response back out of the lock and replays it.

The lock is released the moment BullMQ reports the job finished
(`OrdersLockReleaseListener`), not by waiting out the TTL — so a failed order
does not lock that user out. The 30s TTL is only a safety net if that listener
is down.

### Overselling (worker layer)

The worker claims stock inside one transaction at `READ COMMITTED`. The
isolation level does not need to be higher because `SELECT ... FOR UPDATE` is
itself the serialization point. A `UNIQUE (user_id, product_id)` constraint
backs it up at the database level.

Three interchangeable strategies are implemented and selected at runtime by
`STOCK_CLAIM_STRATEGY`, so a benchmark sweep only has to restart the worker:

| Strategy | How | Trade-off |
|---|---|---|
| `pessimistic` (default) | `SELECT ... FOR UPDATE` | 3 round trips while holding the row lock; clearest to read |
| `optimistic` | `version` column + retry | No lock, but retries thrash when 500 callers hit one row |
| `atomic` | one CTE: `UPDATE ... RETURNING` + `INSERT ... SELECT` | 1 round trip inside the lock — fastest measured |

### Cache invalidation

Every committed order bumps a Redis **version counter**; page keys embed that
version (`products:page:{page}:limit:{limit}:v:{version}`), so one `INCR`
invalidates every cached page at once — no key scanning, no stale stock.

Hit rate is *expected* to be low during a sale by design: the job of this module
is to cap how many requests reach Postgres per version (via a rebuild mutex),
not to maximise hit rate. A burst of 300 concurrent requests on a cold key
produced **2** actual Postgres queries.

---

## Load testing

Everything lives in `load-test/`. See **[load-test/RUNBOOK.md](load-test/RUNBOOK.md)**
for the full list of scripts and the step-by-step procedure.

```bash
bash load-test/reset.sh                  # ALWAYS run before a measured run

bash load-test/test-1-moo-cache.sh       # read path: hit/miss, latency, no stampede
bash load-test/test-2-kao-lock.sh        # entry lock: N clicks -> 1 job
bash load-test/test-3-gus-throughput.sh  # worker: integrity + throughput
bash load-test/test-4-full-system.sh     # all three under combined load
```

Run k6 from inside the compose network (`docker compose --profile loadtest run
--rm k6 /scripts/<script>.js`) rather than from the host — a host-side burst of
500+ connections gets partly refused by the Docker port forwarder, which shows
up as failures that belong to the test rig rather than the system.

Correctness is proven in the database, not by HTTP status codes:

```bash
docker compose exec -T postgres psql -U postgres -d flash_sale < load-test/verify.sql
```

---

## Configuration

All tunables live in `.env` (see `.env.example`). The ones that matter:

| Variable | Default | What it does |
|---|---|---|
| `STOCK_CLAIM_STRATEGY` | `pessimistic` | Which locking strategy the worker uses |
| `WORKER_CONCURRENCY` | `10` | In-flight jobs per worker |
| `DB_POOL_MAX` | `concurrency + 2` | Pool must exceed concurrency, or jobs queue for a connection before they reach the row lock |
| `DB_LOCK_TIMEOUT` | `5s` | Fail fast (retryable `55P03`) instead of growing an invisible backlog |
| `PRODUCT_CACHE_TTL_MIN/MAX_SECONDS` | `30` / `60` | Jittered TTL so keys don't all expire at once |

The worker service reads these from the environment, so a sweep can override
them without a rebuild:

```bash
WORKER_CONCURRENCY=4 docker compose up -d --force-recreate --no-deps worker
```

---

## Team

| Member | Area |
|---|---|
| moo | Read path — cache-aside design, TTL, stampede protection, hit/miss tuning |
| kao | Write path (entry) — atomic Redis lock, TTL and release, idempotency |
| Gus | Write path (processing) — DB transactions, locking strategy, worker/pool tuning |

---

## Known limitations

- `synchronize: true` is still enabled in `api/src/config/typeorm.config.ts`.
  It is what creates the schema on a fresh volume, so the 1-click start depends
  on it. Production would replace it with migrations — see the TODO in that file.
- Under combined read + write load, tail latency reaches multiple seconds even
  though p95 stays under 600 ms. Throughput stops improving past
  `WORKER_CONCURRENCY=4` because every order contends for the same product row,
  so added concurrency buys queueing, not speed.
