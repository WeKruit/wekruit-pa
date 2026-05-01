#!/usr/bin/env bash
# Phase 39 — fill remaining 13 matrix cells (3 arms × 5 benchmarks minus 2 already done).
# Sequential to avoid SiliconFlow rate-limits. Logs each arm separately.

set -u
cd "$(dirname "$0")/../../.."

LOG_DIR="apps/eval/external-benchmarks/logs"
mkdir -p "$LOG_DIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)

# Load .env keys (skip JSON-valued lines)
export SILICONFLOW_API_KEY=$(grep '^SILICONFLOW_API_KEY=' .env | cut -d= -f2-)
export OPENAI_API_KEY=$(grep '^OPENAI_API_KEY=' .env | cut -d= -f2-)
export PA_OPENAI_AGENT_API_KEY=$(grep '^PA_OPENAI_AGENT_API_KEY=' .env | cut -d= -f2-)

if [ -z "$SILICONFLOW_API_KEY" ]; then echo "FATAL: SILICONFLOW_API_KEY missing" >&2; exit 1; fi

echo "[matrix] start ts=$TS sf_key=${SILICONFLOW_API_KEY:0:10}.. oai_key=${OPENAI_API_KEY:0:10}.."

run_arm() {
  local arm="$1"
  local only="$2"
  local log="$LOG_DIR/run-${arm}-${TS}.log"
  echo "[matrix] arm=$arm only=$only log=$log start=$(date -u +%FT%TZ)"
  if [ -n "$only" ]; then
    node apps/eval/external-benchmarks/run-all.mjs --arm="$arm" --only="$only" --live > "$log" 2>&1
  else
    node apps/eval/external-benchmarks/run-all.mjs --arm="$arm" --live > "$log" 2>&1
  fi
  local ec=$?
  echo "[matrix] arm=$arm exit=$ec end=$(date -u +%FT%TZ)"
  return $ec
}

# Cell 1: claire-stack remaining 3 (esconv + empathetic-dialogues + role-llm)
run_arm claire-stack "esconv,empathetic-dialogues,role-llm" || echo "[matrix] claire-stack PARTIAL FAIL"

# Cell 2: qwen-7b-raw all 5 (cheapest baseline arm)
run_arm qwen-7b-raw "" || echo "[matrix] qwen-7b-raw PARTIAL FAIL"

# Cell 3: qwen-72b-raw all 5 (most expensive but bounded ≤ $1.80)
run_arm qwen-72b-raw "" || echo "[matrix] qwen-72b-raw PARTIAL FAIL"

echo "[matrix] all done ts_end=$(date -u +%FT%TZ)"
ls -la apps/eval/external-benchmarks/results/
