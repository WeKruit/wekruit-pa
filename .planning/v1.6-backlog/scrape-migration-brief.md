# v1.6 Phase Brief — Scrape Pipeline Migration: Mac mini → Cloud Run

**Owner**: TBD (P9 to spawn P7 team)
**Priority**: P0 for production reliability — Mac mini = single point of failure
**Estimated effort**: 1 sprint (~5 dev-days)
**Cost projection**: ~$5–15/mo Cloud Run + existing Firecrawl/Anthropic spend (no net new cost)

---

## Why this is P0

Adam's v1.5 brief explicitly said: *"我们应该让它always up and running so maybe cloud function..?"*

Current state (verified 2026-05-02):
- Crontab `0 6 * * * daily-update.sh` on Mac mini owned by `wekruitclaw1`
- launchd plist (`com.wekruit.matching.plist`) BROKEN — TCC permission denied; cron is the only working path
- macOS sleep / power outage / network hiccup = scrape doesn't run = Firestore matching-jobs goes stale (we saw 23-day stale gap on 2026-04-30)
- No retry, no observability, no alerting (Stream-A2 webhook helps but doesn't fix the SPOF)

**Risk**: If Mac mini dies, recommendation pipeline degrades to "previous-7-day jobs" relax tier within ~24h. At 1k+ users this becomes a public-launch blocker.

---

## What's already in place (do not redo)

- ✅ `scripts/daily-update.sh` — orchestrator script
- ✅ `scripts/post-pipeline-webhook.sh` — HMAC-signed webhook to Cloud Function (Stream-A2 — verified working via smoke V2 runId `smoke-v2-1777758147`)
- ✅ Python pipeline: `src/wekruit_matching/pipeline/daily.py` (Firecrawl scrape + Anthropic enrich + Firestore write)
- ✅ Firestore writes go to `wekruit-5f89b/matching-jobs` collection
- ✅ Pipeline emits 5 stat-token print statements consumed by webhook script

---

## Migration target: Cloud Run + Cloud Scheduler

**Why Cloud Run, not Cloud Functions Gen2**:
- Pipeline runs >15 min (scrape 1.4k jobs + enrich subset) — CF Gen2 caps at 60min but Python cold-start + dep installs eat budget
- Cloud Run has 60min request timeout, supports container with full Python deps pre-baked
- Scheduled via Cloud Scheduler → Cloud Run job (not service) — runs to completion + exits

**Reference architecture**:
```
Cloud Scheduler (06:00 PT daily)
  ↓ HTTPS POST + OIDC
Cloud Run Job: wekruit-matching-pipeline
  ├─ Container: python3.11 + firecrawl + anthropic + google-cloud-firestore
  ├─ Env: secrets pulled from Secret Manager (FIRECRAWL_API_KEY, ANTHROPIC_API_KEY)
  ├─ Workload Identity → Firestore write access
  └─ Calls existing post-pipeline-webhook (now an internal HTTP call)
       ↓
Cloud Function: paMatchingPipelineWebhook (already deployed)
       ↓
Firestore: pa-matching-pipeline-runs (already wired)
```

---

## Phase plan (rough — refine in /gsd:plan-phase)

1. **Containerize pipeline** (Day 1)
   - Dockerfile in `wekruit-matching` repo (or new `wekruit-matching-cloud` if Adam wants separation)
   - Multi-stage build: deps in builder, runtime image <500MB
   - Local test: `docker run` with mounted credentials, verify Firestore writes match Mac mini behavior bytewise
   - Deliverable: published image at `us-central1-docker.pkg.dev/wekruit-5f89b/matching/pipeline:v1`

2. **Cloud Run Job + Scheduler** (Day 2)
   - Terraform or gcloud commands to provision:
     - Cloud Run Job `wekruit-matching-pipeline` (4 vCPU, 16Gi RAM, 60min timeout)
     - Service account `matching-pipeline@wekruit-5f89b.iam` with Firestore writer + secret reader
     - Cloud Scheduler `matching-pipeline-daily` cron `0 13 * * *` UTC (= 06:00 PT)
     - Secret Manager: FIRECRAWL_API_KEY, ANTHROPIC_API_KEY, PA_MATCHING_WEBHOOK_SECRET
   - Deliverable: manual `gcloud run jobs execute` succeeds end-to-end, writes match Mac mini

3. **Parallel-run validation** (Day 3)
   - Run Cloud Run + Mac mini side-by-side for 3 days
   - Compare Firestore matching-jobs deltas — must converge
   - Diff webhook payloads (Stream-A2 fires from BOTH)
   - Add a `pipelineSource: "cloud-run" | "mac-mini"` field to `pa-matching-pipeline-runs` so we can distinguish
   - Deliverable: 3 consecutive days both write same job count ±5% (allowing for Firecrawl variance)

4. **Cutover + decommission** (Day 4)
   - Disable Mac mini crontab (commented out — keep file for emergency rollback)
   - Cloud Run becomes sole producer
   - Update V1.5-ROLLOUT.md + V1.6-ROLLOUT.md
   - Add monitoring: Cloud Run job failure → PagerDuty / Slack alert
   - Deliverable: 7 days zero Mac mini executions, Firestore matching-jobs healthy

5. **Mac mini reuse plan** (Day 5)
   - Mac mini becomes a backup / dev environment, NOT production critical
   - Document: "Mac mini is no longer in the critical path; safe to reboot / shutdown / migrate"
   - Optional: keep crontab as warm spare (run on different schedule, write to `matching-jobs-shadow`)

---

## Acceptance criteria (UAT)

- [ ] Cloud Run Job runs daily at 06:00 PT for 7 consecutive days, zero failures
- [ ] Stream-A2 webhook fires from Cloud Run path, `pa-matching-pipeline-runs` shows `pipelineSource: "cloud-run"`
- [ ] Firestore `matching-jobs` collection grows ±5% same as historical Mac mini cadence
- [ ] Anthropic + Firecrawl spend tracked in cost-ledger (closes v1.6 backlog #21 partially)
- [ ] Mac mini crontab disabled, Adam confirms via `crontab -l`

---

## Risks / unknowns

1. **Firecrawl rate limits in container** — Mac mini has fixed IP; Cloud Run uses dynamic egress. Need to verify Firecrawl doesn't rate-limit / block dynamic egress. Mitigation: Cloud NAT with reserved IP if blocked.

2. **Anthropic cost during enrich** — On Mac mini we estimated $0 cost-tracked but real spend is unknown (v1.6 backlog #21). Migration is a good moment to wire `logTokenSpend()` properly (closes backlog #25).

3. **Long-running job state** — Mac mini logs to local disk; Cloud Run Job logs to Cloud Logging. Need to ensure `daily-update.sh` style logs survive; consider structured logging during migration.

4. **Webhook secret rotation** — Mac mini stores secret in `~/.env`; Cloud Run uses Secret Manager. Rotation plan: rotate at cutover + document.

---

## Out of scope for this phase

- Migrating Anthropic enrich to a separate worker (would split this into 2 phases)
- Replacing Firecrawl with another scraper (orthogonal)
- Removing the iMessage Mac mini worker (different concern — see [imessage_apple_id_tos.md](../memory/imessage_apple_id_tos.md))

---

## Trigger conditions for green-light

- Adam approves migration approach (Cloud Run vs Cloud Functions vs k8s job)
- Image registry quota approved
- Cloud Run Jobs API enabled on `wekruit-5f89b` (currently unknown state)

---

**Status**: Pending Adam decision. To plan: `/gsd:plan-phase 60 --research` after approval.
