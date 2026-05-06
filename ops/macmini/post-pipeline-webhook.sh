#!/bin/bash
# v1.5 Stream-A2 — POST signed webhook to wekruit-pa after daily-update.sh
# Phase 67: replaced python3 with jq to avoid FDA PermissionError during launchd-spawned execution.
set -euo pipefail

WEBHOOK_URL="${PA_MATCHING_WEBHOOK_URL:-https://us-central1-wekruit-5f89b.cloudfunctions.net/paMatchingPipelineComplete}"
SECRET="${PA_MATCHING_WEBHOOK_SECRET:-}"

if [[ -z "$SECRET" ]]; then
  echo "[post-pipeline-webhook] PA_MATCHING_WEBHOOK_SECRET unset — skipping" >&2
  exit 0
fi

STATUS="${1:-failed}"
STARTED="${2:?scrapeStartedAt required}"
FINISHED="${3:?scrapeFinishedAt required}"
JOBS_SCRAPED="${4:-0}"
JOBS_NEW="${5:-0}"
JOBS_UPDATED="${6:-0}"
JOBS_ERRORED="${7:-0}"
COST_USD="${8:-0}"
SOURCES_CSV="${9:-SimplifyJobs}"
ERROR_MSG="${10:-}"
RUN_ID="${11:-$(uuidgen | tr '[:upper:]' '[:lower:]')}"

# Build sources JSON array via jq (FDA-safe — system /usr/bin/jq, no user-home path scan)
SOURCES_JSON=$(printf '%s' "$SOURCES_CSV" | /usr/bin/jq -R 'split(",")')

# Build full body JSON via jq
if [[ -n "$ERROR_MSG" ]]; then
  BODY=$(/usr/bin/jq -n \
    --arg runId "$RUN_ID" \
    --arg status "$STATUS" \
    --arg started "$STARTED" \
    --arg finished "$FINISHED" \
    --argjson jobsScraped "$JOBS_SCRAPED" \
    --argjson jobsNew "$JOBS_NEW" \
    --argjson jobsUpdated "$JOBS_UPDATED" \
    --argjson jobsErrored "$JOBS_ERRORED" \
    --argjson costUsd "$COST_USD" \
    --argjson sourceRepos "$SOURCES_JSON" \
    --arg error "$ERROR_MSG" \
    '{runId:$runId,status:$status,scrapeStartedAt:$started,scrapeFinishedAt:$finished,jobsScraped:$jobsScraped,jobsNew:$jobsNew,jobsUpdated:$jobsUpdated,jobsErrored:$jobsErrored,costUsd:$costUsd,sourceRepos:$sourceRepos,error:$error}')
else
  BODY=$(/usr/bin/jq -n \
    --arg runId "$RUN_ID" \
    --arg status "$STATUS" \
    --arg started "$STARTED" \
    --arg finished "$FINISHED" \
    --argjson jobsScraped "$JOBS_SCRAPED" \
    --argjson jobsNew "$JOBS_NEW" \
    --argjson jobsUpdated "$JOBS_UPDATED" \
    --argjson jobsErrored "$JOBS_ERRORED" \
    --argjson costUsd "$COST_USD" \
    --argjson sourceRepos "$SOURCES_JSON" \
    '{runId:$runId,status:$status,scrapeStartedAt:$started,scrapeFinishedAt:$finished,jobsScraped:$jobsScraped,jobsNew:$jobsNew,jobsUpdated:$jobsUpdated,jobsErrored:$jobsErrored,costUsd:$costUsd,sourceRepos:$sourceRepos,error:null}')
fi

# Timestamp in milliseconds via /bin/date (FDA-safe)
TS_MS=$(($(date +%s) * 1000))
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')

HTTP_CODE=$(curl -sS -o /tmp/pa-webhook-resp.json -w "%{http_code}" \
  -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "x-pa-signature: $SIG" \
  -H "x-pa-timestamp: $TS_MS" \
  --data-binary "$BODY" \
  --max-time 30 || echo "000")

echo "[post-pipeline-webhook] runId=$RUN_ID status=$STATUS http=$HTTP_CODE"
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "[post-pipeline-webhook] response: $(cat /tmp/pa-webhook-resp.json 2>/dev/null || echo '<no body>')" >&2
fi
exit 0
