# Phase 47.1 — Mac mini → paMatchingPipelineComplete webhook bridge

**Stream**: v1.5 Stream-A2 (D8 follow-up after Phase 47 audit decision: Mac mini stays).
**Date**: 2026-05-02
**Owner**: P7 (Senior Eng).

底层逻辑: Mac mini cron pushes Firestore deltas already; what's missing is a *finished* signal that wekruit-pa can hang downstream consumers off of. 抓手: tiny CF + HMAC bridge + per-source rate limit. 闭环: cron → CF → `pa-matching-pipeline-runs` + `pa-events` → dashboard tile + future paJobRecDaily trigger.

---

## What ships

### D1 — `paMatchingPipelineComplete` Cloud Function (Gen 2)
- **File**: `apps/functions/src/matching-pipeline-complete.ts` (pure handler) + wired in `apps/functions/src/index.ts`.
- **URL**: `https://us-central1-wekruit-5f89b.cloudfunctions.net/paMatchingPipelineComplete`
- **Secret**: `PA_MATCHING_WEBHOOK_SECRET` (Firebase Secret Manager).
- **Auth**: HMAC-SHA256 over raw body (header `x-pa-signature`) + 5-min timestamp window (header `x-pa-timestamp`).
- **Flag**: `paMatchingPipelineWebhookEnabled` (default off → CF returns 503 `feature_disabled`). Mac mini side fail-opens (cron continues).
- **Rate limit**: per-source soft 1/hr (warn-log only), hard 24/day (429). Counter docs in `pa-matching-pipeline-rate/{sourceKey}__{bucket}`.
- **Writes**: `pa-matching-pipeline-runs/{runId}` (run history) and (success + jobsNew>0) `pa-events/{auto}` with `eventKind="matching:pipeline:completed"`.
- **Cost**: 1 invocation/day → 30/mo. Free-tier headroom = 2M/mo. **Effective $0/mo.**

### D2 — Mac mini patch
- **File**: `apps/functions/src/WEKRUIT-MATCHING-PATCH.md`.
- Includes: full text of `scripts/post-pipeline-webhook.sh`, the diff for `scripts/daily-update.sh`, `.env` additions, smoke-test, rollback.
- **Adam**: apply this manually on the Mac mini. Claude Code in this repo cannot ssh.

### D3 — Tests
- **File**: `apps/functions/src/__tests__/matching-pipeline-complete.test.ts` (9 tests).
- Covers: HMAC valid (200+writes run), HMAC invalid (401), stale timestamp (401), missing fields (400), flag-off (503), rate-limit hit (429), pa-events emit on success+jobsNew>0, no-emit when jobsNew=0, failed status (200+no event).
- Result: **9/9 pass**. Functions full suite: **345/345 pass**, typecheck clean.

### D4 — Dashboard tile
- **File**: `apps/dashboard-web/src/pages/Operations.tsx` — added a `pipelineRuns` tab + a top-of-page `PipelineHealthBanner` component.
- Banner colors: GREEN if last success <24h, AMBER 24–36h, RED >36h or no success ever recorded.
- Tab columns: `createdAt, status, jobsScraped, jobsNew, jobsUpdated, jobsErrored, costUsd, sourceRepos, error`.
- Reads `pa-matching-pipeline-runs` (latest 30 docs by `createdAt desc`).
- TypeScript check passes.

---

## Operator deploy steps

### 1. Create the secret
```bash
# Generate a strong random secret (32 bytes, base64url):
SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')
# Push to Secret Manager:
echo "$SECRET" | firebase functions:secrets:set PA_MATCHING_WEBHOOK_SECRET --data-file=- --project wekruit-5f89b
# Stash the same value somewhere safe — you'll paste it into the Mac mini .env.
echo "REMEMBER THIS: $SECRET"
```

### 2. Deploy functions
```bash
cd apps/functions
npm run build
firebase deploy --only functions:paMatchingPipelineComplete,functions:paHealthMatchingPipelineComplete --project wekruit-5f89b
```

### 3. Apply the Mac mini patch
- Follow `apps/functions/src/WEKRUIT-MATCHING-PATCH.md` sections 1–3 on the Mac mini.
- Smoke-test per section 4.

### 4. Flip the flag on
After section-4 smoke succeeds against staging-style data, enable the flag:
```bash
# Via dashboard Flags page or Firestore console:
# pa-remote-config/paMatchingPipelineWebhookEnabled = { value: true, type: "bool", scope: "global" }
```

### 5. Validate on prod
```bash
# Hit the health endpoint:
curl -sS https://us-central1-wekruit-5f89b.cloudfunctions.net/paHealthMatchingPipelineComplete | jq .
# Expect: { ok: true, name: "paMatchingPipelineComplete", deps: { firestore: ok, secrets: { PA_MATCHING_WEBHOOK_SECRET: present }}}

# After tomorrow morning's cron run:
# Firestore: pa-matching-pipeline-runs should have 1 doc dated < 24h ago.
# Firestore: pa-events should have 1 row with eventKind="matching:pipeline:completed" if jobsNew > 0.
```

### 6. Manual signed test (optional, but useful pre-cron)
```bash
SECRET="$(...the value from step 1...)"
URL=https://us-central1-wekruit-5f89b.cloudfunctions.net/paMatchingPipelineComplete
RUN_ID="manual-smoke-$(date +%s)"
NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))')
BODY=$(jq -nc --arg id "$RUN_ID" --arg t "$NOW_ISO" \
  '{runId:$id,status:"success",scrapeStartedAt:$t,scrapeFinishedAt:$t,jobsScraped:0,jobsNew:0,jobsUpdated:0,jobsErrored:0,costUsd:0,sourceRepos:["SimplifyJobs"]}')
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')
curl -sS -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "x-pa-signature: $SIG" \
  -H "x-pa-timestamp: $NOW_MS" \
  --data-binary "$BODY"
# Expect: {"ok":true,"runId":"manual-smoke-..."}
```

---

## Rollback

| Scenario | Action |
|----------|--------|
| Webhook returns 5xx and cron starts erroring | Flip flag off → CF returns 503 → bash script ignores non-200 → cron continues. |
| HMAC secret leaked | Rotate via `firebase functions:secrets:set PA_MATCHING_WEBHOOK_SECRET --data-file=-` then update Mac mini `.env`. Old runs still ingest until rotation completes. |
| Need to disable entirely | Remove `scripts/post-pipeline-webhook.sh` invocation from `daily-update.sh` on Mac mini. CF can stay deployed (idle). |

The cron path is fail-open by design — webhook exit code is always 0 from the bash script.

---

## What was NOT done (intentional scope cuts)

- **Dashboard tile (D4)**: deferred. Follow-up commit; ~30 LoC in `Operations.tsx`.
- **Per-event Firestore trigger** (e.g. paJobRecDaily reading `pa-events`): out of scope. Brief said "any downstream consumer (paJobRecDaily?)" but the daily cron is independent for now. Adding a trigger is a separate phase decision.
- **Schema for `pa-events`**: kept loose (`{eventKind, payload, createdAt}`). When a second event kind ships, formalize via `@pa/core-types`.
- **Retry/backoff on webhook send failure**: bash script does not retry; the cron daily summary email (existing) will still fire and humans can re-trigger. Adding a queue is over-engineering at 1 call/day.

---

## Files touched

```
NEW   apps/functions/src/matching-pipeline-complete.ts
NEW   apps/functions/src/__tests__/matching-pipeline-complete.test.ts
NEW   apps/functions/src/WEKRUIT-MATCHING-PATCH.md
NEW   .planning/phases/47.1-matching-pipeline-webhook/DELIVERY.md
EDIT  apps/functions/src/index.ts (new secret + import + onRequest export + health)
EDIT  apps/dashboard-web/src/pages/Operations.tsx (D4 — pipelineRuns tab + health banner)
```

Total diff target: ~600 LoC handler/test + 1 wire-in. Verified `npm test` 345/345 pass + typecheck clean.
