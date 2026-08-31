#!/usr/bin/env bash
# Person 1 (moo) — Read-Path: Cache Optimization
#
#   bash load-test/test-1-moo-cache.sh
#
# What comes out of this, mapped straight to the evidence moo's part of the
# report needs:
#
#   1. Cache Hit/Miss Ratio, before/after     -> cache-hit-miss.js output +
#                                                 the /api/v1/cache/stats dump
#      the deterministic case (miss -> hit -> hit)
#   2. Latency: cache hit vs cache miss       -> "1st request (miss...)" vs
#                                                 "repeat N (hit...)" lines
#   3. Proof there is no stampede when the    -> cache-stampede.js output +
#      cache expires under concurrent load       the seq_scan delta printed
#                                                 at the end of this script
#
# This script does NOT touch orders or stock (reset.sh is for the write-path
# tests) — it only clears the read-side cache counters/keys so the run is
# repeatable.
set -euo pipefail

cd "$(dirname "$0")/.."

PG_SVC=${PG_SVC:-postgres}
REDIS_SVC=${REDIS_SVC:-redis}
DB_USER=${DB_USERNAME:-postgres}
DB_NAME=${DB_DATABASE:-flash_sale}
BASE_URL=${BASE_URL:-http://nginx}
BURST=${BURST:-300}

seq_scan() {
  docker compose exec -T "$PG_SVC" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
    "SELECT seq_scan FROM pg_stat_user_tables WHERE relname='products';"
}

echo "==> clearing cache counters and page cache (orders/stock untouched)"
for pattern in 'products:*' 'cache:hits' 'cache:misses' 'cache:errors'; do
  docker compose exec -T "$REDIS_SVC" sh -lc \
    "redis-cli --scan --pattern '$pattern' | xargs -r redis-cli DEL > /dev/null" || true
done

echo ""
echo "############ 1) deterministic hit/miss + latency proof ############"
docker compose --profile loadtest run --rm \
  -e BASE_URL="$BASE_URL" \
  k6 /scripts/cache-hit-miss.js

echo ""
echo "############ 2) stampede proof under concurrent load ############"
BEFORE=$(seq_scan)
echo "products.seq_scan before burst: $BEFORE"

docker compose --profile loadtest run --rm \
  -e BASE_URL="$BASE_URL" -e BURST="$BURST" \
  k6 /scripts/cache-stampede.js

AFTER=$(seq_scan)
echo "products.seq_scan after burst:  $AFTER"
echo "delta: $((AFTER - BEFORE))  (this is the number of times Postgres was actually queried for $BURST concurrent requests on one previously-untouched cache key)"

echo ""
echo "############ 3) overall hit ratio snapshot ############"
curl -s "http://localhost:8080/api/v1/cache/stats" 2>/dev/null || \
  echo "(curl to localhost:8080 not reachable from here — open http://localhost:8080/api/v1/cache/stats in a browser, or run this script from the same host nginx is published on)"

echo ""
echo "Report evidence produced by this run:"
echo "  - cache-hit-miss.js stdout: miss latency vs hit latency, hit/miss counters moving correctly"
echo "  - cache-stampede.js stdout: identical-payload count, slow-response count, before/after hit+miss counters"
echo "  - seq_scan delta above: the real 'no stampede' number — compare it to BURST=$BURST, not to it being 0"
