# Cloud Logging — PA Productionization (Phase 26 T3)

Config-as-code for the Cloud Monitoring dashboard and alert policies that
back PA's prod observability. Adam (or whichever operator owns the GCP
project) applies these via `gcloud` after each merge — the artifacts in
this directory are the source of truth.

## Files

- `dashboard.json` — Cloud Monitoring dashboard. Four tiles:
  1. `onPaInbound` latency p50/p95.
  2. `paSendblueWebhook` latency p50/p95.
  3. Per-function error rate (status != ok).
  4. Daily LLM spend (log-based metric `pa.spend.daily`).
- `alert-policies.yaml` — alert policy that pages when daily LLM spend
  exceeds $10.

## One-time setup (per fresh GCP project)

The alert policy depends on a user-defined log-based metric. Create it
once before applying the policy:

```bash
gcloud logging metrics create pa.spend.daily \
  --description "PA daily LLM spend (USD) — emitted by cost-logger.ts" \
  --log-filter='resource.type="cloud_function" AND jsonPayload."pa.metric"="pa.spend.daily"' \
  --value-extractor='EXTRACT(jsonPayload.usd)' \
  --metric-descriptors='{"valueType":"DOUBLE","metricKind":"DELTA","unit":"USD"}' \
  --project=wekruit-5f89b
```

## Apply / re-apply on merge

```bash
# 1) Dashboard (idempotent — uses displayName as natural key)
gcloud monitoring dashboards create \
  --config-from-file=infra/cloud-logging/dashboard.json \
  --project=wekruit-5f89b

# 2) Alert policy (idempotent — gcloud diffs by displayName)
gcloud alpha monitoring policies create \
  --policy-from-file=infra/cloud-logging/alert-policies.yaml \
  --project=wekruit-5f89b

# 3) Wire notification channels (one-shot; pull existing IDs)
gcloud alpha monitoring channels list --project=wekruit-5f89b
# then patch the policy with the resulting channel IDs:
# gcloud alpha monitoring policies update <POLICY_ID> --add-notification-channels=<CHANNEL_ID>
```

## Local validation

The CI guard for this directory is JSON / YAML lint — no live GCP calls:

```bash
jq . infra/cloud-logging/dashboard.json >/dev/null
python3 -c "import yaml; yaml.safe_load(open('infra/cloud-logging/alert-policies.yaml'))"
```

If both exit 0 the configs are syntactically valid and safe to apply.

## Rollback

Dashboards are versioned by Cloud Monitoring; revert by editing in the UI
or re-applying a previous git revision of `dashboard.json`. Alert policies
are atomically replaced by re-running `gcloud alpha monitoring policies
create` (the previous policy must be deleted explicitly via
`gcloud alpha monitoring policies delete <POLICY_ID>`).

## Adam owner steps post-merge

1. Run the one-time `gcloud logging metrics create pa.spend.daily ...`
   command above (only first time).
2. Run `gcloud monitoring dashboards create` and `gcloud alpha monitoring
   policies create` after every change.
3. Verify dashboard renders all four tiles with non-empty data within
   24 hours of the first prod LLM call.
