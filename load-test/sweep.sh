#!/usr/bin/env bash
# Automated benchmark sweep. Resets, loads, waits for drain, measures — once
# per configuration — and appends every result to one CSV.
#
#   ./load-test/sweep.sh strategy       # pessimistic vs optimistic vs atomic
#   ./load-test/sweep.sh concurrency    # 1,2,4,8,16,32 on the chosen strategy
#
# Each configuration is applied by restarting the worker with new env, so no
# rebuild is needed between runs.
set -euo pipefail

cd "$(dirname "$0")/.."

MODE=${1:-strategy}
OUT=${OUT:-bench-results.csv}
BASE_URL=${BASE_URL:-http://nginx}
LOAD_SCRIPT=${LOAD_SCRIPT:-load-test/orders-500.js}

run_one() {
  local label="$1"
  local strategy="$2"
  local concurrency="$3"
  # 4th arg overrides the pool so it can be varied on its own. Without it the
  # pool tracks concurrency, which is the right default but useless for
  # answering "is the pool the bottleneck?" — both move together and the
  # effect of each cannot be separated.
  local pool="${4:-$((concurrency + 2))}"

  echo ""
  echo "############ $label ############"

  ./load-test/reset.sh > /dev/null

  echo "==> restarting worker: strategy=$strategy concurrency=$concurrency pool=$pool"
  STOCK_CLAIM_STRATEGY="$strategy" \
  WORKER_CONCURRENCY="$concurrency" \
  DB_POOL_MAX="$pool" \
    docker compose up -d --force-recreate --no-deps worker
  sleep 5

  echo "==> load"
  # Driven from the compose network, not the host. A sweep exists to compare
  # configurations, so the load generator must not be the thing that varies:
  # from a Windows host ~20% of connections are refused by Docker Desktop's
  # port forwarder, and that share moves with how fast the system replies —
  # which would show up as a difference between configurations that is really
  # just the client giving up.
  MSYS_NO_PATHCONV=1 docker compose --profile loadtest run --rm \
    -e BASE_URL="$BASE_URL" -e RAMP=0s \
    -e OUT="/scripts/results/sweep-${label//\//-}.json" \
    k6 "/scripts/$(basename "$LOAD_SCRIPT")" > /dev/null 2>&1 || true

  echo "==> waiting for drain"
  for _ in $(seq 1 90); do
    pending=$(docker compose exec -T redis sh -lc \
      "redis-cli eval \"return redis.call('LLEN','bull:orders:wait') + redis.call('LLEN','bull:orders:active')\" 0" \
      2>/dev/null | tr -d '\r')
    [ "$pending" = "0" ] && break
    sleep 2
  done
  sleep 2

  echo "==> measure"
  STOCK_CLAIM_STRATEGY="$strategy" WORKER_CONCURRENCY="$concurrency" DB_POOL_MAX="$pool" \
    node load-test/measure.js --csv "$OUT" --label "$label"

  echo "==> integrity"
  docker compose exec -T postgres psql -U "${DB_USERNAME:-postgres}" -d "${DB_DATABASE:-flash_sale}" -c \
    "SELECT remaining_stock, (SELECT count(*) FROM orders WHERE product_id='p-1001') AS orders,
            (SELECT count(DISTINCT user_id) FROM orders WHERE product_id='p-1001') AS uniq
       FROM products WHERE id='p-1001';"
}

case "$MODE" in
  strategy)
    for s in pessimistic optimistic atomic; do
      run_one "$s/c${WORKER_CONCURRENCY:-10}" "$s" "${WORKER_CONCURRENCY:-10}"
    done
    ;;
  concurrency)
    S=${STOCK_CLAIM_STRATEGY:-pessimistic}
    for c in 1 2 4 8 16 32; do
      run_one "$S/c$c" "$S" "$c"
    done
    ;;
  pool)
    # Concurrency pinned, pool varied — starved, matched, over-provisioned.
    S=${STOCK_CLAIM_STRATEGY:-pessimistic}
    C=${WORKER_CONCURRENCY:-10}
    for p in 2 4 6 12 24 48; do
      run_one "$S/c$C/pool$p" "$S" "$C" "$p"
    done
    ;;
  *)
    echo "usage: $0 [strategy|concurrency|pool]" >&2
    exit 1
    ;;
esac

echo ""
echo "sweep complete -> $OUT"
column -s, -t < "$OUT" 2>/dev/null || cat "$OUT"
