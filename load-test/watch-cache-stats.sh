#!/usr/bin/env bash
# Continuously polls GET /api/v1/cache/stats and appends every sample to a
# timestamped CSV log — a full timeline, not just a before/after snapshot.
#
# Meant to be started BEFORE another group (or anyone) starts hitting your
# system, so you have a record of hit/miss behavior across their whole run
# even though you don't control their load-test script.
#
#   bash load-test/watch-cache-stats.sh                # foreground, Ctrl+C to stop
#   bash load-test/watch-cache-stats.sh &               # background, keep using the shell
#   INTERVAL=1 bash load-test/watch-cache-stats.sh      # sample every 1s instead of 2s
#   BASE_URL=http://172.30.58.13:8080 bash load-test/watch-cache-stats.sh   # watch a different target
#
# Polling /api/v1/cache/stats is safe to run continuously: ProductCacheService
# .getStats() only reads counters (redis GET), it never increments cache:hits
# or cache:misses itself, so this script cannot skew the numbers it's logging.
set -euo pipefail

cd "$(dirname "$0")/.."

BASE_URL=${BASE_URL:-http://localhost:8080}
INTERVAL=${INTERVAL:-2}
LOG_DIR=${LOG_DIR:-load-test/logs}
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/cache-stats-$(date +%Y%m%d-%H%M%S).csv"

echo "timestamp,hits,misses,errors,hitRate,currentVersion,redisAvailable,hits_delta,misses_delta" > "$LOG_FILE"
echo "==> polling ${BASE_URL}/api/v1/cache/stats every ${INTERVAL}s"
echo "==> writing to $LOG_FILE"
echo "==> Ctrl+C to stop (log stays on disk either way)"
echo ""

prev_hits=0
prev_misses=0

trap 'echo ""; echo "stopped. log saved to $LOG_FILE"; exit 0' INT TERM

while true; do
  ts=$(date -u +%Y-%m-%dT%H:%M:%S)
  json=$(curl -s -m 3 "${BASE_URL}/api/v1/cache/stats" || true)

  if [ -z "$json" ]; then
    echo "$ts,,,,,,,,ERROR" >> "$LOG_FILE"
    echo "[$ts] unreachable"
  else
    hits=$(echo "$json" | grep -oE '"hits":[0-9]+' | grep -oE '[0-9]+' || echo 0)
    misses=$(echo "$json" | grep -oE '"misses":[0-9]+' | grep -oE '[0-9]+' || echo 0)
    errors=$(echo "$json" | grep -oE '"errors":[0-9]+' | grep -oE '[0-9]+' || echo 0)
    hitRate=$(echo "$json" | grep -oE '"hitRate":[0-9.]+' | grep -oE '[0-9.]+' || echo "")
    version=$(echo "$json" | grep -oE '"currentVersion":[0-9]+' | grep -oE '[0-9]+' || echo "")
    redisAvailable=$(echo "$json" | grep -oE '"redisAvailable":(true|false)' | grep -oE '(true|false)' || echo "")

    hits_delta=$((hits - prev_hits))
    misses_delta=$((misses - prev_misses))
    prev_hits=$hits
    prev_misses=$misses

    echo "$ts,$hits,$misses,$errors,$hitRate,$version,$redisAvailable,$hits_delta,$misses_delta" >> "$LOG_FILE"
    printf '[%s] hits=%-6s (+%-4s) misses=%-6s (+%-4s) hitRate=%-8s version=%s\n' \
      "$ts" "$hits" "$hits_delta" "$misses" "$misses_delta" "$hitRate" "$version"
  fi

  sleep "$INTERVAL"
done
