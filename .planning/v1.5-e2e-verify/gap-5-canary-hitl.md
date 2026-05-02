# Gap 5 — Canary Flag Flip HITL Instructions for Adam

**Status**: Code shipped; flags default OFF in production.
**Blocker**: Adam must run script (assistant cannot flip prod flags without explicit approval).
**Time budget**: 5 min Stage A + 24h soak + 5 min Stage B + 48h soak + 5 min Stage C.

---

## Why this is HITL

All 14 v1.5 streams are flag-gated. Code is in production but **users see zero v1.5 behavior change** until you flip flags. This is intentional — assistant should not ramp prod features without your explicit OK.

Per [V1.5-ROLLOUT.md](../V1.5-ROLLOUT.md) Step 3, the canary order is Stage A → B → C.

---

## Stage A — Adam-only canary (run today)

```bash
cd /Users/adam/Desktop/WeKruit/wekruit-pa/apps/functions/scripts
./canary-stage-a.sh
```

What it flips (perUser scope, allowlist=[YOUR_USER_ID]):
- `paOnboardingProbeV2Enabled` → ON
- `paHardFiltersEnabled` → ON
- `paStartupBoostEnabled` → ON
- `paMatchExplainerEnabled` → ON
- `paMatchingPipelineWebhookEnabled` → ON
- `paMessageCoalesceEnabled` → ON
- `paSafetyCheckEnabled` → ON (master)
- `paReverseMatchEnabled` → ON (admin-only)
- `paFriendToneOpenerEnabled` → already ON (sanity check)
- `paTagClusterRecEnabled` → ON (Phase 51 — pending P7 ship; check before flipping)

---

## Stage A verification (24h soak — DO THIS YOURSELF)

After running `canary-stage-a.sh`:

1. **Coalescer test**:
   ```
   You → Claire (3 quick iMessages within 5 sec):
     "测试1"
     "测试2"
     "测试3"
   Expected: 1 reply ~5–8s later (not 3 replies).
   ```

2. **Onboarding probe v2 test**:
   ```bash
   # Reset your onboardingState in Firestore console
   gcloud firestore documents update pa_users/<YOUR_USER_ID> \
     --update-mask=onboardingState \
     --data='{"onboardingState":null}' \
     --project=wekruit-5f89b
   ```
   Then iMessage Claire: "我想找工作"
   Expected: 6-question friend-tone probe walks (not the old 3-question variant).

3. **Daily push (next day at 09:00 PT)**:
   - Friend-tone opener (H13) — message starts with friendly preamble
   - 1–3 line reason explainer per job (Stream-F)
   - Bilingual mirror — if your last message was zh, push is zh

4. **Mac mini → Cloud webhook**:
   - At 06:00 PT next day: `daily-update.sh` runs on Mac mini
   - Then check Firestore: `pa-matching-pipeline-runs` collection should have a new doc within 60s
   - Fields: `runId`, `jobsScraped`, `jobsNew`, `jobsUpdated`, `costUsd`, `source: "mac-mini"`

5. **No regressions**:
   - Job recommendations still arrive
   - Resume parse still works
   - No Firestore errors in `pa-events` collection

If ANY of the above fail → see "Rollback" section below.

---

## Stage B — 10% bucket (after 24h Stage A passes)

Edit each flag's BucketStrategy in Firestore console (or run a script TBD):
- `scope: "random"`, `percentage: 0.1`

This sends 10% of users into the v1.5 cohort. Soak 48h.

Monitor:
- `pa-cost-ledger` — daily cost per user should stay < $0.01 average
- Firestore writes — `matching-jobs` healthy
- iMessage success rate — `pa-events:imessage:sent:fail` should not spike

---

## Stage C — 100% global (after 48h Stage B passes)

Flip each flag to `value: true, scope: "global"`. All users get v1.5.

---

## Rollback (if anything weird happens at any stage)

```bash
# Roll back a single flag
curl -X POST "https://paAdminBootstrap-XXXX-uc.a.run.app?action=setFlag" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"key": "<flag_name>", "value": false, "scope": "global"}'
```

Or panic-rollback all v1.5 flags at once:
```bash
cd apps/functions/scripts
./canary-rollback-all.sh   # TODO: ship this script alongside canary-stage-a.sh
```

Underlying code stays — flag default OFF means bytewise-identical pre-v1.5 behavior.

---

## What assistant cannot do for you

- Flip prod flags (would touch shared state without your OK)
- Send test iMessages to your phone (testing must come from your real iMessage thread)
- Watch your phone for 24h to verify Stage A
- Decide when Stage A → Stage B based on subjective UX feel

---

## What assistant CAN do (just ask)

- Pre-validate `canary-stage-a.sh` will run cleanly via `--dry-run` mode
- Read Firestore `pa-cost-ledger` and `pa-events` to summarize during soak
- Check `pa-matching-pipeline-runs` for webhook fires
- Generate a Stage A → B promotion report if metrics look healthy

---

## Trigger this when ready

Adam, when you have 5 min: run `./canary-stage-a.sh`. Then iMessage Claire with the 3-quick-message test. Reply here when done and assistant will resume verification.
