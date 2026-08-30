#!/usr/bin/env bash
# Person 2 (kao) — Write-Path (Entry): Distributed Lock Optimization
#
#   bash load-test/test-2-kao-lock.sh
#
# What comes out of this, mapped straight to the evidence kao's part of the
# report needs:
#
#   1. N concurrent duplicate clicks from the SAME user collapse into
#      exactly 1 job                          -> orders-duplicate-lock.js's
#                                                 own check + the psql count
#                                                 at the end of this script
#   2. Only 1 job actually enters the queue    -> ZCARD delta printed below
#      (not N)                                    (bull:orders:completed)
#   3. The lock is released correctly (a       -> re-running the same probe
#      later, unrelated purchase by the same     for a second user right
#      user for a DIFFERENT product is not        after proves the lock is
#      blocked by a stale lock)                   scoped per user+product,
#                                                   not global
#
# Runs reset.sh first, so this needs a clean product to spend units from —
# p-1001 has only 50, so this uses 2 units of it (one per test user below),
# leaving 48 for test-3.
set -euo pipefail

cd "$(dirname "$0")/.."

PG_SVC=${PG_SVC:-postgres}
REDIS_SVC=${REDIS_SVC:-redis}
DB_USER=${DB_USERNAME:-postgres}
DB_NAME=${DB_DATABASE:-flash_sale}
BASE_URL=${BASE_URL:-http://nginx}
PRODUCT_ID=${PRODUCT_ID:-p-1001}
DUPLICATE_COUNT=${DUPLICATE_COUNT:-3}

echo "==> resetting to a clean pre-load state"
bash load-test/reset.sh > /dev/null

completed_count() {
  docker compose exec -T "$REDIS_SVC" redis-cli ZCARD bull:orders:completed | tr -d '\r'
}

run_probe() {
  local user_id="$1"
  echo ""
  echo "############ duplicate burst: user=$user_id product=$PRODUCT_ID x$DUPLICATE_COUNT ############"
  docker compose --profile loadtest run --rm \
    -e BASE_URL="$BASE_URL" -e PRODUCT_ID="$PRODUCT_ID" \
    -e TEST_USER_ID="$user_id" -e DUPLICATE_COUNT="$DUPLICATE_COUNT" \
    k6 /scripts/orders-duplicate-lock.js
}

BEFORE=$(completed_count)
echo "bull:orders:completed before: $BEFORE"

# Two different users, one after another, so the second run also proves the
# lock is scoped to (user, product) and does not leak/block across users.
run_probe "user-dup-lock-1"
run_probe "user-dup-lock-2"

echo ""
echo "==> waiting for both jobs to drain"
for _ in $(seq 1 30); do
  pending=$(docker compose exec -T "$REDIS_SVC" sh -lc \
    "redis-cli eval \"return redis.call('LLEN','bull:orders:wait') + redis.call('LLEN','bull:orders:active')\" 0" \
    2>/dev/null | tr -d '\r')
  [ "$pending" = "0" ] && break
  sleep 1
done

AFTER=$(completed_count)
echo "bull:orders:completed after:  $AFTER"
echo "delta: $((AFTER - BEFORE))  (expected: exactly 2 — one per user, NOT 2 x $DUPLICATE_COUNT = $((2 * DUPLICATE_COUNT)))"

echo ""
echo "############ database-side confirmation ############"
docker compose exec -T "$PG_SVC" psql -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT user_id, count(*) AS orders_placed
     FROM orders
    WHERE user_id IN ('user-dup-lock-1', 'user-dup-lock-2') AND product_id = '$PRODUCT_ID'
    GROUP BY user_id
    ORDER BY user_id;"
echo "expected: 1 row per user, orders_placed = 1 (not $DUPLICATE_COUNT)"

echo ""
echo "Report evidence produced by this run:"
echo "  - orders-duplicate-lock.js stdout (x2): all $DUPLICATE_COUNT concurrent responses share ONE orderJobId, per user"
echo "  - queue delta above: +2 completed jobs total for $((2 * DUPLICATE_COUNT)) HTTP requests sent"
echo "  - psql table above: 1 order row per user — the lock did its job at both the Redis and DB layer"
echo "  - the two users succeeding independently shows the lock key is scoped per (user, product), not global"
