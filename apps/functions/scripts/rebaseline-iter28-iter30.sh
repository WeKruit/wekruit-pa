#!/usr/bin/env bash
# iter30 final closure — re-baseline iter28-29 LLM-judge against deployed code.
# Per .planning/iter30/iter30-rebaseline-plan.md.
#
# Pass thresholds:
#   - vent-realistic: ≥ 0.93
#   - headhunter:     ≥ 0.86
#   - negotiation:    ≥ 0.86
#   - 30-turn drift:  0/30 AB-framework hits
set -euo pipefail
cd "$(dirname "$0")/../../.."

SA_JSON_RAW=$(grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' | sed "s/^'//" | sed "s/'$//")
SA_PATH=$(mktemp)
echo "$SA_JSON_RAW" > "$SA_PATH"
trap 'rm -f "$SA_PATH"' EXIT

OPENAI_KEY=$(grep -E "^PA_OPENAI_AGENT_API_KEY=" .env | sed 's/^PA_OPENAI_AGENT_API_KEY=//' | sed "s/^'//" | sed "s/'$//")

OUT_DIR="tests/scenarios/playbooks-iter30"
OUT_JSON="$OUT_DIR/baseline-post-iter30-final.json"
mkdir -p "$OUT_DIR"

echo "═══ iter30 REBASELINE ═══"
echo "out: $OUT_JSON"

GOOGLE_APPLICATION_CREDENTIALS="$SA_PATH" \
PA_RUN_EVAL=1 \
PA_OPENAI_AGENT_API_KEY="$OPENAI_KEY" \
node tests/scenarios/runner.mjs \
  tests/scenarios/playbooks-iter20/iter28-judge-vent-realistic.yaml \
  tests/scenarios/playbooks-iter20/iter28-judge-headhunter.yaml \
  tests/scenarios/playbooks-iter20/iter28-judge-negotiation.yaml \
  --json | tee "$OUT_JSON"

echo
echo "═══ LONG-CONTEXT 30-TURN DRIFT ═══"
GOOGLE_APPLICATION_CREDENTIALS="$SA_PATH" \
PA_RUN_EVAL=1 \
PA_OPENAI_AGENT_API_KEY="$OPENAI_KEY" \
node tests/scenarios/runner.mjs \
  tests/scenarios/playbooks-iter20/long-context-30turn-zh.yaml \
  --json | tee "$OUT_DIR/long-context-30turn-post-iter30.json"

echo
echo "DONE. Inspect $OUT_JSON for vent/headhunter/negotiation scores"
echo "and $OUT_DIR/long-context-30turn-post-iter30.json for drift."
