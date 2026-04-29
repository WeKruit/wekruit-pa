# `paSendblueOutbox` repair runbook

**Phase 32 Wave 4** — investigation + repair plan for the "1 of 10 CFs failed
update" symptom on the most recent `firebase deploy --only functions` run.

> **STATUS: RESOLVED 2026-04-28** — confirmed root cause was env-var/secret
> overlap (hypothesis #4 in §3 below, not the more likely #1/#2/#3). Fix:
> remove `SENDBLUE_API_KEY_ID` + `SENDBLUE_API_SECRET_KEY` from
> `apps/functions/.env` (they remain canonical in Secret Manager). Redeploy
> via `firebase deploy --only functions:pa-orchestrator:paSendblueOutbox`
> succeeded. The exact Cloud Run error was:
>
> ```
> spec.template.spec.containers[0].env: Secret environment variable
> overlaps non secret environment variable: SENDBLUE_API_KEY_ID
> ```
>
> The runbook below is preserved for reference.

---

## 1. Symptom

Last `firebase deploy --only functions` reported 9 of 10 CFs updated and
**`paSendblueOutbox` failed to update**. The other 10 CFs (including its
sibling `paSendblueWebhook` and the upstream connectors) deployed cleanly.
The CF is still serving the previous revision, so user-facing impact is
masked — but new outbox logic (Phase 26 daily-quota gate, Phase 28 audit
events) is **not live** until this is repaired.

Likely surface signature in the deploy log:
```
Update function paSendblueOutbox failed: ...
```

## 2. Likely root cause — ranked

The `paSendblueOutbox` CF differs from its siblings in three load-bearing
ways. Each is a candidate cause; rank order reflects observed frequency
on this codebase.

| Rank | Hypothesis | Why plausible | How to verify |
|------|------------|---------------|---------------|
| 1 | **Missing/rotated secret** — `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET_KEY`, or `SENDBLUE_FROM_NUMBER` was rotated or never set on the active project | `paSendblueOutbox` declares all three under `secrets:` (apps/functions/src/index.ts:663). Update fails fast if a referenced secret is absent in Secret Manager. The fact that *only* this CF failed is a strong signal — siblings declare different secrets. | `firebase functions:secrets:access SENDBLUE_API_KEY_ID --project wekruit-5f89b` (and same for the other two). If any returns "Secret not found" or the value is empty, this is the cause. |
| 2 | **IAM grant lag on Secret Manager** — the CF runtime SA (`wekruit-5f89b@appspot.gserviceaccount.com`) lost `roles/secretmanager.secretAccessor` on one of the three secrets, e.g. after a recent IAM rotation | A re-deploy explicitly re-binds secret IAM; if the binding fails, the CF update fails with a 403 buried in the operation status. | `gcloud secrets get-iam-policy SENDBLUE_API_KEY_ID --project wekruit-5f89b` — confirm `wekruit-5f89b@appspot.gserviceaccount.com` has `roles/secretmanager.secretAccessor` on all three Sendblue secrets. |
| 3 | **Region drift / stale revision metadata** — the CF was originally deployed with a different region or runtime, and the new CLI version refuses the in-place update | `paSendblueOutbox` is `region: "us-central1"`, `memory: "256MiB"`, `concurrency: 1`, `timeoutSeconds: 60` — none of these are the default; mismatch with stored metadata can fail the update path. | `gcloud functions describe paSendblueOutbox --region=us-central1 --project=wekruit-5f89b --gen2` — confirm region matches and `concurrency=1`. |
| 4 | **Build cache / schema mismatch** — the on-document trigger binding got out of sync with a Firestore index migration | Lower likelihood; would normally affect siblings too. | Check `firebase-debug.log` from the failed deploy for the `eventType` and `document` fields under the `paSendblueOutbox` operation. |
| 5 | **Quota / org-policy denial** — concurrent CF update cap on the project | Lowest likelihood given 9/10 succeeded. | Look for `RESOURCE_EXHAUSTED` or `org-policy` in the failed-update detail. |

## 3. Verification commands

Run these in order. Each one outputs a definitive yes/no for one
hypothesis.

```bash
# A. Confirm current revision (and whether it is stale vs main)
firebase functions:list --project wekruit-5f89b | grep paSendblueOutbox

# B. Pull the most recent deploy logs (may fail without auth — that's OK,
#    document the failure and proceed to C)
firebase functions:log --only paSendblueOutbox --limit 50 --project wekruit-5f89b 2>&1 | tee /tmp/outbox-tail.log

# C. Verify all three secrets exist and are non-empty
firebase functions:secrets:access SENDBLUE_API_KEY_ID     --project wekruit-5f89b | wc -c
firebase functions:secrets:access SENDBLUE_API_SECRET_KEY --project wekruit-5f89b | wc -c
firebase functions:secrets:access SENDBLUE_FROM_NUMBER    --project wekruit-5f89b | wc -c
# Each must print > 0; "Secret not found" or empty = root cause.

# D. Confirm the runtime SA can read all three (rank-2 hypothesis)
for s in SENDBLUE_API_KEY_ID SENDBLUE_API_SECRET_KEY SENDBLUE_FROM_NUMBER; do
  echo "=== $s ==="
  gcloud secrets get-iam-policy "$s" --project wekruit-5f89b \
    --format='value(bindings.members)' | grep -E 'appspot|gserviceaccount' || echo 'NO BINDING'
done

# E. Confirm CF metadata still matches the source declaration
gcloud functions describe paSendblueOutbox \
  --region=us-central1 --project=wekruit-5f89b --gen2 \
  --format='value(name,buildConfig.runtime,serviceConfig.availableMemory,serviceConfig.timeoutSeconds,serviceConfig.maxInstanceRequestConcurrency)'
```

> If `firebase functions:log` (step B) errors with auth failure, capture
> the error verbatim and proceed — secrets/IAM verification (C/D) is the
> primary diagnostic; logs are secondary.

## 4. Repair plan

Conditional on which hypothesis lands. Most-common path first.

### 4a. If a secret is missing or empty (Hypothesis 1)

```bash
# Re-set the offending secret. Adam pulls the value from 1Password.
echo "<value-from-1password>" \
  | firebase functions:secrets:set SENDBLUE_API_KEY_ID \
      --project wekruit-5f89b --data-file=-

# Then redeploy ONLY this CF, with --debug to capture the new status.
firebase deploy --only functions:paSendblueOutbox --debug --project wekruit-5f89b 2>&1 \
  | tee /tmp/redeploy.log
```

### 4b. If runtime SA lacks `secretAccessor` (Hypothesis 2)

```bash
gcloud secrets add-iam-policy-binding SENDBLUE_API_KEY_ID \
  --member='serviceAccount:wekruit-5f89b@appspot.gserviceaccount.com' \
  --role='roles/secretmanager.secretAccessor' \
  --project wekruit-5f89b

# Repeat for SENDBLUE_API_SECRET_KEY and SENDBLUE_FROM_NUMBER if affected.

firebase deploy --only functions:paSendblueOutbox --debug --project wekruit-5f89b 2>&1 \
  | tee /tmp/redeploy.log
```

### 4c. If region/metadata drift (Hypothesis 3)

```bash
# Last-resort: delete + recreate. Acceptable here because the CF is a
# Firestore trigger — no inbound URL pinned in any external system.
gcloud functions delete paSendblueOutbox --region=us-central1 \
  --project=wekruit-5f89b --gen2

firebase deploy --only functions:paSendblueOutbox --debug --project wekruit-5f89b 2>&1 \
  | tee /tmp/redeploy.log
```

### 4d. Generic fallback (no clear hypothesis won)

```bash
# Verbose redeploy. The --debug flag streams the underlying gcloud
# operation, which is where the actual error message lives.
firebase deploy --only functions:paSendblueOutbox --debug --project wekruit-5f89b 2>&1 \
  | tee /tmp/redeploy.log

# Grep the captured log for the failure detail.
grep -E 'ERROR|FAILED|denied|not found|invalid' /tmp/redeploy.log
```

## 5. Test plan post-repair

Once `firebase functions:list` shows `paSendblueOutbox` updated to the
new revision (compare hash to `main` at deploy time):

1. **Health probe** — `curl https://us-central1-wekruit-5f89b.cloudfunctions.net/paHealthSendblueOutbox` and confirm `ok=true` and both `SENDBLUE_API_KEY_ID` + `SENDBLUE_API_SECRET_KEY` present in `deps.secrets`.
2. **Manual outbound** — open dashboard `/beta`, send one outbound to `STAGING_TEST_PHONE_NUMBER` (allowlisted line). Confirm:
   - new `pa-outbound/{docId}` document transitions `pending → sending → sent` within 10s,
   - the `messageHandle` and `sendblueUuid` fields populate,
   - the staging Sendblue dashboard shows the message delivered.
3. **Logs sanity** — `firebase functions:log --only paSendblueOutbox --limit 20 --project wekruit-5f89b` shows `[sendblue][outbox] sent` for the doc and **no** `[sendblue][outbox] PA_CHANNEL_LEGACY flag=true` (legacy guard must be off on staging).
4. **Quota gate live** — `firebase functions:log --only paSendblueOutbox --limit 50 | grep -E 'quota_soft|quota_hardblock'` — confirm Phase 26 daily-quota audit lines appear (proves new code is running, not the stale revision).

If any of (1)–(4) fail, roll back by redeploying the previous tag:
```bash
git checkout <previous-commit-sha> -- apps/functions/src/sendblue/outbox.ts
firebase deploy --only functions:paSendblueOutbox --project wekruit-5f89b
git checkout HEAD -- apps/functions/src/sendblue/outbox.ts
```

## 6. Out of scope for this runbook

- Repairing other failed CFs (none reported on the latest deploy beyond
  `paSendblueOutbox`).
- Migrating `paSendblueOutbox` to Cloud Run (separate phase if needed).
- Investigating why CF update operations sometimes silently fail without
  surfacing the error to `firebase deploy` stdout (gcloud bug; tracked
  upstream).

---

**Owner:** Adam (executes).
**Author:** Phase 32 Wave 4 agent (diagnosis + commands only).
**Status:** Ready for execution.
