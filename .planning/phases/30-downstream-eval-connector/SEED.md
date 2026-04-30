# Phase 30 — Default Trigger Seed Runbook

Two example downstream triggers ship with the connector but are **DISABLED by default** so the connector stays dark until Adam wires real partners. This runbook walks through enabling each one safely.

## 1. Seed the Firestore docs

Idempotent — repeated runs leave existing docs untouched.

```bash
curl -X POST "$PA_ADMIN_URL/paAdminBootstrap" \
  -H "x-admin-token: $PA_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"action": "seedDownstreamTriggers"}'
```

Expected response:
```json
{
  "action": "seedDownstreamTriggers",
  "created": ["mentioned_layoff", "mentioned_salary_research"],
  "skipped": []
}
```

The `evalConnectorsEnabled` master flag is also seeded by `seedFlags` (Phase 24.5). Run if not already present:
```bash
curl -X POST "$PA_ADMIN_URL/paAdminBootstrap" \
  -H "x-admin-token: $PA_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"action": "seedFlags"}'
```

## 2. Per-trigger configuration (Adam, before enabling)

For each of `mentioned_layoff` and `mentioned_salary_research`:

### 2a. Provision the HMAC secret in Secret Manager

The seed sets `hmacSecretRef` to `PA_TRIGGER_HMAC_LAYOFF` / `PA_TRIGGER_HMAC_SALARY`. Create each as a Cloud Functions secret accessible to `paInboundEvent` (that's where the orchestrator runs):

```bash
echo -n 'YOUR_64_CHAR_HEX_SECRET' | gcloud secrets create PA_TRIGGER_HMAC_LAYOFF \
  --replication-policy=automatic --data-file=-
gcloud secrets add-iam-policy-binding PA_TRIGGER_HMAC_LAYOFF \
  --member="serviceAccount:$PA_RUNTIME_SA" --role=roles/secretmanager.secretAccessor
```

Repeat for `PA_TRIGGER_HMAC_SALARY`.

Generate a strong secret:
```bash
openssl rand -hex 32
```

Share the secret with the partner out-of-band (Slack DM, 1Password) — never commit it.

### 2b. Update the trigger's endpoint URL

Open the dashboard at `/admin/downstream-triggers`, click **Edit** on the row, and:
- Replace `https://example.invalid/layoff` with the partner's real ingestion URL (HTTPS only — the SDK rejects http).
- (Optional) Adjust the `payloadTemplate` JSON to match the partner's expected schema. Available variables: `{{userId}}`, `{{conversationId}}`, `{{lastUserTurn}}`, `{{lastAssistantTurn}}`, `{{matchedSnippet}}`, `{{triggerId}}`, `{{triggerName}}`.
- Leave `cooldownSec=86400` (24h) unless the partner explicitly asks for higher fan-out.
- Save with a Reason — the audit row lands in `pa-audit-events`.

### 2c. Verify the partner endpoint accepts your HMAC

Ask the partner to log + verify the `x-hmac-sha256` header on a synthetic request. If they reject the signature, recheck:
- Same secret bytes on both sides (no trailing newline)
- Algorithm is HMAC-SHA256, hex-encoded
- Signed body is the **raw POST body**, not a parsed object

## 3. Dry-run via the admin endpoint

Before flipping `enabled`, send a synthetic turn through the connector with `skipFlagCheck:true` so the master kill switch doesn't block:

```bash
curl -X POST "$PA_ADMIN_URL/paAdminBootstrap" \
  -H "x-admin-token: $PA_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "action": "evalDownstreamTriggers",
    "userId": "test-user-id",
    "lastUserTurn": "I just got laid off last week",
    "lastAssistantTurn": "Im sorry to hear that."
  }'
```

The trigger needs `enabled:true` (toggled in the dashboard) for `evalDownstreamTriggers` to fire it. The response includes `matched`, `fired`, and per-record `status` / `errorMsg`. A successful match-and-fire looks like:

```json
{
  "evaluated": 1,
  "matched": 1,
  "fired": 1,
  "records": [{
    "triggerId": "mentioned_layoff",
    "fired": true,
    "reason": "matched",
    "status": 200,
    "errorMsg": null
  }]
}
```

A 4xx/5xx from the partner still records the fire row (cooldown opens) but logs `errorMsg`. Inspect via the dashboard's **Fires** drawer per trigger.

## 4. Flip the trigger ON

Open `/admin/downstream-triggers`, click the **off** toggle on the configured row.

## 5. Flip the master kill switch ON (production cutover)

After at least one trigger is `enabled:true` AND its dry-run passes:

```bash
# Via the dashboard: /admin/flags → search "evalConnectorsEnabled" → set to true
# Or via gcloud emergency env override (bypasses Firestore, no audit):
gcloud functions deploy paInboundEvent --update-env-vars=evalConnectorsEnabled=1
```

The flag SDK has a 30s TTL, so the change propagates within 30s of the next cold-start or cache eviction.

## 6. Rollback

Any of these instantly disable the connector:
- `/admin/flags` → `evalConnectorsEnabled` → false (writes audit row)
- `/admin/downstream-triggers` → individual trigger → toggle **off**
- `gcloud functions deploy paInboundEvent --remove-env-vars=evalConnectorsEnabled` (env override removed; Firestore default takes over)

The connector is fire-and-forget by design; rollback never affects the chat path.

## Adam decisions still owed

- [ ] Confirm 24h cooldown is the right cadence for both triggers. Could be longer (per-week) for layoff to avoid retraumatization spam.
- [ ] Confirm partner contact + endpoint URL for each trigger.
- [ ] Decide whether to add a third default trigger for `mentioned_burnout` — currently out of v1 scope.
