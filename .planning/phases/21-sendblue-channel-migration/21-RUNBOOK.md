# Phase 21 — Sendblue Cutover Runbook

**Owner:** Adam (operator) + executor (CF deploy)
**Created:** 2026-04-27
**Last updated:** 2026-04-27 (post T9)

---

## Pre-deploy checklist

- [ ] All 58 unit tests passing (`apps/functions && npm test` + macOS worker `npm test`)
- [ ] `apps/functions && npm run build` clean
- [ ] `npm run typecheck` clean across workspaces
- [ ] Sendblue contract Qs Q1–Q4 answered (CHANNEL-08; see 21-CONTRACT-NOTES.md §4)
- [ ] Adam has webhook signing secret from Sendblue dashboard

---

## Cutover sequence (D-08)

### Step 1 — Migrate secrets to Firebase Secret Manager (D-07)

Run from project root. **Adam is the operator** — values are paste-on-prompt; never put in CLI history.

```bash
cd apps/functions

firebase functions:secrets:set SENDBLUE_API_KEY_ID --project wekruit-5f89b
# Paste the value from apps/functions/.env when prompted

firebase functions:secrets:set SENDBLUE_API_SECRET_KEY --project wekruit-5f89b
# Paste the value from apps/functions/.env when prompted

firebase functions:secrets:set SENDBLUE_WEBHOOK_SIGNING_SECRET --project wekruit-5f89b
# Paste the per-webhook secret from Sendblue dashboard → Webhooks → Add endpoint

# OPTIONAL — only required on free_api / sandbox plans (per 21-CONTRACT-NOTES §1).
# On paid dedicated lines this auto-populates and the secret can be set to empty.
firebase functions:secrets:set SENDBLUE_FROM_NUMBER --project wekruit-5f89b

# Verify all four:
firebase functions:secrets:access SENDBLUE_API_KEY_ID --project wekruit-5f89b
firebase functions:secrets:access SENDBLUE_API_SECRET_KEY --project wekruit-5f89b
firebase functions:secrets:access SENDBLUE_WEBHOOK_SIGNING_SECRET --project wekruit-5f89b
firebase functions:secrets:access SENDBLUE_FROM_NUMBER --project wekruit-5f89b
```

**Local dev path:** `apps/functions/.env` keeps plaintext (gitignored). Production CF reads from Secret Manager via `defineSecret(...)` bindings in `apps/functions/src/index.ts`.

### Step 2 — Deploy CF endpoints

```bash
cd apps/functions
npm run build

firebase deploy --only \
  functions:paSendblueWebhook,functions:paSendblueOutbox \
  --project wekruit-5f89b
```

Expected: both functions deployed to `us-central1`. Note the URL of `paSendblueWebhook` (printed by deploy).

### Step 3 — Configure Sendblue dashboard webhook

In **Sendblue Dashboard → Webhooks → Add endpoint**:

- **URL:** `https://us-central1-wekruit-5f89b.cloudfunctions.net/paSendblueWebhook`
- **Events:** subscribe to `receive`, `outbound`, `typing_indicator`, `line_blocked`
- **Signing secret:** the one set in Step 1 as `SENDBLUE_WEBHOOK_SIGNING_SECRET`
- **Save** → confirm dashboard shows "active"

### Step 4 — Drain check (D-09)

Adam keeps macOS worker running with `PA_CHANNEL_LEGACY=1` until pending outbound queue is empty:

```bash
# Run from project root:
node -e "
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'wekruit-5f89b' });
admin.firestore().collection('pa_outbound').where('status','==','pending').get()
  .then(s => { console.log('pending pa_outbound rows:', s.size); process.exit(0); });
"
# Expect: 0
```

### Step 5 — Sandbox smoke (Task 11)

See "Sandbox smoke results" section below — appended after Task 11 runs.

### Step 6 — Flip flag (Task 12)

On macOS worker host:

```bash
# Stop existing worker
pm2 stop pa-imessage-worker  # or however worker is supervised

# Set flag OFF
unset PA_CHANNEL_LEGACY  # or set =0

# Restart — should see immediate exit:
# "[legacy] PA_CHANNEL_LEGACY!=1 — worker exiting (Sendblue path active)"
npm start --workspace=@pa/macos-imessage-worker
```

### Step 7 — Production verification (CHANNEL-09)

- 5 real-traffic round trips on production Sendblue line
- p95 < 30s
- No `pa_outbound` rows stuck in `sending` for >5 min
- Phase 15 chunker confirmed dormant (no chunked-send log lines)

---

## Rollback (D-11)

Execute in this order if production cutover fails:

```bash
# 1. Re-enable legacy worker
ssh adam@worker-host
export PA_CHANNEL_LEGACY=1
pm2 restart pa-imessage-worker
# Confirm worker enters main loop (Photon polls resume)

# 2. macOS worker outbox releases CF claims back to pending
#    (handled automatically by outbox.ts isLegacyChannelEnabled() guard)

# 3. Pause Sendblue webhook subscription
#    Sendblue dashboard → Webhooks → [endpoint] → Disable

# 4. CF endpoints stay deployed but receive no traffic
#    (no need to undeploy; they're idle without webhook delivery)
```

**Recovery time objective:** <2 min from rollback decision to legacy traffic restored.

---

## Drain procedure (D-09)

Triggered before Step 6 cutover. Adam runs macOS worker until:

```sql
SELECT COUNT(*) FROM pa_outbound WHERE status = 'pending';
-- expect 0
```

Then:

```sql
SELECT COUNT(*) FROM pa_outbound WHERE status = 'sending' AND updatedAt < $now - 5min;
-- expect 0 (no stuck claims)
```

Document timestamp + counts in this runbook before flipping flag.

---

## Contract-Q tracker (CHANNEL-08)

| #   | Question                                                         | Answer (Adam, 2026-04-27)                                  | Source           |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------- | ---------------- |
| Q1  | Apple ID ownership (Sendblue or operator)?                       | **Sendblue owns Apple ID** → no operator liability         | Sales call       |
| Q2  | SLA on number re-provisioning if Apple flags line?               | Hours weekday; slower on weekends                          | Sales call       |
| Q3  | Outbound rate limit?                                             | 50/day new contacts, 150/day existing; negotiable at scale | Sales call       |
| Q4  | GDPR / data residency — does Sendblue log/store message content? | SOC2 attestation provided                                  | Sales call       |
| Q5  | Exact HMAC header name                                           | Documented contract: `Sendblue-Signature` (+ aliases)      | 21-CONTRACT-NOTES §2 — verify on first prod webhook |

All four business-contract Qs answered. Q5 is post-deploy verification gate.

---

## Sandbox smoke results

_Appended after Task 11 runs._

**Status:** Awaiting operator execution — see Task 11 in plan + Task 10 checkpoint.

**Pre-flight required:**

- [ ] All 4 secrets set in Firebase Secret Manager (Step 1 above)
- [ ] CF deployed (Step 2 above)
- [ ] Webhook URL configured in Sendblue dashboard (Step 3 above)
- [ ] Adam's number in `IMESSAGE_PEERS` allowlist for CF runtime
- [ ] `PA_CHANNEL_LEGACY=0` for CF (Sendblue active); macOS worker locally `=1` (intentional parallel-run)

**Smoke trial template:**

| Trial | Inbound timestamp     | Outbound timestamp    | Round-trip latency |
| ----- | --------------------- | --------------------- | ------------------ |
| 1     | _yyyy-mm-ddThh:mm:ssZ_ | _yyyy-mm-ddThh:mm:ssZ_ | _e.g. 8.4s_        |
| 2     |                       |                       |                    |
| 3     |                       |                       |                    |
| 4     |                       |                       |                    |
| 5     |                       |                       |                    |
| **p50** |                     |                       |                    |
| **p95** |                     |                       |                    |
| **max** |                     |                       |                    |

**CHANNEL-09 budget:** p95 < 30s ✅/❌

**Fail-mode probes:**

| Probe                            | Expected                                          | Actual | Pass |
| -------------------------------- | ------------------------------------------------- | ------ | ---- |
| Bad signature (curl manually)    | 401, no inbound row, no audit                     |        |      |
| Non-allowlisted number           | 200 OK, no inbound, audit `allowlist_deny`        |        |      |
| Same `message_handle` twice      | Single `pa_inbound_events` row (broker idempotency) |       |      |
| Group-chat payload (synthetic)   | 200 OK, no inbound, audit `group_chat_rejected`    |        |      |
| Network timeout                  | 5xx logged; row stays pending; reclaim works      |        |      |

---

## Production cutover outcome

_Appended after Task 12 runs._

**Decision:** `GO` / `ROLLBACK` / `DEFERRED`
**Date:** _yyyy-mm-dd_
**Operator:** Adam

**Production round-trip latencies (5 trials):**

| Trial   | Latency |
| ------- | ------- |
| 1       |         |
| 2       |         |
| 3       |         |
| 4       |         |
| 5       |         |
| **p50** |         |
| **p95** |         |

**Notes:**

_(blank)_

---

## Post-cutover monitoring

For 24h after Step 6:

- Watch `firebase functions:log --only paSendblueWebhook` for HMAC failures
- Watch `firebase functions:log --only paSendblueOutbox` for 4xx / 5xx Sendblue errors
- Daily `pa_audit_events where channel='imessage_sendblue'` review for unexpected denies
- `pa_outbound where status='sending' and updatedAt < $now - 5min` should remain empty

---

## Followups (milestone v1.2)

- [ ] DELETE `apps/macos-imessage-worker/` (~1000 LOC)
- [ ] DELETE `packages/pa-orchestrator/src/chunker.ts` (Phase 15 removal)
- [ ] DELETE `apps/macos-imessage-worker/src/chunker.ts` (worker copy)
- [ ] Promote `apps/functions/src/sendblue/allowlist.ts` to shared package if WhatsApp adapter lands
- [ ] Mirror `outbound` Sendblue webhook events into `pa_audit_events` for delivery telemetry (Q-02 deferred decision)
