#!/usr/bin/env bash
# Put the system back to a known pre-load state.
#
#   ./api/bench/reset.sh
#
# Clearing bull:orders:* matters more than it looks: measure.ts derives the
# throughput window from min(processedOn)/max(finishedOn) across every job in
# the queue, so jobs left over from the previous run would stretch that window
# and quietly deflate the result.
set -euo pipefail

cd "$(dirname "$0")/../.."

PG_SVC=${PG_SVC:-postgres}
REDIS_SVC=${REDIS_SVC:-redis}
DB_USER=${DB_USERNAME:-postgres}
DB_NAME=${DB_DATABASE:-flash_sale}

echo "==> truncating orders"
docker compose exec -T "$PG_SVC" psql -U "$DB_USER" -d "$DB_NAME" -c "TRUNCATE orders;"

echo "==> restoring remaining_stock = total_stock"
docker compose exec -T "$PG_SVC" psql -U "$DB_USER" -d "$DB_NAME" -c \
  "UPDATE products SET remaining_stock = total_stock, version = 0;"

echo "==> clearing redis keys"
for pattern in 'lock:order:*' 'order-lock:*' 'products:*' 'cache:hits' 'cache:misses' 'bull:orders:*'; do
  docker compose exec -T "$REDIS_SVC" sh -lc \
    "redis-cli --scan --pattern '$pattern' | xargs -r redis-cli DEL > /dev/null" || true
  echo "    cleared $pattern"
done

echo "==> state after reset"
docker compose exec -T "$PG_SVC" psql -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT id, total_stock, remaining_stock FROM products WHERE id IN ('p-1001','p-1003') ORDER BY id;"

echo "reset complete"
