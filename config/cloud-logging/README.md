# Cloud Logging / Monitoring dashboard

`dashboard.json` defines a 4-panel ops dashboard for the pa-* Cloud Functions
(Phase 32 Wave 4 deliverable).

## Panels

1. **Sendblue daily quota** — gauge of `sent_today` vs the
   `sendblueDailyQuota` flag value. Soft threshold at 80% (yellow); hard
   threshold at 100% (red, matches the in-CF `quota_hardblock` audit).
2. **Rate-limit hits** — line chart of `pa_audit_events` filtered to
   `type=rate_limit_exceeded`, last 24h, hourly buckets.
3. **Abuse signals** — line chart of `pa_abuse_events` grouped by `kind`
   (`rate_limit`, `injection`, `allowlist_deny`), last 24h.
4. **CF error rate** — stacked bar of non-`ok` execution status per
   `pa*` Cloud Function, last 1h. Surfaces silent 5xx leaks across the
   11 pa-* CFs.

## Import

```bash
gcloud monitoring dashboards create \
  --config-from-file=config/cloud-logging/dashboard.json \
  --project=wekruit-5f89b
```

To update an existing copy of the dashboard (after editing the JSON):

```bash
# 1. Find the dashboard ID
gcloud monitoring dashboards list --project=wekruit-5f89b \
  --filter='displayName:"PA Ops"' --format='value(name)'

# 2. Update by name (full resource path projects/.../dashboards/<id>)
gcloud monitoring dashboards update <full-resource-name> \
  --config-from-file=config/cloud-logging/dashboard.json \
  --project=wekruit-5f89b
```

## Required custom metrics

The `pa_audit_events` and `pa_abuse_events` metrics are user-defined log-based
counters. They must exist in the project before the dashboard renders.
Create them via:

```bash
# pa_audit_events — counter on logs from any pa* CF where the log payload
# contains `auditEvent.type` (recordAuditEvent in apps/functions/src/sendblue/audit.ts).
gcloud logging metrics create pa_audit_events \
  --project=wekruit-5f89b \
  --description='Counter for audit events emitted by recordAuditEvent' \
  --log-filter='resource.type="cloud_function" AND resource.labels.function_name=~"^pa" AND jsonPayload.auditEvent.type:*' \
  --label-extractors='type=EXTRACT(jsonPayload.auditEvent.type)'

# pa_abuse_events — counter on abuse-classified events (rate_limit / injection / allowlist_deny).
gcloud logging metrics create pa_abuse_events \
  --project=wekruit-5f89b \
  --description='Counter for abuse-classified events surfaced by pa* CFs' \
  --log-filter='resource.type="cloud_function" AND resource.labels.function_name=~"^pa" AND jsonPayload.abuseEvent.kind:*' \
  --label-extractors='kind=EXTRACT(jsonPayload.abuseEvent.kind)'

# pa_outbound_sent_daily — gauge for daily sent count (Phase 26 quota gate).
gcloud logging metrics create pa_outbound_sent_daily \
  --project=wekruit-5f89b \
  --description='Daily Sendblue outbound sent count (gauge)' \
  --log-filter='resource.type="cloud_function" AND resource.labels.function_name="paSendblueOutbox" AND jsonPayload.sentDailyCount:*' \
  --value-extractor='EXTRACT(jsonPayload.sentDailyCount)'
```

Adjust the log filter and extractor expressions to match the actual JSON
payload shape used by `recordAuditEvent` if it has changed since
2026-04-28.

## Validation

```bash
node -e 'JSON.parse(require("fs").readFileSync("config/cloud-logging/dashboard.json"))'
# (silent on success; throws on malformed JSON)
```
