#!/usr/bin/env bash
# Full-system check — all three parts running together under one real flash
# sale shape (moo's cache + kao's entry lock + Gus's worker, all at once),
# not tested in isolation like test-1/test-2/test-3.
#
#   bash load-test/test-4-full-system.sh
#
# This is the closest thing to "does the whole thing actually work end to
# end" — it is also the scenario the individual tests cannot show: read load
# and write load competing for the same 3 API instances, same Redis, same
# Postgres pool, at the same time.
#
# What comes out of this:
#   1. moo_ja_test.js's own summary  -> read p95 vs write p95 under combined
#                                        load, and the READ vs WRITE report
#                                        at the bottom (accepted/duplicate/
#                                        sold-out/rejected breakdown)
#   2. verify.sql                    -> data integrity proof (same 5 required
#                                        queries + bonus), now proven under
#                                        realistic combined load instead of a
#                                        write-only run
#   3. measure.js                    -> worker-side throughput/p50/p95,
#                                        appended to bench-results.csv with
#                                        label "full-system/<timestamp>"
#   4. /api/v1/cache/stats           -> hit ratio under combined load (lower
#                                        than a read-only run is EXPECTED —
#                                        see product-cache.service.ts's
#                                        module doc: every order bumps the
#                                        version, so hit rate is capped by
#                                        write frequency by design)
set -euo pipefail

cd "$(dirname "$0")/.."

PG_SVC=${PG_SVC:-postgres}
REDIS_SVC=${REDIS_SVC:-redis}
DB_USER=${DB_USERNAME:-postgres}
DB_NAME=${DB_DATABASE:-flash_sale}
BASE_URL=${BASE_URL:-http://nginx}
CSV=${CSV:-bench-results.csv}
LABEL=${LABEL:-full-system/$(date +%s)}

echo "==> resetting to a clean pre-load state"
bash load-test/reset.sh > /dev/null

echo ""
echo "############ combined read (1,000 VUs) + write (500 VUs) load ############"
docker compose --profile loadtest run --rm \
  -e BASE_URL="$BASE_URL" \
  k6 /scripts/moo_ja_test.js

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
echo "############ data integrity proof (under combined load) ############"
docker compose exec -T "$PG_SVC" psql -U "$DB_USER" -d "$DB_NAME" < load-test/verify.sql

echo ""
echo "############ worker throughput (under combined load) ############"
node load-test/measure.js --csv "$CSV" --label "$LABEL"

echo ""
echo "############ cache hit ratio (under combined load) ############"
curl -s "http://localhost:8080/api/v1/cache/stats" 2>/dev/null || \
  echo "(curl to localhost:8080 not reachable from here — open http://localhost:8080/api/v1/cache/stats manually)"
echo ""

echo ""
echo "Report evidence produced by this run:"
echo "  - moo_ja_test.js stdout: read p95 vs write p95 while contending for the same instances,"
echo "    plus the accepted/duplicate/sold-out/rejected breakdown at the bottom"
echo "  - verify.sql output above: correctness holds even under combined load, not just write-only"
echo "  - measure.js output above: worker throughput under combined load, label '$LABEL' in $CSV"
echo "  - cache stats above: hit ratio is expected to be LOWER than the moo-only test — every"
echo "    successful order bumps the cache version, so hit rate is capped by write frequency here"
