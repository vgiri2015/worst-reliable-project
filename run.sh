#!/usr/bin/env bash
# =============================================================================
#  run.sh — boots the entire circus with one command.
#    ./run.sh            # app (chaos 7) + customer swarm
#    CHAOS_LEVEL=10 ./run.sh
#    ./run.sh --no-swarm # app only
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
CHAOS_LEVEL="${CHAOS_LEVEL:-7}"
USERS="${USERS:-25}"
RPM="${RPM:-12}"
INSTALL_TIMEOUT_SECONDS="${INSTALL_TIMEOUT_SECONDS:-120}"

for name in PORT CHAOS_LEVEL USERS RPM INSTALL_TIMEOUT_SECONDS; do
  value="${!name}"
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    printf '{"level":"error","message":"[tomo-id-001] Invalid numeric configuration","config_key":"%s","config_value":"%s","action":"set a positive integer and retry"}\n' "$name" "$value" >&2
    exit 64
  fi
done

if (( PORT < 1 || PORT > 65535 )); then
  printf '{"level":"error","message":"[tomo-id-002] Invalid port configuration","port":%s,"action":"set PORT between 1 and 65535"}\n' "$PORT" >&2
  exit 64
fi

if (( USERS > 100 || RPM > 120 )); then
  printf '{"level":"error","message":"[tomo-id-003] Unsafe load-generator configuration rejected","users":%s,"rpm":%s,"action":"set USERS<=100 and RPM<=120 or run --no-swarm"}\n' "$USERS" "$RPM" >&2
  exit 64
fi

printf '{"level":"info","message":"[tomo-id-004] Installing dependencies if needed","timeout_seconds":%s}\n' "$INSTALL_TIMEOUT_SECONDS"
if ! timeout "$INSTALL_TIMEOUT_SECONDS" npm install --silent >/dev/null 2>&1; then
  printf '{"level":"warn","message":"[tomo-id-005] Silent dependency install failed or timed out; retrying with visible output","timeout_seconds":%s}\n' "$INSTALL_TIMEOUT_SECONDS" >&2
  timeout "$INSTALL_TIMEOUT_SECONDS" npm install
fi

# Free the port if something's already squatting on it.
if lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "Port $PORT busy — killing the old victim..."
  kill "$(lsof -ti:"$PORT")" 2>/dev/null || true
  sleep 1
fi

PIDS=()
cleanup() {
  echo ""
  echo "Shutting down the disaster..."
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  pkill -f load_generator.js 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

echo "Launching app on :$PORT (chaos $CHAOS_LEVEL)..."
CHAOS_LEVEL="$CHAOS_LEVEL" PORT="$PORT" node backend/server.js &
PIDS+=($!)

sleep 2

if [[ "${1:-}" != "--no-swarm" ]]; then
  echo "Unleashing $USERS simulated customers ($RPM req/min each)..."
  TARGET="http://localhost:$PORT" USERS="$USERS" RPM="$RPM" node backend/load_generator.js &
  PIDS+=($!)
fi

echo ""
echo "=================================================================="
echo "  App:        http://localhost:$PORT"
echo "  Dashboard:  http://localhost:$PORT/dashboard.html"
echo "  Museum API: http://localhost:$PORT/api/museum"
echo "  Ctrl-C to stop everything."
echo "=================================================================="

wait
