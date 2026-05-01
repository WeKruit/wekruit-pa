#!/usr/bin/env bash
# Stream H4 D4 — failure observability alert setup.
#
# This script is for ADAM to eyeball + run manually. It is NOT executed by
# CI or the H4 P7 agent. Adam: review the gcloud commands below, fill in
# the placeholders ({EMAIL}, {NOTIFICATION_CHANNEL_ID}), and run them.
#
# What it sets up:
#   1) A Cloud Logging log-based metric counting `pa.outbound.failed`
#      ERROR-severity entries from paSendblueOutbox.
#   2) An alerting policy that triggers when > 5 such events occur in
#      any rolling 5-minute window.
#   3) Email notification to developers@wekruit.com.
#
# Reference: https://cloud.google.com/logging/docs/logs-based-metrics
# Reference: https://cloud.google.com/monitoring/alerts/using-alerting-api

set -euo pipefail

PROJECT_ID="wekruit-5f89b"
METRIC_NAME="pa_outbound_failed"
ALERT_NAME="pa-outbound-failure-spike"
ALERT_EMAIL="developers@wekruit.com"

echo "=========================================="
echo "Stream H4 D4 — Failure-alert setup"
echo "Project: $PROJECT_ID"
echo "=========================================="

# --- Step 1: Create the log-based metric --------------------------------
# Filter matches the structured log emitted by logOutboundFailure() in
# apps/functions/src/sendblue/outbox.ts. firebase-functions/logger.error
# with a structured payload lands as severity=ERROR with the payload merged
# into jsonPayload.
#
# NOTE: depending on logger implementation, the log message may appear as
# either jsonPayload.message="pa.outbound.failed" OR
# textPayload="pa.outbound.failed". The OR-filter below covers both.

cat <<METRIC_CMD
# Step 1 — create log-based metric
gcloud logging metrics create ${METRIC_NAME} \\
  --project=${PROJECT_ID} \\
  --description="Count of pa.outbound.failed structured ERROR logs from paSendblueOutbox" \\
  --log-filter='resource.type="cloud_function" AND resource.labels.function_name="paSendblueOutbox" AND severity="ERROR" AND (jsonPayload.message="pa.outbound.failed" OR textPayload:"pa.outbound.failed")'
METRIC_CMD

echo ""
echo "After running step 1, list notification channels to find an email channel:"
echo ""
cat <<CHAN_CMD
# Step 2a — list channels (pick the one for ${ALERT_EMAIL}; copy its name)
gcloud alpha monitoring channels list \\
  --project=${PROJECT_ID} \\
  --filter='type="email" AND labels.email_address="${ALERT_EMAIL}"' \\
  --format='value(name)'

# Step 2b — if no channel exists, create one:
gcloud alpha monitoring channels create \\
  --project=${PROJECT_ID} \\
  --display-name="developers@wekruit.com (alerts)" \\
  --type=email \\
  --channel-labels=email_address=${ALERT_EMAIL}
CHAN_CMD

echo ""
echo "Step 3 — create alert policy. Replace {NOTIFICATION_CHANNEL_ID} with the value from step 2."
echo ""
cat <<'POLICY_CMD'
# Step 3 — create the alert policy via JSON descriptor (gcloud alpha)
# Save the YAML below to /tmp/pa-outbound-alert.yaml then apply.

cat > /tmp/pa-outbound-alert.yaml <<'YAML'
displayName: pa-outbound-failure-spike
combiner: OR
conditions:
  - displayName: ">5 pa.outbound.failed in 5min"
    conditionThreshold:
      filter: 'metric.type="logging.googleapis.com/user/pa_outbound_failed" AND resource.type="cloud_function"'
      aggregations:
        - alignmentPeriod: 60s
          perSeriesAligner: ALIGN_RATE
      comparison: COMPARISON_GT
      thresholdValue: 5
      duration: 300s
notificationChannels:
  - {NOTIFICATION_CHANNEL_ID}
documentation:
  content: |
    pa-outbound has failed more than 5 messages in the last 5 minutes.
    Check Cloud Logging for severity=ERROR jsonPayload.message="pa.outbound.failed".
    Pull body_preview, lastError, and userId from the log payload to triage.
  mimeType: text/markdown
YAML

gcloud alpha monitoring policies create \
  --project=wekruit-5f89b \
  --policy-from-file=/tmp/pa-outbound-alert.yaml
POLICY_CMD

echo ""
echo "=========================================="
echo "Done. Adam: review and run the steps above"
echo "to provision the metric + alert in GCP."
echo "=========================================="
