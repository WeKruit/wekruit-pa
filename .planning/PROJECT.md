# Jobless / PA Platform

Monorepo: Mac **Photon iMessage worker** (deprecating to Sendblue) + Firestore **`pa_*`** + **PA Console** (Vite, `wekruit-pa.web.app`). Auth: Google; Firestore rules: `@wekruit.com` + allowlisted Gmail (see `config/firebase/firestore.rules`).

## Current State

**Shipped:** v1.6 — Unified Canonical Tags & Match Quality v1 (2026-05-06)

- All 11 phases (52-62) shipped + production-deployed.
- 59/59 REQ-IDs satisfied.
- 32 commits, 125 files, +23,039 -225 LOC.
- Cloud Functions: `paLivenessSweepDaily` 03:00 UTC, `paLlmRerankNightly` 04:00 UTC, `paQaEvaluatorWeekly` Mon 09:00 UTC, `paPromoteSandboxTag`, plus extended `paSendblueWebhook` + `cv-ingest` + `paJobRecDaily`.
- Hosting: `https://wekruit-pa.web.app` with `/admin/canonical-tags`, `/admin/qa-evaluator`, `/admin/onboarding-questions` extended.
- See `.planning/milestones/v1.6-ROADMAP.md` (full archive) + `.planning/v1.6-MILESTONE-AUDIT.md` (audit) + `.planning/MILESTONE-v1.6-unified-tags.md` (architecture).

**Milestone closure (GSD):** before archiving a version, run **`$gsd-audit-milestone`** and/or follow [.planning/GSD-AUDIT-MILESTONE.md](.planning/GSD-AUDIT-MILESTONE.md) so `v*-MILESTONE-AUDIT.md` stays authoritative.

## Next Milestone Goals (v1.7 — TBD)

Awaiting Adam direction. Likely candidates:
- Real Python port of canonical tags into wekruit-scraping (cross-repo parity)
- macmini Stage 2.5 url_resolver permanent fix or migration to wekruit-pa CF
- Daily-batch.ts legacy `queryMatchingJobs` deletion (deferred from v1.6 for backwards compat)
- Match quality tuning post-data-ramp (ship gate signal calibration)

<details>
<summary>v1.6 milestone description (archived)</summary>

**Status:** Started 2026-05-05. Defining requirements.

**Goal:** Single source-of-truth tag system + match quality overhaul. Replace fragmented industry/skill/topSkill logic across `cv-ingest` + `parsedCandidateResumes` + `pa-users` + `matching-jobs` with canonical 2-axis vocab in `packages/shared-tags` (already exists, extend). Match flow: hard filter → soft score → LLM rerank async → emb fallback. Reduce regex, prefer LLM judgment.

**Two orthogonal axes (Adam-locked):**

1. **`roleFunction`** — closed enum 17, jobright `utm_campaign` verbatim (`software_engineering`, `customer_service_and_support`, `legal_and_compliance`, `sales`, etc — no abbreviations). Hard filter axis.

2. **`industrySector`** — closed enum 42, full spell-out (`crypto_web3_blockchain`, `gaming_and_esports`, `artificial_intelligence_and_machine_learning`, `accessibility_and_assistive_technology`, etc). Add-able via dashboard (sandbox → promote pattern). Soft score axis.

**Target features:**

- **Canonical Tag Vocab Extension** — extend `packages/shared-tags` with all axes (roleFunction 17 / industrySector 42 / major 45 / visa 4 / jobType 10 / careerStage 13 / location 130+ / relevantTags open / skills open + bucket + per-skill weight). All values spelled out, **zero abbreviations**.
- **CV Parse Wired to pa-resume-parser v2** — extract `relevantIndustry / relevantSpecialization / proposedTags` parse-time. LLM chain `gpt-5.4-nano → claude-sonnet-4-6 → gpt-4.1-mini`. Post-parse Claire dialogue for user confirmation. Fail-open + idempotent.
- **Unified `pa-users/{userId}.tags`** — both `cv-ingest` + `chat answers` write here. Single read-side for `generateJobRecs`. Migration script for existing users.
- **Match Quality Overhaul** — hard filter (`roleFunction` / `visa` / `location` / `careerStage` / `jobType` / `firstSeenAt < 20d` / `atsApplyUrl present + not jobright` / `dead !== true`) → soft score (`llm_match 0.40` / `skill_jaccard 0.20` / `relevantTags 0.15` / `industrySector 0.10` / `cv_emb_cosine 0.10` / `salary_fit 0.05`). Per-skill base weight + JD-relative weight (Qwen-7B nightly batch). Daily 404 sweep. `__PA_FIND_MATCH__` dev trigger.
- **Industry Vocab Dashboard** — admin page reads/writes canonical vocab + sandbox promotion + count visible.
- **QA Evaluator Thread** — separate weekly auto-run sampling 100 user×match pairs, scores hard-filter pass + top-3 acceptable rate. Surfaces to dashboard. Loops until satisfying.

**Key constraints (Adam-locked, 16 decisions):**
- D1: roleFunction = jobright 17 verbatim
- D2: industrySector = 42 add-able via dashboard
- D3: major = soft score (not hard filter)
- D4: visa = 4 enum (`citizen, permanent_resident, sponsor_needed, other`)
- D5: **NO abbreviations** in any closed vocab (LLM confusion risk)
- D6: relevantTags / proposedTags parse-time extract (in pa-resume-parser schema)
- D7: per-skill base weight + JD-relative weight (per-job re-rank)
- D8: unified `pa-users/{userId}.tags` single source
- D9: match cascade: hard filter → skill+relevant+industry score → JD-CV LLM rerank async → emb cosine fallback
- D10: 20d `firstSeenAt` window + 404 daily pipeline, **abandon `lastSeenAt`**
- D11: cv-ingest wires `pa-resume-parser` v2 (not single-shot gpt-5.4-nano)
- D12: post-parse Claire dialogue confirm understanding
- D13: QA evaluator thread runs weekly auto-eval
- D14: `__PA_FIND_MATCH__` dev trigger (mirrors `__PA_RESET__` pattern)
- D15: reduce regex, prefer LLM judgment for ambiguous classification
- D16: industry vocab add-able via dashboard

**Stack constraints:**
- TypeScript / Node / Firebase Cloud Functions Gen2
- LLM chain: `gpt-5.4-nano → claude-sonnet-4-6 → gpt-4.1-mini` (3-tier retry, Sonnet now in chain)
- Embedding: `text-embedding-3-small` 1536d (OpenAI direct, sync at cv-ingest)
- LLM rerank: SiliconFlow Qwen-7B-Instruct JSON-mode (async batch, latency-tolerant)
- Budget: < 12s p99 per match request (sync) · < 24h for nightly LLM rerank batch
- No new monorepo packages — extend `packages/shared-tags` + `packages/pa-resume-parser`
- Cross-repo (wekruit-scraping) wire deferred to v2 — matching-jobs Firestore re-tag in scope

**Success metrics (5):**
1. SWE candidate Adam (userId `e5d97cd8-1e1d-439d-8672-3008f8aeef2e`, CV doc `rQIqQEghvZLwVkMad2lJ`) → BDR/sales/cashier/warehouse leak rate **100% → < 5%**
2. Match URL realness: jobright.ai-leaked recommendation rate **50%+ → 0%**
3. industryTags accuracy on Adam: **`["other"] → ["artificial_intelligence_and_machine_learning", "technology_general"]`**
4. Per-job reasoning surfaces top-2 JD-aligned weighted skill matches
5. QA evaluator pass rate: hard filter 100% (no leak), soft score top-3 acceptable rate **≥ 70%** weekly auto-sample

**Backlog (out of scope this milestone):**
- scraping-side Python tag emit (defer to v2)
- cross-repo `pa-tag-events` wire from wekruit-scraping (defer)
- UK visa sponsor matching (NA-only focus)
- Reverse-match recruiter agent overhaul

**Estimate:** ~10-14 dev-days across 8-10 phases (eval-first ordering).

</details>

## Previous Milestone: v1.5 — Friend-Companion Job-Rec System — ✅ SHIPPED 2026-05-02

14/14 phases (41-51, including 43.5 / 47.1) shipped in single autonomous session. See [`.planning/STATE.md`](./STATE.md) for full table. Live ship gated on Adam HITL queue per [`V1.5-ROLLOUT.md`](./V1.5-ROLLOUT.md).

## Previous Milestone (v1.4): Humanize-Runtime v2 (Bilingual, Eval-First) — ✅ BUILD COMPLETE 2026-04-30

**Status:** 12/12 phases shipped (Stream A 29-32 + Stream C 33-40). Audit: `.planning/v1.4-MILESTONE-AUDIT.md`.
**Verdict:** passed_with_deferrals — 3 of 5 hard-gate metrics PASS (AI tell-tale 0%, drift p95 3.77% beats target 4.9% by 61% reduction, length compliance 100%); 2 metrics deferred pending Adam P0 unblocks (judge budget $0.50-$2 for metric 3, BGE_API_KEY env for metric 5).
**Live ship gated on:** 11 Adam P0 actions consolidated in audit doc — wire-in patch (`.planning/phases/40-bible-v7.5-ship/WIRE-IN-PATCH.md` ~2-3hr), handbook + Bible v7.5 migrations, Secret Manager provisioning, feature flag flip 1% → 100%.

**Canonical doc:** [`.planning/MILESTONE-v1.4-humanize-runtime-v2.md`](./MILESTONE-v1.4-humanize-runtime-v2.md).
**Final audit:** [`.planning/phases/40-bible-v7.5-ship/final-audit-report.md`](./phases/40-bible-v7.5-ship/final-audit-report.md).
**Baseline + gates:** [`.planning/baseline-rev00056.md`](./baseline-rev00056.md).

**Goal:** On Qwen-7B + no-finetune + Bible-driven path, push Claire's bilingual (zh+en) conversational humanness to ~70-80% of Pi-level by attacking 4 production failure modes (verb-mirror / length escalation / code-switch drift / self-repeat advice) with deterministic detectors + ImperfectionInjector + ESConv-FSM + memory policy. Eval-first ordering: no runtime module work until baseline 5-metric report is locked. 0 net new LLM calls in production path.

**Target features:**
- **Eval Harness Extension** — 4 new axes (drift_resistance, length_compliance, advice_novelty, strategy_fit) wired into existing `tests/scenarios/lib/voice-axes.mjs`
- **Baseline Measurement** — locked 5-metric report on rev-00056 before any module work
- **4 Deterministic Detectors** — F1 verb-mirror n-gram (zh char 3-gram + en bigram) / F2 length cap / F3 lang-lock / F4 advice-repeat via BGE-M3 cos-sim
- **ImperfectionInjector** — 3-arm A/B (0/15/30%), turn-onset position-constrained, bilingual policies (zh + en), self-correct > hesitate > clarify > uncertainty
- **FSM (5 UX × ESConv 8 strategies)** — state classifier + transition table per TransESC pattern; Phase 3 prompt directive
- **Memory Policy** — advice-tracker + contradiction detector via existing Mem0 + BGE-M3
- **Bible v7.5** — bilingual NEVER + zh+en slang bank + crisis safety prompt + 3-sentence cap directive
- **External Auto Benchmarks** — BotChat (auto Turing-style bilingual) + CharacterEval (ZH) + EmpatheticDialogues (EN) + ESConv (EN) + RoleLLM (EN); Qwen-7B raw vs Qwen-7B + Claire stack

**Key constraints (Adam-locked):**
- No model escalation (Qwen-7B class only via SiliconFlow OpenAI-compat)
- No fine-tuning
- 0 net new LLM calls in production path; < 12s p99 per turn
- No LangGraph, no DSPy, no Reflexion-lite critic loop
- No new monorepo package — extend `packages/pa-orchestrator/src/voice/`
- Embedding stack: `BAAI/bge-m3` via SiliconFlow (already wired)

**Estimate:** ~7.5 dev-days (8 phases, 33-40).

## Previous Milestone (v1.1): Pre-Launch Hardening + Companion Brain

**Execution plan (build order, QA, security wiring, channel architecture, report):** [`.planning/v1.1-EXECUTION-PLAN.md`](./v1.1-EXECUTION-PLAN.md).

**Goal:** Take WeKruit PA from alpha-grade demo to closed-beta launchable (≤20 hand-picked users) within 3 weeks. Fix the "robotic" companion voice via prompt structure (no model escalation), replace single-host iMessage worker with hosted transport (Sendblue), close safety/normalization gaps, and revive proactive check-in.

**Target features:**
- **Companion Voice v1** — system prompt rewrite (Snapchat MyAI skeleton + Tendera "facts as voice" + Meta filler-ban eval), 5-axis eval rubric, stays on gpt-5.4-nano
- **Adaptive Mirror Layer** — per-turn user-style analyzer (mirror register/language ratio/emoji freq) + dynamic persona injection + long-term mem0 preference learning
- **Output Normalizer** — channel-agnostic post-LLM normalization (strip markdown, strip UTM tracking, length cap)
- **Sendblue Channel Migration** — webhook handler in CF + REST send + deprecate `apps/macos-imessage-worker` (eliminates single-host risk + Apple-ID ToS exposure)
- **Proactive Check-in** — dashboard trigger UI + `pa_scheduled_jobs` cron + orchestrator proactive-turn path (revived from skipped Phase 12)
- **Closed Beta Onboarding** — 20 hand-picked users flow + `pa_abuse_events` producers wired

**Key constraints (Adam-locked):**
- No model escalation (no Sonnet); voice fix via prompt structure on nano
- No fine-tuning (no anchor data yet)
- No negative-instruction blacklists in system prompt (small-model token activation risk); blacklists go in eval LLM-judge auto-fail criteria only
- Keep Mem0/Qdrant + Memory Admin (don't replace)
- iMessage Apple-ID violation tolerated for ≤20 closed beta; Sendblue migration before public launch

**Research saved:**
- `.planning/phases/17-pre-launch-hardening/17-CONTEXT.md`
- `.planning/phases/17-pre-launch-hardening/17-RESEARCH-companion-voice.md`
- `.planning/phases/17-pre-launch-hardening/17-RESEARCH-raw-artifacts.md`

## Previous Milestone (v1.0): Agent SDK Runtime + Job Companion (foundational)

**Goal:** Turn the working local iMessage E2E into an agentic job-search companion: OpenAI Agents SDK as the runtime spine, WeKruit-owned identity/memory/audit controls, safe live current-info retrieval, and proactive recruiter-style follow-up.

The real iMessage path is green: inbound creates durable `pa_inbound_events`, orchestrator completes turns, transcript writes, `pa_outbound` sends, reset works, and cross-turn memory recall has been validated. Phase 2 harness now uses broker injection with `suppressOutbound` so production scenarios do not send real iMessages. Phase 3 Memory Admin is live in PA Console.

Current-info is in transition: stale “recent/latest” questions no longer fall through to old model knowledge, and `main` is moving the `current-info` connector from hand-written Responses API fetches to OpenAI Agents SDK hosted `web_search`. Production enablement uses one general OpenAI agent/tool secret, `PA_OPENAI_AGENT_API_KEY`, plus a functions deploy and live harness verification.

### Current milestone targets

- **OpenAI Agents SDK becomes the runtime spine** for OpenAI-native tools and future agent workflows. Avoid long-lived hand-written Responses fetch wrappers when the Agents SDK exposes the hosted tool directly.
- **One OpenAI agent/tool secret**: use `PA_OPENAI_AGENT_API_KEY` for official OpenAI Agents SDK hosted tools. Do not keep a current-info-specific key name.
- **WeKruit keeps product control**: identity, memory, scheduling, outbound policy, audit, dashboard, and user consent stay in Firestore/PA Console, with context injected into agent turns instead of outsourced to opaque ChatGPT product memory.
- **Mem0/Qdrant + Memory Admin stay**: semantic recall remains inspectable/deletable in PA Console. OpenAI file/vector search can be evaluated later as another provider, not as an immediate replacement.
- **Job companion direction**: PA should become a personal job-search companion/recruiter presence that periodically asks about projects/job-search status and proactively notifies users about matched roles when allowed.

### Product direction

- **iMessage worker remains a channel adapter**: no agent brain and no duplicate transcript writes for broker-managed outbound.
- **Firestore remains the control plane**: durable queues, transcripts, agent configs, operation state, persona/evolution facts, and audit trails.
- **SiliconFlow can remain the OpenAI-compatible model path**, but OpenAI-native hosted tools and agent workflows use OpenAI Agents SDK through `PA_OPENAI_AGENT_API_KEY`.
- **Mem0 is optional semantic recall**: self-hosting is a future capability, not a hard dependency for core replies.
- **Dashboard must become an operator product**, not a raw Firestore table viewer.
- **Current-info must fail closed**: if realtime search is unavailable, PA says it cannot reliably answer rather than giving stale movies/news/weather/prices.
- **Proactive outreach must be permissioned**: scheduled nudges, job-match notifications, and recruiter-style follow-up require cooldowns, audit events, and a clear outbound policy.

See `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`.

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---

*Last updated: 2026-05-06 — Milestone v1.6 (Unified Canonical Tags & Match Quality v1) shipped. All 11 phases (52-62) deployed. Audit: 59/59 REQ satisfied, tech_debt status (no blockers). v1.7 spawn pending Adam direction.*
