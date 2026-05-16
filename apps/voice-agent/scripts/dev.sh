#!/usr/bin/env bash
# v2.1 S2 — local voice-agent dev launcher.
#
# Spins up the worker in dev mode pointing at the local voice-llm-shim.
# Assumes you have already started the shim (see apps/voice-llm-shim/README
# for `pnpm --filter @pa/voice-llm-shim dev`).

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here/.."

: "${WEKRUIT_LLM_SHIM_URL:=http://127.0.0.1:8787}"
: "${LIVEKIT_URL:=}"
: "${LIVEKIT_API_KEY:=}"
: "${LIVEKIT_API_SECRET:=}"
: "${DEEPGRAM_API_KEY:=}"

export PA_AGENT_RUNTIME_STREAM_ENABLED=true
export WEKRUIT_LLM_SHIM_URL
export LIVEKIT_URL
export LIVEKIT_API_KEY
export LIVEKIT_API_SECRET
export DEEPGRAM_API_KEY

echo "[voice-agent dev] WEKRUIT_LLM_SHIM_URL=$WEKRUIT_LLM_SHIM_URL"
echo "[voice-agent dev] LIVEKIT_URL=${LIVEKIT_URL:-<unset>}"

exec node --import tsx src/cli.ts start
