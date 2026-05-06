# Adam-action secrets provisioning (Phase 69)

REQ-IDs: SECRETS-01, SECRETS-02, SECRETS-03

The three secrets below are **Adam-only**: only Adam holds the source values
(Anthropic dashboard, Slack admin, LinkedIn Developer console). Cloud Functions
in this repo declare them via `defineSecret()` with graceful-miss fallbacks, so
the moment Adam runs the `firebase functions:secrets:set` command and triggers a
redeploy, the keys auto-activate without further code changes.

Until provisioned, the runtime behavior is:

| Secret | When unset |
|---|---|
| `ANTHROPIC_API_KEY` | `pa-resume-parser` router skips Anthropic Sonnet tier; falls through to gpt-5.4-nano → gpt-4.1-mini. `cv-ingest/industry-second-pass.ts` skips re-classification. `lib/jd-relative-weights.ts` falls through to OpenAI tier → Qwen-7B. `lib/sponsorship-inference.ts` skips Anthropic provider. |
| `PA_SLACK_ALERT_WEBHOOK` | `lib/slack-alert.ts` `postSlackAlert()` returns `{ posted: false, reason: "PA_SLACK_ALERT_WEBHOOK not set" }` and emits a `pa.slack.alert_skipped` info-log. Mailgun email fallbacks (qa-evaluator, cost-summary) still fire. |
| `LINKEDIN_ACCESS_TOKEN` | (Reserved — not yet wired into a CF; placeholder for future LinkedIn Recruiter / job-import integration.) |

### Placeholder versions

Phase 69 created Secret Manager rows for `ANTHROPIC_API_KEY` and
`PA_SLACK_ALERT_WEBHOOK` with payload value `__UNSET__` (Secret Manager rejects
empty payloads, so we use this sentinel). All readers in the codebase treat
`__UNSET__` as "not provisioned" and gracefully fall through. When Adam runs
`firebase functions:secrets:set` with the real value, the new version becomes
`latest` and CFs pick it up on next invocation (no code change required).

---

## 1. ANTHROPIC_API_KEY

```bash
# 1. Grab the key from https://console.anthropic.com/settings/keys
#    (use a project-scoped key dedicated to wekruit-pa, not your personal one).

# 2. Provision in Firebase Secret Manager
echo -n "sk-ant-..." | firebase functions:secrets:set ANTHROPIC_API_KEY \
  --project wekruit-5f89b \
  --data-file=-

# 3. Redeploy the functions that depend on it (already declared via
#    defineSecret in apps/functions/src/orchestrator-deps.ts):
cd apps/functions && pnpm run deploy
```

CFs that bind `ANTHROPIC_API_KEY`:

- `onPaInbound` — orchestrator (cv-ingest path)
- `paSendblueWebhook` — cv-ingest industry-second-pass + parser fallback
- `paLlmRerankNightly` — JD-relative weights chain (Sonnet primary)

Verify after deploy:

```bash
gcloud functions describe onPaInbound \
  --region=us-central1 \
  --project=wekruit-5f89b \
  --format='value(serviceConfig.secretEnvironmentVariables)' | grep ANTHROPIC_API_KEY
```

## 2. PA_SLACK_ALERT_WEBHOOK

```bash
# 1. Create an Incoming Webhook in your Slack workspace:
#    https://api.slack.com/apps → "Create New App" → from scratch
#    → "Incoming Webhooks" → activate → "Add New Webhook to Workspace"
#    → pick the alert channel (e.g. #pa-ops-alerts)
#    → copy the webhook URL https://hooks.slack.com/services/T.../B.../...

# 2. Provision in Firebase Secret Manager
echo -n "https://hooks.slack.com/services/T.../B.../..." | \
  firebase functions:secrets:set PA_SLACK_ALERT_WEBHOOK \
    --project wekruit-5f89b \
    --data-file=-

# 3. Redeploy
cd apps/functions && pnpm run deploy
```

CFs that bind `PA_SLACK_ALERT_WEBHOOK`:

- `paQaEvaluatorWeekly` — alerts on threshold miss (hardFilter <90% / top3 <70%)
- `paCostSummaryWeekly` — alerts when weekly Serper cost >$10

Verify after deploy:

```bash
# Trigger a one-off post via the helper (any Cloud Function shell):
node -e 'import("./lib/slack-alert.js").then(m => m.postSlackAlert({ level: "info", title: "Phase 69 ping", message: "Slack webhook live" })).then(console.log)'
```

## 3. LINKEDIN_ACCESS_TOKEN (reserved)

LinkedIn Developer App setup:

- App registration: <https://developer.linkedin.com/>
- For Recruiter / Marketing API access, requires Partner Program approval.
- For the Sign In with LinkedIn or basic profile flow, OAuth 2.0 redirect-back
  flow is sufficient. Token TTL is typically 60 days; we'll need a refresh
  scheduler when wired.

Provisioning command (when ready):

```bash
echo -n "AQU..." | firebase functions:secrets:set LINKEDIN_ACCESS_TOKEN \
  --project wekruit-5f89b \
  --data-file=-
```

No CF binds this yet — wire-up will land alongside the LinkedIn job-import
pipeline (post-v1.7).

---

## Secret rotation

```bash
# List existing secrets
firebase functions:secrets:get ANTHROPIC_API_KEY \
  --project wekruit-5f89b

# Set a new value (creates a new version; CFs read the latest by default)
echo -n "<new-key>" | firebase functions:secrets:set ANTHROPIC_API_KEY \
  --project wekruit-5f89b \
  --data-file=-

# Redeploy CFs to pick up the latest version
cd apps/functions && pnpm run deploy
```

## One-shot bulk provision (Adam reference)

```bash
# Paste keys into env first, then:
echo -n "$ANTHROPIC_API_KEY"        | firebase functions:secrets:set ANTHROPIC_API_KEY        --project wekruit-5f89b --data-file=-
echo -n "$PA_SLACK_ALERT_WEBHOOK"   | firebase functions:secrets:set PA_SLACK_ALERT_WEBHOOK   --project wekruit-5f89b --data-file=-
echo -n "$LINKEDIN_ACCESS_TOKEN"    | firebase functions:secrets:set LINKEDIN_ACCESS_TOKEN    --project wekruit-5f89b --data-file=-

cd apps/functions && pnpm run deploy
```
