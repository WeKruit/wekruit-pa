#!/bin/bash
# Daily pipeline health check — runs at 09:00 CDT, 3hr after expected daily start (06:00).
# Phase 67 fixes:
#   - Case-insensitive grep so "Daily pipeline complete" (lowercase 'p') matches.
#   - Also checks /tmp/matching-daily-update.log (launchd stdout) as fallback.
#   - 26h staleness window — only auto-heal if NO recent successful run, not just "no log today".
#   - Auto-heal alerts via paUpstreamEventWebhook (POST) so PA orchestrator knows.
#   - Idempotent — won't kick second auto-heal if one is already in progress.
set -u
ALERT_URL="https://us-central1-wekruit-5f89b.cloudfunctions.net/paUpstreamEventWebhook"
LOCK_FILE="/tmp/wekruit-health-check.lock"
NOW_EPOCH=$(date +%s)
# 26 hours grace window — pipeline runs daily at 06:00, allow up to 32h before alarm.
GRACE_SECONDS=$((26 * 3600))

# Idempotency lock — skip if auto-heal kicked off in last 2h.
if [ -f "$LOCK_FILE" ]; then
  LOCK_EPOCH=$(stat -f %m "$LOCK_FILE" 2>/dev/null || echo 0)
  if [ $((NOW_EPOCH - LOCK_EPOCH)) -lt 7200 ]; then
    echo "[$(date)] auto-heal recently kicked (lock <2h old) — skipping"
    exit 0
  fi
fi

# Find most-recent pipeline log (across days, not just today).
LATEST=$(ls -t /tmp/wekruit-matching-daily-*.log 2>/dev/null | head -1)
HEALTHY=0

if [ -n "$LATEST" ]; then
  LATEST_EPOCH=$(stat -f %m "$LATEST" 2>/dev/null || echo 0)
  AGE=$((NOW_EPOCH - LATEST_EPOCH))

  # Match completion markers case-insensitively (-i).
  if grep -i -q -E 'Pipeline complete|Daily pipeline (complete|finished)|Stage 6|Stage 7' "$LATEST" 2>/dev/null; then
    if [ "$AGE" -lt "$GRACE_SECONDS" ]; then
      HEALTHY=1
    else
      echo "[$(date)] log $LATEST has completion marker but is ${AGE}s old (>26h)"
    fi
  else
    echo "[$(date)] log $LATEST exists but no completion marker found"
  fi
fi

# Also check launchd stdout log (single-file mode).
if [ "$HEALTHY" -eq 0 ] && [ -f /tmp/matching-daily-update.log ]; then
  LAUNCHD_LOG_EPOCH=$(stat -f %m /tmp/matching-daily-update.log 2>/dev/null || echo 0)
  LAUNCHD_AGE=$((NOW_EPOCH - LAUNCHD_LOG_EPOCH))
  if [ "$LAUNCHD_AGE" -lt "$GRACE_SECONDS" ]; then
    if grep -i -q -E 'Pipeline complete|Daily pipeline (complete|finished)' /tmp/matching-daily-update.log 2>/dev/null; then
      HEALTHY=1
      echo "[$(date)] healthy via /tmp/matching-daily-update.log (age=${LAUNCHD_AGE}s)"
    fi
  fi
fi

if [ "$HEALTHY" -eq 1 ]; then
  echo "[$(date)] healthy — pipeline ran successfully within 26h"
  exit 0
fi

echo "[$(date)] UNHEALTHY — no successful pipeline within 26h grace"

# Set lock to prevent rapid re-fire.
touch "$LOCK_FILE"

# POST alert to paUpstreamEventWebhook (FDA-safe — uses curl + system jq).
ALERT_BODY=$(/usr/bin/jq -n \
  --arg type "macmini.health.unhealthy" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg latestLog "${LATEST:-none}" \
  '{type:$type,ts:$ts,latestLog:$latestLog}')

curl -sS -m 10 -X POST "$ALERT_URL" \
  -H "Content-Type: application/json" \
  --data-binary "$ALERT_BODY" \
  -o /tmp/health-check-alert-resp.json -w "alert_http=%{http_code}\n" 2>&1 || true

# Auto-heal: kill any stuck procs + restart launchd
pkill -9 -f 'wekruit_matching.pipeline.daily' 2>/dev/null
launchctl bootout gui/$(id -u)/com.wekruit.daily-update 2>/dev/null
sleep 1
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.wekruit.daily-update.plist 2>/dev/null

# Kick a manual run via nohup
nohup /bin/bash /Users/Shared/wekruit/run-pipeline.sh >/tmp/auto-heal-${NOW_EPOCH}.log 2>&1 &
echo "[$(date)] auto-heal: killed stuck procs, bootstrapped launchd, kicked manual run pid $!"
exit 0
