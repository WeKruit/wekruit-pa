# Phase 27 — PLAN (5-task spec)

**Status:** Plan-only until hard gate opens (see CONTEXT.md). This PLAN replaces the P9 placeholder with a proper 5-sub-task breakdown locked by the v1.2 P10 strategic cut (`.planning/v1.2-p10-strategic-cut.md`).

**P10-locked scope:**
Qwen rewriter circuit breaker + Qdrant↔Firestore drift cron + 5×CF /health endpoint + SLO + error-budget config + self-evolve cron (daily transcript→judge→cluster→Bible patch PR→eval gate).

**Total estimate:** ~5 dev-day across 1-2 P8s. T1-T4 parallelable; T5 is sequential and gated.

---

## ⛔ Hard gate (record explicitly — most critical part)

T5 (self-evolve cron) deploy is gated by **all three** of:

1. Phase 26 P0 ships AND runs stable for ≥2 calendar weeks (cost alerts and rate-limit do NOT fire spuriously)
2. ≥200 voice reviews collected in `pa_voice_reviews` (Phase 25 dashboard)
3. Adam manually flips `selfEvolveEnabled = true` via dashboard `/admin/flags` (audit row in `pa_audit_events`)

**Permanent rules (never relaxed):**
- Cron writes a GitHub PR via `gh pr create`. NEVER force-push, NEVER auto-merge.
- DeepEval golden-50 score on the proposed PR branch must be **≥ current baseline** (`eval-results/baseline.json`) for merge eligibility.
- HITL approval (Adam) required on every Bible patch PR. The eval gate is necessary but not sufficient.

T1-T4 may land **before** the gate opens — they are infra-only, no auto-write to Bible.

---

## T1 — Qwen rewriter circuit breaker

**Goal:** Stop pounding a dead Qwen endpoint. After 5 consecutive 404/timeout failures, open the breaker, flip `paVoiceRewriterEnabled` to `false`, alert Adam, and fall back to nano-only output until manual reset.

**Files:**
- `packages/pa-orchestrator/src/voice/qwen-breaker.ts` (new) — breaker state machine (CLOSED / OPEN / HALF_OPEN)
- `packages/pa-orchestrator/src/voice/rewriter.ts` (modify) — wrap fetch in breaker
- `apps/functions/src/index.ts` (modify) — surface breaker state via `/health`
- Firestore collection `pa_circuit_breaker/{name}` — `{state, openedAt, attemptCount, lastError}`
- Read flag via `getFlag('paVoiceRewriterEnabled', ctx)` (Phase 24.5 SDK)

**Detailed deliverables:**
1. State machine: 5 consecutive failures (404 OR timeout >2s) within 5-min window → OPEN. After 60s in OPEN → HALF_OPEN (single probe). Probe success → CLOSED. Probe fail → OPEN reset.
2. On transition to OPEN: write `pa_circuit_breaker/qwen-rewriter` doc, write `pa_audit_events` row, call `setFlag('paVoiceRewriterEnabled', false, { reason: 'circuit-breaker-open' })`.
3. Alert: write `pa_abuse_events` row of type `circuit_breaker_open` (operator dashboard already surfaces these).
4. Fallback path: rewriter.ts returns nano output unchanged when breaker OPEN. No silent retry storm.
5. Manual reset: dashboard `/admin/flags` re-flip + delete breaker doc → CLOSED.

**DONE verification:**
```bash
# unit test: simulate 5 failures, expect OPEN
pnpm --filter pa-orchestrator test -- qwen-breaker
# integration: stub Qwen 404 → check breaker doc + flag flip + audit row
pnpm --filter pa-orchestrator test -- qwen-breaker.integration
```

**Estimated time:** ~0.5 day.

---

## T2 — Qdrant ↔ Firestore memory drift cron

**Goal:** Detect divergence between Firestore `pa_memories` (source of truth) and Qdrant vector index (recall layer). Daily cron emits drift count metric, alerts Adam if drift > 1%.

**Files:**
- `apps/functions/src/memory-drift.ts` (new) — Cloud Scheduler-driven CF, runs 02:00 UTC daily
- `packages/pa-orchestrator/src/memory/drift-check.ts` (new) — pure compare logic (testable)
- Firestore: writes `pa_drift_runs/{runId}` with `{startedAt, fsCount, qdrantCount, missingInQdrant[], orphansInQdrant[], driftPct}`
- Cloud Logging metric: `pa.memory.drift_pct` gauge

**Detailed deliverables:**
1. Page through Firestore `pa_memories` + Qdrant scroll API, build set difference by `memoryId`.
2. `driftPct = (missingInQdrant + orphansInQdrant) / fsCount`. Alert via `pa_abuse_events` (type `memory_drift_alert`) when > 1%.
3. Run summary in `pa_drift_runs/{date}` (one doc/day; idempotent re-run within day overwrites).
4. Soft-cap scan: 50k memory ceiling for v1; if exceeded, emit `pa.memory.drift_skipped_oversize` and bail (Phase 28+ pages).
5. Cloud Scheduler config: `0 2 * * *` UTC. Cron name `paMemoryDriftCheck`.

**DONE verification:**
```bash
# unit
pnpm --filter pa-orchestrator test -- drift-check
# manual smoke against staging Firestore + Qdrant
PA_DRIFT_DRY_RUN=1 npx tsx apps/functions/src/memory-drift.ts
# expect log: "drift 0.4% (3 missing / 0 orphan / 712 fs)"
```

**Estimated time:** ~1 day.

---

## T3 — CF `/health` endpoints (×5)

**Goal:** Each CF exposes a `/health` route returning JSON `{ok, version, deps: {...}}` for liveness probing + dashboard wiring.

**Files (all modified):**
- `apps/functions/src/sendblue/webhook.ts` — `paSendblueWebhook` /health
- `apps/functions/src/sendblue/outbox.ts` — `paSendblueOutbox` /health
- `apps/functions/src/index.ts` — `onPaInbound` /health
- `apps/functions/src/proactive-sweep.ts` — `paProactiveSweep` /health
- `apps/functions/src/memory-admin.ts` — `memoryAdmin` /health

**Detailed deliverables:**
1. Each /health returns `{ok: true, version: process.env.GAE_VERSION || 'dev', deps: { firestore: ok|fail, qdrant?: ok|fail, sendblue?: ok|fail, openai?: ok|fail }, breaker?: { qwen: state }}`.
2. Dependency probes have a 1.5s timeout; on timeout, return `ok: false` with the failed dep listed but HTTP 200 (so probes can read body).
3. No auth required (liveness probe pattern). Path is exactly `GET /health`. Other methods → 405.
4. Dashboard `/operations` page adds a "CF Health" card polling all 5 every 30s (separate plan in P9-Voice if not already covered — out of scope here, only wire endpoints).

**DONE verification:**
```bash
pnpm --filter functions build && pnpm --filter functions test -- health
# emulator
firebase emulators:start --only functions
for cf in paSendblueWebhook paSendblueOutbox onPaInbound paProactiveSweep memoryAdmin; do
  curl -s "http://localhost:5001/.../${cf}/health" | jq .ok
done
# expect: 5 × `true`
```

**Estimated time:** ~0.5 day.

---

## T4 — SLO + error-budget config (Cloud Logging metrics)

**Goal:** Define explicit SLOs (latency, availability, voice quality) and an error-budget burn-rate policy. All driven by Cloud Logging log-based metrics; no code in the hot path.

**Files:**
- `infra/slo/slo.yaml` (new) — declarative SLO spec
- `infra/slo/burn-rate-alerts.yaml` (new) — multi-window burn-rate alert config (1h fast burn / 6h slow burn)
- `infra/slo/log-based-metrics.tf` (new) — Terraform for Cloud Logging metric extractors (latency histogram, error counter, voice-quality gauge from review writes)
- `apps/dashboard-web/src/pages/Operations.tsx` (modify, minor) — surface error-budget remaining %

**Detailed deliverables:**
1. SLO targets (Adam to confirm in CONTEXT.md TODO; defaults proposed):
   - `paSendblueWebhook` p95 latency < 800ms over 30 days, 99% target
   - End-to-end orchestrator turn p95 < 4s, 95% target
   - Availability (`/health` returns ok) ≥ 99.5% / 30 days
   - Voice quality: ≥75% of `pa_voice_reviews` rated ≥3⭐ over rolling 7 days
2. Log-based metrics extracted from existing structured logs (no new instrumentation needed for latency/availability; voice quality reads `pa_voice_reviews` aggregate via scheduled CF that emits gauge).
3. Burn-rate alerts: 14.4× burn over 1h OR 6× burn over 6h → page Adam.
4. Dashboard `/operations` "Error Budget" card showing remaining % per SLO + sparkline.

**DONE verification:**
```bash
# terraform validate
cd infra/slo && terraform init && terraform plan
# log-based metric query in staging
gcloud logging metrics list --filter="name:pa_*"
# unit test for budget % calc
pnpm --filter dashboard-web test -- error-budget
```

**Estimated time:** ~1 day.

---

## T5 — Self-evolve cron (HARD-GATED)

**Goal:** Daily cron reads low-rated `pa_voice_reviews`, clusters by violation tag, generates a Bible patch suggestion, opens a GitHub PR. Merge gated by DeepEval ≥ baseline + Adam HITL review.

**⛔ Hard gate (re-stated):** All three of P26 stable 2 weeks + ≥200 reviews + `selfEvolveEnabled=true`. Until gate opens this code is `if (!flag) return;`-guarded and never enqueues work.

**Files:**
- `apps/functions/src/self-evolve-cron.ts` (new) — main scheduled CF (Cloud Scheduler `0 3 * * *` UTC)
- `packages/pa-orchestrator/src/self-evolve/cluster.ts` (new) — cluster low-rated turns by tag + sub-pattern
- `packages/pa-orchestrator/src/self-evolve/patch-gen.ts` (new) — LLM-driven Bible diff suggestion (uses existing nano judge for proposal generation)
- `packages/pa-orchestrator/src/self-evolve/pr-opener.ts` (new) — `gh pr create` wrapper using GH App token from Secret Manager
- `.github/workflows/voice-eval-gate.yml` (new) — CI workflow that runs `PA_RUN_EVAL=1 deepeval test run` on the proposed branch and fails if score < `eval-results/baseline.json`
- Firestore: `pa_self_evolve_runs/{runId}` with `{startedAt, reviewsScanned, clusters[], proposedDiff, prUrl, evalScoreOnBranch, evalBaseline, gateResult}`

**Detailed deliverables:**
1. Read `pa_voice_reviews` where `rating <= 2` AND `createdAt >= now-24h`. If <10 rows → no-op + log.
2. Cluster by violation tag (`probe`/`diagnose`/`too_long`/`tone`/`ai_speak`). Drop clusters with <3 members.
3. For each cluster of size ≥3, build a patch-gen prompt: cluster examples + current Bible v7 section → suggest 1 paragraph addition or rule. Limit to 1 cluster per cron run (smallest, safest change first).
4. Open PR via `gh pr create` from a fresh branch `self-evolve/<runId>` with the diff. PR body: cluster summary + sample turns + eval baseline + gate criteria checklist.
5. CI workflow `voice-eval-gate.yml` triggers on PR label `self-evolve` (cron applies label automatically). Runs golden-50 against the patched Bible. Fails CI if score drops below baseline.
6. **Never auto-merge.** PR remains open until Adam reviews + merges. Cron writes the PR URL to `pa_self_evolve_runs` for dashboard surfacing.
7. Per-run rate cap: 1 PR per 7 days max (additional check on `pa_self_evolve_runs`). Prevents drift.
8. Kill switch: `selfEvolveEnabled=false` → cron exits early with audit row.

**DONE verification:**
```bash
# unit
pnpm --filter pa-orchestrator test -- self-evolve
# dry run (no PR open)
PA_SELF_EVOLVE_DRY_RUN=1 npx tsx apps/functions/src/self-evolve-cron.ts
# expect: prints proposed diff, exits 0, no PR created
# eval gate locally
PA_RUN_EVAL=1 deepeval test run apps/eval/voice/test_voice_baseline.py
# integration (gated): only after gate-3 conditions met
PA_SELF_EVOLVE_LIVE=1 npx tsx apps/functions/src/self-evolve-cron.ts
# expect: PR opened on dry branch + pa_self_evolve_runs row written
```

**Estimated time:** ~2 days.

---

## Sub-task summary

| ID | Title | Dep | Time | Gate |
|----|-------|-----|------|------|
| T1 | Qwen rewriter circuit breaker | none | 0.5d | none (lands anytime) |
| T2 | Qdrant ↔ Firestore drift cron | none | 1d | none |
| T3 | 5 × CF `/health` endpoints | none | 0.5d | none |
| T4 | SLO + error-budget config | T3 (probes) | 1d | none |
| T5 | Self-evolve cron + eval gate | T4 (budget context, soft) | 2d | **HARD GATE** |

T1-T4 can ship as a single P8 wave 5 dev-days before T5 unlocks. T5 only ships once all three gate conditions met.

## Adam decisions still owed (before T4/T5 spawn)

- [ ] Confirm SLO latency/availability targets (defaults proposed in T4 §1)
- [ ] Confirm Bible PR review SLA (Adam responds within X hours of PR open?)
- [ ] Confirm self-evolve cron schedule (`0 3 * * *` UTC reasonable?)
- [ ] Confirm GH App token provisioning path (Secret Manager `SELF_EVOLVE_GH_TOKEN`)
