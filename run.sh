#!/usr/bin/env bash
# =============================================================================
#  run.sh — boots the entire circus with one command.
#    ./run.sh                    # app (chaos 7) + customer swarm
#    CHAOS_LEVEL=10 ./run.sh
#    ./run.sh --no-swarm         # app only
#    ./run.sh --with-collector   # also start the OpenTelemetry Collector (docker,
#                                # from ../worst-pri-otel or $OTEL_STACK_DIR)
#    DOWNSTREAM_OTLP_ENDPOINT=http://host.docker.internal:5318 ./run.sh --with-collector
#                                # ...and forward all telemetry to another OTLP receiver
#    OTEL_SDK_DISABLED=true ./run.sh   # no telemetry at all
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
CHAOS_LEVEL="${CHAOS_LEVEL:-7}"
USERS="${USERS:-25}"
RPM="${RPM:-12}"
INSTALL_TIMEOUT_SECONDS="${INSTALL_TIMEOUT_SECONDS:-120}"
OTEL_COLLECTOR_HTTP_PORT="${OTEL_COLLECTOR_HTTP_PORT:-4318}"
OTEL_STACK_DIR="${OTEL_STACK_DIR:-../worst-pri-otel}"

SWARM=1
WITH_COLLECTOR=0
for arg in "$@"; do
  case "$arg" in
    --no-swarm) SWARM=0 ;;
    --with-collector) WITH_COLLECTOR=1 ;;
    *)
      printf '{"level":"error","message":"[tomo-id-006] Unknown argument","argument":"%s","action":"use --no-swarm and/or --with-collector"}\n' "$arg" >&2
      exit 64
      ;;
  esac
done

# OpenTelemetry JS SDK requires Node >= 22.15. Prefer the repo's .nvmrc via nvm.
if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1
  nvm use >/dev/null 2>&1 || true
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=15)?0:1)'; then
  printf '{"level":"error","message":"[tomo-id-007] Unsupported Node.js version","node_version":"%s","required":">=22.15","action":"run nvm install (reads .nvmrc) or install Node 22 LTS"}\n' "$(node -v 2>/dev/null || echo missing)" >&2
  exit 69
fi

# macOS has no coreutils `timeout`; fall back to gtimeout, then to no timeout.
if ! command -v timeout >/dev/null 2>&1; then
  if command -v gtimeout >/dev/null 2>&1; then
    timeout() { gtimeout "$@"; }
  else
    timeout() { shift; "$@"; }
  fi
fi

for name in PORT CHAOS_LEVEL USERS RPM INSTALL_TIMEOUT_SECONDS OTEL_COLLECTOR_HTTP_PORT; do
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
  printf '{"level":"warn","message":"[tomo-id-031] worst-pri-product/run.sh: port busy; terminating existing process","port":%s}\n' "$PORT"
  kill "$(lsof -ti:"$PORT")" 2>/dev/null || true
  sleep 1
fi

# --- OpenTelemetry ----------------------------------------------------------
export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:$OTEL_COLLECTOR_HTTP_PORT}"
export OTEL_EXPORTER_OTLP_PROTOCOL="${OTEL_EXPORTER_OTLP_PROTOCOL:-http/protobuf}"
export DEPLOYMENT_ENVIRONMENT="${DEPLOYMENT_ENVIRONMENT:-local}"

if (( WITH_COLLECTOR )); then
  if [[ ! -f "$OTEL_STACK_DIR/docker-compose.yml" ]]; then
    printf '{"level":"error","message":"[tomo-id-042] worst-pri-product/run.sh: collector stack not found","otel_stack_dir":"%s","action":"set OTEL_STACK_DIR to the worst-pri-otel folder"}\n' "$OTEL_STACK_DIR" >&2
    exit 66
  fi
  compose_files=(--project-directory "$OTEL_STACK_DIR" -f "$OTEL_STACK_DIR/docker-compose.yml")
  if [[ -n "${DOWNSTREAM_OTLP_ENDPOINT:-}" ]]; then
    compose_files+=(-f "$OTEL_STACK_DIR/docker-compose.downstream.yml")
  fi
  printf '{"level":"info","message":"[tomo-id-035] worst-pri-product/run.sh: starting OpenTelemetry Collector","downstream_endpoint":"%s"}\n' "${DOWNSTREAM_OTLP_ENDPOINT:-none}"
  if ! docker compose "${compose_files[@]}" up -d --force-recreate otel-collector >/dev/null; then
    printf '{"level":"error","message":"[tomo-id-036] worst-pri-product/run.sh: collector failed to start","action":"check that Docker is running, then (cd $OTEL_STACK_DIR && docker compose logs otel-collector)"}\n' >&2
    exit 69
  fi
  for _ in $(seq 1 30); do
    curl -fsS http://localhost:13133/ >/dev/null 2>&1 && break
    sleep 1
  done
  if ! curl -fsS http://localhost:13133/ >/dev/null 2>&1; then
    printf '{"level":"error","message":"[tomo-id-037] worst-pri-product/run.sh: collector not healthy after 30s","action":"(cd $OTEL_STACK_DIR && docker compose logs otel-collector)"}\n' >&2
    exit 69
  fi
elif [[ "${OTEL_SDK_DISABLED:-false}" != "true" ]] && ! curl -s -o /dev/null --max-time 2 "$OTEL_EXPORTER_OTLP_ENDPOINT/v1/traces" 2>/dev/null; then
  printf '{"level":"warn","message":"[tomo-id-038] worst-pri-product/run.sh: no OTLP receiver reachable; telemetry export will fail","otlp_endpoint":"%s","action":"re-run with --with-collector or set OTEL_SDK_DISABLED=true"}\n' "$OTEL_EXPORTER_OTLP_ENDPOINT" >&2
fi

PIDS=()
cleanup() {
  printf '\n'
  printf '{"level":"info","message":"[tomo-id-032] worst-pri-product/run.sh: shutdown requested","process_count":%s}\n' "${#PIDS[@]}"
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  # Give the node processes time to flush buffered telemetry to the collector.
  wait "${PIDS[@]:-}" 2>/dev/null || true
  if (( WITH_COLLECTOR )); then
    printf '{"level":"info","message":"[tomo-id-039] worst-pri-product/run.sh: collector left running","otel_stack_dir":"%s","action":"run docker compose down in otel_stack_dir to stop it; received data is in otel/data/ there"}\n' "$OTEL_STACK_DIR"
  fi
  exit 0
}
trap cleanup INT TERM

printf '{"level":"info","message":"[tomo-id-033] worst-pri-product/run.sh: launching app","port":%s,"chaos_level":%s}\n' "$PORT" "$CHAOS_LEVEL"
CHAOS_LEVEL="$CHAOS_LEVEL" PORT="$PORT" node backend/server.js &
PIDS+=($!)

sleep 2

if (( SWARM )); then
  printf '{"level":"info","message":"[tomo-id-034] worst-pri-product/run.sh: launching load generator","users":%s,"rpm":%s}\n' "$USERS" "$RPM"
  TARGET="http://localhost:$PORT" USERS="$USERS" RPM="$RPM" node backend/load_generator.js &
  PIDS+=($!)
fi

printf '{"level":"info","message":"[tomo-id-020] worst-pri-product/run.sh: services ready","app_url":"http://localhost:%s","dashboard_url":"http://localhost:%s/dashboard.html","museum_api_url":"http://localhost:%s/api/museum","otlp_endpoint":"%s","action":"press Ctrl-C to stop everything"}\n' "$PORT" "$PORT" "$PORT" "$OTEL_EXPORTER_OTLP_ENDPOINT"

wait
