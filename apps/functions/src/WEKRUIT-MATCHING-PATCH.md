# WEKRUIT-MATCHING-PATCH — Mac mini → paMatchingPipelineComplete bridge

**For**: `/Users/wekruitclaw1/Desktop/WeKruit/wekruit-matching/` on the Mac mini.
**When**: After v1.5 Stream-A2 / Phase 47.1 ships (paMatchingPipelineComplete CF + flag flipped on).
**Why**: Closes the loop — every daily-update completion notifies wekruit-pa.

This file lives in `apps/functions/src/` because the deployed CF code lives next door (`matching-pipeline-complete.ts`); the patch must be applied **manually on the Mac mini** by an operator with shell access (Adam). Claude Code in this repo cannot ssh.

The flat handler path (`apps/functions/src/matching-pipeline-complete.ts` rather than the brief's `apps/functions/src/upstream/`) matches the existing `upstream-event-webhook.ts` neighbour — kept intentionally to avoid spurious dir creation.

---

## 1. Add `scripts/post-pipeline-webhook.sh`

Drop this file into `/Users/wekruitclaw1/Desktop/WeKruit/wekruit-matching/scripts/post-pipeline-webhook.sh` and `chmod +x` it.

```bash
#!/bin/bash
# post-pipeline-webhook.sh
# Called by daily-update.sh after the python pipeline exits. Posts a signed
# JSON body to wekruit-pa's paMatchingPipelineComplete CF.
#
# Args (all positional, in this order):
#   $1 = status (success | failed | partial)
#   $2 = scrapeStartedAt ISO8601
#   $3 = scrapeFinishedAt ISO8601
#   $4 = jobsScraped (int, 0 if unknown)
#   $5 = jobsNew (int, 0 if unknown)
#   $6 = jobsUpdated (int, 0 if unknown)
#   $7 = jobsErrored (int, 0 if unknown)
#   $8 = costUsd (float, 0 if unknown)
#   $9 = sourceRepos (comma-separated, e.g. "SimplifyJobs")
#   $10 = error (string, optional — only on failed)
#   $11 = runId (string, optional — generated if omitted)

set -euo pipefail

WEBHOOK_URL="${PA_MATCHING_WEBHOOK_URL:-https://us-central1-wekruit-5f89b.cloudfunctions.net/paMatchingPipelineComplete}"
SECRET="${PA_MATCHING_WEBHOOK_SECRET:-}"

if [[ -z "$SECRET" ]]; then
  echo "[post-pipeline-webhook] PA_MATCHING_WEBHOOK_SECRET unset — skipping (no-op)" >&2
  exit 0  # fail-open: cron must not break
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

# Convert CSV → JSON array
SOURCES_JSON="[$(echo "$SOURCES_CSV" | sed 's/[^,][^,]*/"&"/g')]"

# Build JSON body. Use python for safe escaping of error string.
BODY=$(python3 -c "
import json, sys
print(json.dumps({
    'runId': '$RUN_ID',
    'status': '$STATUS',
    'scrapeStartedAt': '$STARTED',
    'scrapeFinishedAt': '$FINISHED',
    'jobsScraped': int('$JOBS_SCRAPED'),
    'jobsNew': int('$JOBS_NEW'),
    'jobsUpdated': int('$JOBS_UPDATED'),
    'jobsErrored': int('$JOBS_ERRORED'),
    'costUsd': float('$COST_USD'),
    'sourceRepos': $SOURCES_JSON,
    'error': '$ERROR_MSG' if '$ERROR_MSG' else None,
}))
")

# Timestamp in epoch ms
TS_MS=$(python3 -c 'import time; print(int(time.time()*1000))')

# HMAC-SHA256 (hex) of body with secret
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')

# POST. Capture HTTP status; never abort on non-2xx (cron must continue).
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
exit 0  # always exit 0 — webhook failure must not fail the cron run
```

---

## 2. Modify `scripts/daily-update.sh`

**Current** (verified in /tmp/wekruit-matching/scripts/daily-update.sh on 2026-05-02):

```bash
#!/bin/bash
# Daily job pipeline: scrape, enrich, embed + email notifications
# Runs via launchd at 6 AM CDT daily
cd /Users/wekruitclaw1/Desktop/WeKruit/wekruit-matching

.venv/bin/python -m wekruit_matching.pipeline.daily
```

**Replace with**:

```bash
#!/bin/bash
# Daily job pipeline: scrape, enrich, embed + email notifications
# Runs via launchd at 6 AM CDT daily.
# v1.5 Stream-A2: post-pipeline webhook to wekruit-pa.

cd /Users/wekruitclaw1/Desktop/WeKruit/wekruit-matching

# Load secret + URL from .env (sources both PA_MATCHING_WEBHOOK_SECRET
# and optionally PA_MATCHING_WEBHOOK_URL).
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PIPELINE_LOG="/tmp/wekruit-matching-daily-$(date -u +%Y%m%d-%H%M%S).log"

# Run python pipeline. Capture exit code + tail of log for stats.
if .venv/bin/python -m wekruit_matching.pipeline.daily 2>&1 | tee "$PIPELINE_LOG"; then
  PIPELINE_RC=0
  STATUS="success"
else
  PIPELINE_RC=$?
  STATUS="failed"
fi

FINISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Best-effort stats extraction. The python pipeline's daily summary email
# already prints these counts to stdout; grep them out. If parsing fails
# the values default to 0 and the run doc still records the timestamps.
JOBS_SCRAPED="$(grep -oE 'jobsScraped[: =][0-9]+' "$PIPELINE_LOG" | tail -1 | grep -oE '[0-9]+' || echo 0)"
JOBS_NEW="$(grep -oE 'jobsNew[: =][0-9]+' "$PIPELINE_LOG" | tail -1 | grep -oE '[0-9]+' || echo 0)"
JOBS_UPDATED="$(grep -oE 'jobsUpdated[: =][0-9]+' "$PIPELINE_LOG" | tail -1 | grep -oE '[0-9]+' || echo 0)"
JOBS_ERRORED="$(grep -oE 'jobsErrored[: =][0-9]+' "$PIPELINE_LOG" | tail -1 | grep -oE '[0-9]+' || echo 0)"
COST_USD="$(grep -oE 'costUsd[: =][0-9.]+' "$PIPELINE_LOG" | tail -1 | grep -oE '[0-9.]+' || echo 0)"

ERROR_MSG=""
if [[ "$STATUS" == "failed" ]]; then
  ERROR_MSG="pipeline_exit_${PIPELINE_RC}"
fi

# Fire webhook (always — fail-open if secret unset).
scripts/post-pipeline-webhook.sh \
  "$STATUS" \
  "$STARTED" \
  "$FINISHED" \
  "$JOBS_SCRAPED" \
  "$JOBS_NEW" \
  "$JOBS_UPDATED" \
  "$JOBS_ERRORED" \
  "$COST_USD" \
  "SimplifyJobs" \
  "$ERROR_MSG" \
  || true

exit $PIPELINE_RC
```

**Field-name note**: the bash log greps assume the python pipeline prints lines containing `jobsNew=12` (etc.) at the end of its run. If the actual format differs, adjust the regexes — the webhook still fires with zeros and the `pa-matching-pipeline-runs/{runId}` doc records the timestamps either way. (For an even cleaner version, modify `pipeline/daily.py` to write a `/tmp/wekruit-matching-stats.json` file and have this bash read it with `jq`.)

---

## 3. Add to `.env`

Append to `/Users/wekruitclaw1/Desktop/WeKruit/wekruit-matching/.env`:

```
# v1.5 Stream-A2 — wekruit-pa pipeline-complete webhook
PA_MATCHING_WEBHOOK_SECRET=<paste the same value used for `firebase functions:secrets:set PA_MATCHING_WEBHOOK_SECRET`>
# Optional override (defaults to prod URL):
# PA_MATCHING_WEBHOOK_URL=https://us-central1-wekruit-5f89b.cloudfunctions.net/paMatchingPipelineComplete
```

Make sure `.env` is `chmod 600`.

---

## 4. Verify on the Mac mini

After applying the patch, run a manual smoke before relying on the 6am cron:

```bash
# Generate a test secret (don't actually use this — use the prod secret already
# in Firebase Secret Manager + .env).
cd /Users/wekruitclaw1/Desktop/WeKruit/wekruit-matching
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PA_MATCHING_WEBHOOK_SECRET="$(grep '^PA_MATCHING_WEBHOOK_SECRET=' .env | cut -d= -f2-)" \
  scripts/post-pipeline-webhook.sh \
  success "$NOW" "$NOW" 0 0 0 0 0 SimplifyJobs "" "smoke-$(date +%s)"
# Expect: [post-pipeline-webhook] runId=smoke-... status=success http=200
```

Then check Firestore in console:
- `pa-matching-pipeline-runs/smoke-…` should exist with `status:"success"`.
- `pa-matching-pipeline-rate/SimplifyJobs__hour-…` should have `count:1`.

---

## 5. Rollback

If the webhook starts misbehaving:
1. Flip flag off via dashboard / firebase console: `pa-remote-config/paMatchingPipelineWebhookEnabled.value = false`.
   - CF will return 503 `feature_disabled`. The bash `post-pipeline-webhook.sh` ignores non-200 and exits 0, so cron continues uninterrupted.
2. Or remove the call from `daily-update.sh` (revert section 2). Cron still runs the python pipeline; only the notification is dropped.
