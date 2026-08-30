#!/usr/bin/env bash
# Person 3 (Gus) — Write-Path (Processing): DB Transaction & Throughput Optimization
#
#   bash load-test/test-3-gus-throughput.sh
#
# What comes out of this, mapped straight to the evidence Gus's part of the
# report needs:
#
#   1. remainingStock lands on exactly 0,       -> verify.sql query 1 + bonus
#      never negative
#   2. orders has 50 rows / 50 distinct users,  -> verify.sql query 2 + 3
#      nobody holds more than 1 unit
#   3. sold == consumed, drift 0                -> verify.sql query 4
#      (atomicity cross-check)
#   4. Throughput / p50 / p95 / failure         -> measure.js output, also
#      breakdown for the CURRENT strategy +        appended to bench-results.csv
#      concurrency + pool env vars                 under the label printed below
#
# Uses whatever STOCK_CLAIM_STRATEGY / WORKER_CONCURRENCY / DB_POOL_MAX the
# worker container is CURRENTLY running with — this script does not restart
# it. To compare strategies or tune concurrency/pool systematically instead
# of a single run, use sweep.sh (bash load-test/sweep.sh strategy|concurrency|pool),
# which restarts the worker with each configuration and appends every result
# to the same CSV as this script does.
set -euo pipefail

cd "$(dirname "$0")/.."

PG_SVC=${PG_SVC:-postgres}
REDIS_SVC=${REDIS_SVC:-redis}
DB_USER=${DB_USERNAME:-postgres}
DB_NAME=${DB_DATABASE:-flash_sale}
BASE_URL=${BASE_URL:-http://nginx}
CSV=${CSV:-bench-results.csv}
LABEL=${LABEL:-manual/$(date +%s)}

echo "==> resetting to a clean pre-load state"
bash load-test/reset.sh > /dev/null

echo ""
echo "############ write load: 500 users vs 50 units of p-1001 ############"
docker compose --profile loadtest run --rm \
  -e BASE_URL="$BASE_URL" -e RAMP=0s \
  k6 /scripts/orders-500.js

echo ""
echo "==> waiting for the queue to drain"
for _ in $(seq 1 90); do
  pending=$(docker compose exec -T "$REDIS_SVC" sh -lc \
    "redis-cli eval \"return redis.call('LLEN','bull:orders:wait') + redis.call('LLEN','bull:orders:active')\" 0" \
    2>/dev/null | tr -d '\r')
  [ "$pending" = "0" ] && break
  sleep 2
done
sleep 2

echo ""
echo "############ 1-3) data integrity proof ############"
docker compose exec -T "$PG_SVC" psql -U "$DB_USER" -d "$DB_NAME" < load-test/verify.sql

echo ""
echo "############ 4) throughput / p50 / p95 / failure breakdown ############"
node load-test/measure.js --csv "$CSV" --label "$LABEL"

echo ""
echo "Report evidence produced by this run:"
echo "  - verify.sql output above: the 5 required correctness queries + the negative-stock bonus check"
echo "  - measure.js output above: jobsPerSec / p50Ms / p95Ms / failure breakdown for label '$LABEL'"
echo "  - appended to $CSV — for a before/after tuning graph, run this again after changing"
echo "    STOCK_CLAIM_STRATEGY / WORKER_CONCURRENCY / DB_POOL_MAX (docker compose up -d --force-recreate --no-deps worker)"
echo "    or just run: bash load-test/sweep.sh strategy   (or concurrency | pool)"
