#!/bin/bash
# Adam iter 22 (2026-05-03) — FDA workaround wrapper.
# Lives in /Users/Shared (NOT FDA-restricted) so launchd-bash can read it.
# Sources .env-secrets (also in /Users/Shared, mode 600) for webhook secret.
# Python reads its own .env via pydantic-settings (separate code path).
set -euo pipefail

REPO=/Users/wekruitclaw1/Desktop/WeKruit/wekruit-matching
cd "$REPO"

# Source secrets (FDA-safe path).
if [[ -f /Users/Shared/wekruit/.env-secrets ]]; then
  set -a
  source /Users/Shared/wekruit/.env-secrets
  set +a
fi

STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PIPELINE_LOG="/tmp/wekruit-matching-daily-$(date -u +%Y%m%d-%H%M%S).log"


if perl -e "alarm shift; exec { \$ARGV[0] } @ARGV" 14400 .venv/bin/python -m wekruit_matching.pipeline.daily 2>&1 | tee "$PIPELINE_LOG"; then
  STATUS="success"
  PIPELINE_RC=0
else
  STATUS="failed"
  PIPELINE_RC=$?
fi

FINISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

JOBS_SCRAPED="$(grep -oE "jobsScraped[: =][0-9]+" "$PIPELINE_LOG" | tail -1 | grep -oE "[0-9]+" || echo 0)"
JOBS_NEW="$(grep -oE "jobsNew[: =][0-9]+" "$PIPELINE_LOG" | tail -1 | grep -oE "[0-9]+" || echo 0)"
JOBS_UPDATED="$(grep -oE "jobsUpdated[: =][0-9]+" "$PIPELINE_LOG" | tail -1 | grep -oE "[0-9]+" || echo 0)"
JOBS_ERRORED="$(grep -oE "jobsErrored[: =][0-9]+" "$PIPELINE_LOG" | tail -1 | grep -oE "[0-9]+" || echo 0)"

ERROR_MSG=""
[[ "$STATUS" == "failed" ]] && ERROR_MSG="pipeline_exit_${PIPELINE_RC}"

/Users/Shared/wekruit/post-pipeline-webhook.sh "$STATUS" "$STARTED" "$FINISHED" "$JOBS_SCRAPED" "$JOBS_NEW" "$JOBS_UPDATED" "$JOBS_ERRORED" 0 SimplifyJobs "$ERROR_MSG" || true

exit $PIPELINE_RC
