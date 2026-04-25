#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WORKER_DIR="$ROOT/apps/macos-imessage-worker"
DASH_DIR="$ROOT/apps/dashboard-web"

ROOT_ENV="$ROOT/.env"
WORKER_ENV="$WORKER_DIR/.env"
DASH_ENV="$DASH_DIR/.env.local"

print() { printf "\n%s\n" "$*"; }
die() { printf "\n[error] %s\n" "$*" >&2; exit 1; }

ensure_file_from_template() {
  local file="$1"
  local template="$2"
  if [[ -f "$file" ]]; then return 0; fi
  if [[ ! -f "$template" ]]; then
    die "Missing template: $template"
  fi
  cp "$template" "$file"
  print "[setup] Created $file from template. Fill it, then re-run."
}

require_env_set_in_file() {
  local file="$1"
  local key="$2"
  if ! grep -qE "^[[:space:]]*$key=" "$file"; then
    die "Missing $key in $file"
  fi
}

cleanup() {
  print "[dev] Stopping processes..."
  if [[ -n "${DASH_PID:-}" ]]; then kill "$DASH_PID" 2>/dev/null || true; fi
  if [[ -n "${ORCH_PID:-}" ]]; then kill "$ORCH_PID" 2>/dev/null || true; fi
  if [[ -n "${WORKER_PID:-}" ]]; then kill "$WORKER_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

free_port() {
  local port="$1"
  local label="$2"
  local pids=""
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then return 0; fi
  print "[dev] $label port $port is already in use; stopping stale local process(es): $pids"
  # This script owns the local PA dev loop. Freeing the fixed dev ports avoids stale Vite/worker processes
  # serving old environment values.
  kill $pids 2>/dev/null || true
  sleep 1
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    print "[dev] $label port $port still busy; force-stopping: $pids"
    kill -9 $pids 2>/dev/null || true
    sleep 1
  fi
}

assert_running() {
  local pid="$1"
  local label="$2"
  local log_file="$3"
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    print "[error] $label failed to start. Log follows:"
    sed -n '1,160p' "$log_file" 2>/dev/null || true
    exit 1
  fi
}

print "WeKruit PA local macOS dev runner"
print "Repo: $ROOT"

ensure_file_from_template "$WORKER_ENV" "$WORKER_DIR/.env.template"
ensure_file_from_template "$ROOT_ENV" "$ROOT/.env.template"
ensure_file_from_template "$DASH_ENV" "$DASH_DIR/.env.local.template"

# Minimal sanity checks
require_env_set_in_file "$WORKER_ENV" "USE_PLATFORM_FIREBASE"
require_env_set_in_file "$WORKER_ENV" "PA_BROKER_MODE"
require_env_set_in_file "$WORKER_ENV" "PA_HEALTH_PORT"

validate_firebase_admin_env() {
  local file="$1"
  local label="$2"
  local gac=""
  gac="$(grep -E "^[[:space:]]*GOOGLE_APPLICATION_CREDENTIALS=" "$file" | tail -n 1 | cut -d= -f2- || true)"
  gac="${gac//$'\r'/}"
  gac="${gac#"${gac%%[![:space:]]*}"}" # ltrim
  gac="${gac%"${gac##*[![:space:]]}"}" # rtrim
  gac="${gac%\"}"
  gac="${gac#\"}"
  gac="${gac%\'}"
  gac="${gac#\'}"
  local sa_line=""
  sa_line="$(grep -E "^[[:space:]]*FIREBASE_SERVICE_ACCOUNT_JSON=" "$file" | tail -n 1 || true)"
  local sa_json=""
  sa_json="$(printf "%s" "$sa_line" | cut -d= -f2- || true)"

  if [[ -n "$gac" ]]; then
    if [[ ! -f "$gac" ]]; then
      die "$label: GOOGLE_APPLICATION_CREDENTIALS points to missing file: $gac"
    fi
    return 0
  fi
  if [[ -n "$sa_json" ]]; then
    # Support multiline single-quoted JSON blocks in dotenv files (first line often looks like: FIREBASE_SERVICE_ACCOUNT_JSON='{)
    # Do not attempt to parse/trim; just fail on explicit empty assignment.
    local trimmed="$sa_json"
    trimmed="${trimmed//$'\r'/}"
    trimmed="${trimmed#"${trimmed%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    if [[ "$trimmed" == "" || "$trimmed" == "''" || "$trimmed" == "\"\"" ]]; then
      die "$label: FIREBASE_SERVICE_ACCOUNT_JSON is set but empty in $file"
    fi
    return 0
  fi
  die "$label: set GOOGLE_APPLICATION_CREDENTIALS (path) or FIREBASE_SERVICE_ACCOUNT_JSON (inline JSON) in $file"
}

validate_firebase_admin_env "$WORKER_ENV" "worker"

require_env_set_in_file "$ROOT_ENV" "PA_ORCHESTRATOR_POLL_MS"
require_env_set_in_file "$ROOT_ENV" "PA_RATE_LIMIT_PER_WINDOW"
require_env_set_in_file "$ROOT_ENV" "PA_RATE_LIMIT_WINDOW_MS"

if ! grep -qE "^(GOOGLE_APPLICATION_CREDENTIALS|FIREBASE_SERVICE_ACCOUNT_JSON)=" "$ROOT_ENV"; then
  die "Orchestrator env must set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON in $ROOT_ENV"
fi
validate_firebase_admin_env "$ROOT_ENV" "orchestrator"

print "[dev] Installing dependencies..."
cd "$ROOT"
npm install >/dev/null

print "[dev] Building shared packages..."
npm run build >/dev/null

print "[dev] Checking worker Firestore Admin access..."
DOTENV_CONFIG_PATH="$WORKER_ENV" node -r dotenv/config "$ROOT/scripts/check-firestore-admin.mjs"

print "[dev] Checking orchestrator Firestore Admin access..."
DOTENV_CONFIG_PATH="$ROOT_ENV" node -r dotenv/config "$ROOT/scripts/check-firestore-admin.mjs"

HOST="${PA_DASHBOARD_HOST:-localhost}"
PORT="${PA_DASHBOARD_PORT:-5173}"
HEALTH_PORT="$(grep -E "^[[:space:]]*PA_HEALTH_PORT=" "$WORKER_ENV" | tail -n 1 | cut -d= -f2- || true)"
HEALTH_PORT="${HEALTH_PORT:-8787}"
free_port "$PORT" "Dashboard"
free_port "$HEALTH_PORT" "Worker health"

print "[dev] Starting Dashboard (Vite dev server)..."
cd "$DASH_DIR"
npm run dev -- --host "$HOST" --port "$PORT" --strictPort >/tmp/wekruit-pa-dashboard.log 2>&1 &
DASH_PID=$!
assert_running "$DASH_PID" "Dashboard" "/tmp/wekruit-pa-dashboard.log"

print "[dev] Starting Mac worker (channel adapter)..."
cd "$WORKER_DIR"
DOTENV_CONFIG_PATH="$WORKER_ENV" npm run start >/tmp/wekruit-pa-worker.log 2>&1 &
WORKER_PID=$!
assert_running "$WORKER_PID" "Mac worker" "/tmp/wekruit-pa-worker.log"

print "[dev] Starting Orchestrator (agent runtime)..."
cd "$ROOT"
DOTENV_CONFIG_PATH="$ROOT_ENV" npm run orchestrator >/tmp/wekruit-pa-orchestrator.log 2>&1 &
ORCH_PID=$!
assert_running "$ORCH_PID" "Orchestrator" "/tmp/wekruit-pa-orchestrator.log"

print "Running:"
print "- Dashboard: http://${HOST}:${PORT}"
print "- Worker health: http://127.0.0.1:${HEALTH_PORT}/health (change via PA_HEALTH_PORT)"
print ""
print "Logs:"
print "- dashboard: /tmp/wekruit-pa-dashboard.log"
print "- worker: /tmp/wekruit-pa-worker.log"
print "- orchestrator: /tmp/wekruit-pa-orchestrator.log"
print ""
print "Next test steps:"
print "- Dashboard → Agents: ensure default agent exists (seeded) and toolPolicy allowlist includes fake-echo."
print "- Dashboard → Operations: watch inbound/turn/outbound lifecycle."
print "- Send an iMessage DM to this Mac account; expect reply and Firestore rows."

wait

