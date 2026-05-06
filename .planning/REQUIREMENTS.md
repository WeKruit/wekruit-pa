# Requirements

This file is append-only across milestones. Active milestone requirements at top; prior milestone requirements preserved below for traceability.

**Last updated:** 2026-05-05 (v1.6 spawned)

---

## v1.6 Active Requirements — Unified Canonical Tags & Match Quality v1

**Milestone goal:** Replace fragmented tag system with single canonical source + match quality overhaul. Two orthogonal axes (`roleFunction` 17, `industrySector` 42). Hard filter → soft score → LLM rerank → emb fallback. All vocab spelled out, no abbreviations.

### Canonical Tag Vocab (TAG)

- [ ] **TAG-01**: System provides closed-enum `roleFunction` vocab — 17 jobright `utm_campaign` values verbatim (`software_engineering`, `engineering_and_development`, `data_analysis`, `product_management`, `business_analyst`, `creatives_and_design`, `consultant`, `accounting_and_finance`, `marketing`, `management_and_executive`, `sales`, `human_resources`, `legal_and_compliance`, `arts_and_entertainment`, `education_and_training`, `public_sector_and_government`, `customer_service_and_support`).
- [ ] **TAG-02**: System provides closed-enum `industrySector` vocab — 42+ spelled-out values, no abbreviations (incl. `crypto_web3_blockchain`, `gaming_and_esports`, `artificial_intelligence_and_machine_learning`, `accessibility_and_assistive_technology`).
- [ ] **TAG-03**: System provides closed-enum `major` vocab — 45+ spelled-out values; used as soft-score signal not hard filter.
- [ ] **TAG-04**: System provides closed-enum `visa` vocab — exactly 4 values: `citizen`, `permanent_resident`, `sponsor_needed`, `other`.
- [ ] **TAG-05**: System provides closed-enum `jobType` vocab — 10 spelled-out values (`full_time`, `internship`, `new_graduate`, `contract`, `part_time`, `fellowship`, `apprenticeship`, `freelance`, `return_to_work_program`, `co_op_rotation`).
- [ ] **TAG-06**: System provides closed-enum `careerStage` vocab — 13 spelled-out values for hard-seniority filtering.
- [ ] **TAG-07**: System provides closed-enum `location` vocab — 130+ spelled-out values (US/CA/EU/APAC/LATAM/MEA + remote variants).
- [ ] **TAG-08**: System provides open-vocab `relevantTags` (sandbox, max 12/profile, lowercase pattern `[a-z][a-z0-9_]{1,79}`) for niche tags.
- [ ] **TAG-09**: System provides bucketed open-vocab `skills` (10 buckets) with per-skill `name` (no abbrev), `bucket`, `proficiency`, `evidenceCount`, `baseWeight`.
- [ ] **TAG-10**: All canonical vocabs live in `packages/shared-tags` single source. No vocab duplication.
- [ ] **TAG-11**: Industry vocab is add-able by admin without code change — sandbox → review → promote-to-canonical button on dashboard. Promotion writes to Firestore overlay.
- [ ] **TAG-12**: Vocab tokens validated zod schema at write-time — no spaces, no abbreviations, lowercase + underscore only. Abbreviation reject with explanation.

### CV Parse Pipeline (PARSE)

- [ ] **PARSE-01**: `cv-ingest` Cloud Function uses `packages/pa-resume-parser` v2 `parseResumeText`. Removes inline single-shot LLM call.
- [ ] **PARSE-02**: LLM router chain is `gpt-5.4-nano (primary) → claude-sonnet-4-6 (fallback) → gpt-4.1-mini (final)`. Sonnet-4-6 reintroduced.
- [ ] **PARSE-03**: pa-resume-parser schema extended with `relevantIndustry: string[]` parse-time extract from work-history.
- [ ] **PARSE-04**: pa-resume-parser schema extended with `relevantSpecialization: string[]` parse-time extract.
- [ ] **PARSE-05**: pa-resume-parser schema extended with `proposedTags: string[]` (max 12, sandbox) parse-time extract.
- [ ] **PARSE-06**: cv-ingest writes raw to `parsedCandidateResumes` AND triggers tag merger to `pa-users/{userId}.tags` in same execution. Tag merge fail-open.
- [ ] **PARSE-07**: Post-parse Claire dialogue confirms understanding ("我看到你: <skills+companies+roles+relevantTags>; 对吗?"). User correction writes back to tags.
- [ ] **PARSE-08**: Industry classification reduces regex reliance — when LLM emits `["other"]`, system asks LLM (Sonnet-4-6 fallback) for second pass with explicit reasoning prompt.
- [ ] **PARSE-09**: cv-ingest is idempotent — re-parsing same PDF (same sha256) returns existing record, no duplicate side-effects.

### Unified User Tag Store (USER-TAG)

- [ ] **USER-TAG-01**: Every user has unified `pa-users/{userId}.tags` document with full canonical schema. Missing-tag user surfaced to admin as inconsistent.
- [ ] **USER-TAG-02**: cv-ingest writes `tags.skills` (full list, not truncated to top 12) + `tags.industrySector` + `tags.relevantIndustry` + `tags.relevantSpecialization` + `tags.proposedTags` + `tags.embedding` + `tags.lastUpdatedFromCv`.
- [ ] **USER-TAG-03**: Onboarding chat answer hooks write to `tags.targetRole` / `tags.yoeRange` / `tags.visaStatus` / `tags.prefersStartup` / `tags.targetLocations` / `tags.preferredLang` / `tags.lastUpdatedFromChat`.
- [ ] **USER-TAG-04**: Migration script ports existing 100+ users from fragmented data into `pa-users.tags`. Idempotent.
- [ ] **USER-TAG-05**: `mergeUserTags()` lib (iter34 H.1 commit `253ce87`) is the only writer. No direct `pa-users.tags` writes elsewhere.

### Match Quality Pipeline (MATCH)

- [ ] **MATCH-01**: `generateJobRecs` reads exclusively from `pa-users.tags` (single source). Removes legacy reads.
- [ ] **MATCH-02**: Firestore `matching-jobs` schema gains `roleFunction: string[]` + retains `industrySector: string[]`. Two orthogonal axes. Migration backfills 116K+ jobs from current `industry` field via deterministic mapper.
- [ ] **MATCH-03**: Firestore query uses `where('roleFunction', 'array-contains-any', user.targetRoleFunction)`. Limit raised from 50 to 500 fetch cap.
- [ ] **MATCH-04**: Hard post-filter chain: `visa intersect` → `location intersect (anywhere bypass)` → `careerStage window` → `jobType exact` → `firstSeenAt < 20d` → `atsApplyUrl present + not jobright.ai` → `dead !== true`.
- [ ] **MATCH-05**: Soft score weights: `llm_match 0.40` + `skill_jaccard 0.20` + `relevantTags 0.15` + `industrySector_overlap 0.10` + `cv_emb_cosine 0.10` + `salary_fit 0.05`. Sponsor/location removed from score (already hard-filtered).
- [ ] **MATCH-06**: Per-skill weight in `skill_jaccard` — base × JD-relative weight (LLM nightly tells which skills are JD-central).
- [ ] **MATCH-07**: Match recommendation message includes per-job reasoning showing top-2 weighted matched skills + reason.
- [ ] **MATCH-08**: 20-day freshness window using `firstSeenAt`. `lastSeenAt` deprecated.

### Liveness & 404 Pipeline (LIVE)

- [ ] **LIVE-01**: Daily 404 sweep Cloud Scheduler job HEAD-checks `matching-jobs.atsApplyUrl` for active jobs, marks `dead=true` on 404/410/500/timeout.
- [ ] **LIVE-02**: Sweep batch 500/min, concurrent 50, 100ms throttle. 30K active in < 60min. Re-checks dead jobs after 7d.
- [ ] **LIVE-03**: Dead jobs older than 30d after marking are hard-deleted from `matching-jobs`.
- [ ] **LIVE-04**: `paBackfillMatchingJobsAtsUrl` (iter34 G.3 commit `a56da02`) wired into daily sweep.

### LLM Async Rerank (RERANK)

- [ ] **RERANK-01**: Nightly batch Cloud Scheduler at 03:00 UTC runs LLM JD-CV match scorer using `Qwen/Qwen2.5-7B-Instruct` JSON-mode for top-50/active user.
- [ ] **RERANK-02**: Output stored in `pa-user-rerank-cache/{userId}` with `ranked` + `computedAt`. Read-side falls back if cache stale > 36h.
- [ ] **RERANK-03**: Async fire-and-forget llmRerank already wired (iter34 H.2 commit `c187c50`). Daily batch reuses same function.
- [ ] **RERANK-04**: Per-skill JD-relative weight stored as `pa-user-skill-jdrel-cache/{userId}/{jobId}`.

### Dashboard (DASH)

- [ ] **DASH-01**: Admin page `/admin/canonical-tags` reads `packages/shared-tags` vocab + Firestore overlay, displays all axes with counts.
- [ ] **DASH-02**: Admin page `/admin/canonical-tags` allows promoting sandbox `proposedTags` to canonical `industrySector`.
- [ ] **DASH-03**: Admin page `/admin/qa-evaluator` displays QA evaluator weekly run results.
- [ ] **DASH-04**: `/admin/onboarding-questions` extended with link to `pa-users.tags` view per user.

### Dev / Testing (DEV)

- [ ] **DEV-01**: `__PA_FIND_MATCH__` iMessage trigger forces `generateJobRecs` execution. Mirrors `__PA_RESET__`.
- [ ] **DEV-02**: Scenario runner gains `--user-id <uid>` flag for real user scenario runs.
- [ ] **DEV-03**: `dump-outbound-tail.mjs` extended with `--include-rerank-cache`.
- [ ] **DEV-04**: 5-persona fixture set committed under `tests/fixtures/v1.6-personas/` (SWE / PM / Designer / ML / Data Analyst).

### QA Evaluator Thread (QA)

- [ ] **QA-01**: Cloud Scheduler `paQaEvaluatorWeekly` runs Mon 09:00 UTC, samples 100 user×match pairs, computes hard-filter pass + top-3 acceptable rate via Qwen-7B.
- [ ] **QA-02**: Output written to `pa-qa-evaluator-runs/{runId}` with full sample + per-pair score + summary. Surfaced via `/admin/qa-evaluator`.
- [ ] **QA-03**: Evaluator emits Slack/email alert if pass rate < 90% hard filter or < 70% top-3 acceptable.
- [ ] **QA-04**: Evaluator prompt grounds judgment in candidate's `tags.targetRole` + `tags.relevantIndustry` + `tags.skills`. Explicit reasoning per match.
- [ ] **QA-05**: Failure-loop: failing pairs go to priority queue, next-week run re-evaluates same users. Until pass ≥ 90%/70%, milestone not-shipped.

### Documentation (DOC)

- [ ] **DOC-01**: `CLAUDE.md` updated with v1.6 design lock (16 decisions, 5 metrics, vocab references, match flow diagram).
- [ ] **DOC-02**: `.planning/MILESTONE-v1.6-unified-tags.md` written with full architecture diagram + vocab table + match flow + measurement protocol.
- [ ] **DOC-03**: `packages/shared-tags/README.md` updated with v1.6 vocab additions + sandbox-promotion pattern + cross-repo notes.
- [ ] **DOC-04**: wekruit-scraping repo gets `WEKRUIT_PA_TAG_HANDOFF.md` (cross-repo coordination message, no code change).

---

## v1.6 Future Requirements (deferred to v2.0+)

- **CROSS-REPO-PYTHON-PORT** — port `packages/shared-tags` types to `wekruit-scraping/researcher/pipeline/canonical_tags.py`.
- **SCRAPING-EMIT-TAG-EVENTS** — `wekruit-scraping/scripts/emit_tag_events.py` writer.
- **RECRUITER-AGENT-TAGS** — extend tag system to candidate-sourcing flows.
- **MULTI-LOCATION-WEIGHTING** — distance similarity weight (NYC ≈ Boston East-coast clustering).
- **SKILL-SIMILARITY-EMBEDDING** — pre-computed skill embedding dict for `python` ≈ `pyspark` semantic clustering.
- **RESUME-VARIANT-PER-JOB** — VALET-style per-job CV rewriting.

## v1.6 Out of Scope (explicit exclusions)

- **Cross-repo Python tag emit** — defer to v2.0.
- **UK / EU / non-NA visa types** — NA-only focus.
- **Recruiter agent overhaul** — already shipped v1.5.
- **Multi-language CV parse** — pa-resume-parser v2 English-only.
- **Job application auto-fill** — qaBank-to-mem0 already handles, no extension.
- **Real-time match notifications** — async daily batch only.

## v1.6 Traceability

Filled by roadmap 2026-05-05. **100% coverage: 59 REQ-IDs across 11 phases (52–62), no orphans, no duplicates.**

| REQ-ID | Phase | Status |
|---|---|---|
| TAG-01 | Phase 52 — Canonical Tag Vocab Foundation | pending |
| TAG-02 | Phase 52 — Canonical Tag Vocab Foundation | pending |
| TAG-03 | Phase 52 — Canonical Tag Vocab Foundation | pending |
| TAG-04 | Phase 52 — Canonical Tag Vocab Foundation | pending |
| TAG-05 | Phase 52 — Canonical Tag Vocab Foundation | pending |
| TAG-06 | Phase 52 — Canonical Tag Vocab Foundation | pending |
| TAG-07 | Phase 52 — Canonical Tag Vocab Foundation | pending |
| TAG-08 | Phase 52 — Canonical Tag Vocab Foundation | pending |
| TAG-09 | Phase 52 — Canonical Tag Vocab Foundation | pending |
| TAG-10 | Phase 52 — Canonical Tag Vocab Foundation | pending |
| TAG-11 | Phase 52 — Canonical Tag Vocab Foundation | pending |
| TAG-12 | Phase 52 — Canonical Tag Vocab Foundation | pending |
| PARSE-01 | Phase 53 — pa-resume-parser v2 wire + relevantTags extract | pending |
| PARSE-02 | Phase 53 — pa-resume-parser v2 wire + relevantTags extract | pending |
| PARSE-03 | Phase 53 — pa-resume-parser v2 wire + relevantTags extract | pending |
| PARSE-04 | Phase 53 — pa-resume-parser v2 wire + relevantTags extract | pending |
| PARSE-05 | Phase 53 — pa-resume-parser v2 wire + relevantTags extract | pending |
| PARSE-06 | Phase 53 — pa-resume-parser v2 wire + relevantTags extract | pending |
| PARSE-07 | Phase 53 — pa-resume-parser v2 wire + relevantTags extract | pending |
| PARSE-08 | Phase 53 — pa-resume-parser v2 wire + relevantTags extract | pending |
| PARSE-09 | Phase 53 — pa-resume-parser v2 wire + relevantTags extract | pending |
| USER-TAG-01 | Phase 54 — Unified pa-users.tags writer | pending |
| USER-TAG-02 | Phase 54 — Unified pa-users.tags writer | pending |
| USER-TAG-03 | Phase 54 — Unified pa-users.tags writer | pending |
| USER-TAG-04 | Phase 54 — Unified pa-users.tags writer | pending |
| USER-TAG-05 | Phase 54 — Unified pa-users.tags writer | pending |
| MATCH-02 | Phase 55 — matching-jobs schema migration + roleFunction backfill | pending |
| MATCH-01 | Phase 56 — queryMatchingJobs read pa-users.tags + filter + score | pending |
| MATCH-03 | Phase 56 — queryMatchingJobs read pa-users.tags + filter + score | pending |
| MATCH-04 | Phase 56 — queryMatchingJobs read pa-users.tags + filter + score | pending |
| MATCH-05 | Phase 56 — queryMatchingJobs read pa-users.tags + filter + score | pending |
| MATCH-06 | Phase 56 — queryMatchingJobs read pa-users.tags + filter + score | pending |
| MATCH-07 | Phase 56 — queryMatchingJobs read pa-users.tags + filter + score | pending |
| MATCH-08 | Phase 56 — queryMatchingJobs read pa-users.tags + filter + score | pending |
| LIVE-01 | Phase 57 — Liveness/404 sweep + atsApplyUrl backfill | pending |
| LIVE-02 | Phase 57 — Liveness/404 sweep + atsApplyUrl backfill | pending |
| LIVE-03 | Phase 57 — Liveness/404 sweep + atsApplyUrl backfill | pending |
| LIVE-04 | Phase 57 — Liveness/404 sweep + atsApplyUrl backfill | pending |
| RERANK-01 | Phase 58 — Nightly LLM rerank batch + per-skill JD-rel weight | pending |
| RERANK-02 | Phase 58 — Nightly LLM rerank batch + per-skill JD-rel weight | pending |
| RERANK-03 | Phase 58 — Nightly LLM rerank batch + per-skill JD-rel weight | pending |
| RERANK-04 | Phase 58 — Nightly LLM rerank batch + per-skill JD-rel weight | pending |
| DASH-01 | Phase 59 — Dashboards (canonical-tags + qa-evaluator + onboarding-questions ext) | pending |
| DASH-02 | Phase 59 — Dashboards (canonical-tags + qa-evaluator + onboarding-questions ext) | pending |
| DASH-03 | Phase 59 — Dashboards (canonical-tags + qa-evaluator + onboarding-questions ext) | pending |
| DASH-04 | Phase 59 — Dashboards (canonical-tags + qa-evaluator + onboarding-questions ext) | pending |
| DEV-01 | Phase 60 — Dev triggers + scenarios + fixtures | pending |
| DEV-02 | Phase 60 — Dev triggers + scenarios + fixtures | pending |
| DEV-03 | Phase 60 — Dev triggers + scenarios + fixtures | pending |
| DEV-04 | Phase 60 — Dev triggers + scenarios + fixtures | pending |
| QA-01 | Phase 61 — QA evaluator thread weekly run | pending |
| QA-02 | Phase 61 — QA evaluator thread weekly run | pending |
| QA-03 | Phase 61 — QA evaluator thread weekly run | pending |
| QA-04 | Phase 61 — QA evaluator thread weekly run | pending |
| QA-05 | Phase 61 — QA evaluator thread weekly run | pending |
| DOC-01 | Phase 62 — Documentation | pending |
| DOC-02 | Phase 62 — Documentation | pending |
| DOC-03 | Phase 62 — Documentation | pending |
| DOC-04 | Phase 62 — Documentation | pending |

**Total: 59 REQ-IDs across 10 categories (note: previous summary stated 55; actual count audited 2026-05-05 is 59 — 12 TAG + 9 PARSE + 5 USER-TAG + 8 MATCH + 4 LIVE + 4 RERANK + 4 DASH + 4 DEV + 5 QA + 4 DOC). All 59 mapped to phases 52–62.**

---

## v1.4 Active Requirements — Humanize-Runtime v2 (Bilingual, Eval-First)

**Goal:** Push Claire's bilingual (zh+en) conversational humanness to ~70-80% Pi-level on 5 quantified metrics. Eval-first ordering: no module work until baseline locked. 0 net new LLM calls in production path.

**See:** `MILESTONE-v1.4-humanize-runtime-v2.md` for full Decision Log + reuse manifest.

### HARNESS — Eval Harness Extension (Phase 33, must run first per D16)

- [ ] **HARNESS-01**: Extend `tests/scenarios/lib/voice-axes.mjs` with 4 new axes — `drift_resistance`, `length_compliance`, `advice_novelty`, `strategy_fit`. Each axis returns numeric 0-3 score with rubric.
- [ ] **HARNESS-02**: Multi-turn drift detector script (`tests/scenarios/lib/drift-score.mjs`) — computes 5 success metrics from a conversation transcript.
- [ ] **HARNESS-03**: Bilingual sentence splitter (`tests/scenarios/lib/sentence-split.mjs`) — counts zh sentences (`。！？；…`) and en sentences (`. ! ?`) for length cap detection. Unit-tested on 30+ edge cases.
- [ ] **HARNESS-04**: BGE-M3 sentence-embedding wrapper (`tests/scenarios/lib/embed-sim.mjs`) — uses existing Mem0 SiliconFlow wiring; cosine similarity helper for advice-repeat detection.
- [ ] **HARNESS-05**: 5+ new scenario YAMLs added to `tests/scenarios/scenarios/`: 50-turn drift (zh + en), mixed code-switch, crisis routing red-team (20 prompts), tone shift labeled set.

### BASELINE — Baseline Measurement (Phase 34, gates all subsequent work)

- [ ] **BASELINE-01**: Run `tests/scenarios/pairwise-runner.mjs` against all `eval-voice-*.yaml` on rev-00056; capture per-scenario filler-blacklist hits + voice axes scores.
- [ ] **BASELINE-02**: Run `/tmp/sim-audit-rev56.mjs` (3 personas × 12 turns each); extract 5 success metrics from output.
- [ ] **BASELINE-03**: Write `.planning/baseline-rev00056.md` with locked numbers for all 5 metrics + per-detector false-positive baselines.
- [ ] **BASELINE-04**: Define quantitative gates per Phase 35-40 ("merge if metric X improves by Y%"); committed to milestone doc.

### DETECT — 4 Deterministic Detectors (Phase 35, bilingual)

- [ ] **DETECT-01**: F1 verb-mirror — n-gram overlap detector. zh: char 3-gram. en: word bigram. Compares Claire's reply to previous user turn; threshold default 0.6 (tunable).
- [ ] **DETECT-02**: F2 length cap — counts sentences using `sentence-split.mjs`. Hard cap = 3 sentences. Triggers strip (drop sentences > 3) not regenerate.
- [ ] **DETECT-03**: F3 lang-lock reinforcement — extends existing `LangState` in `pa-orchestrator/src/voice/lang-detect.ts`; reject + resample on >25% off-language tokens.
- [ ] **DETECT-04**: F4 advice-repeat — BGE-M3 cos-sim of new reply vs last 3 Claire turns. Threshold 0.85; trigger novelty directive.
- [ ] **DETECT-05**: All 4 detectors wired into voice rewriter pipeline as Phase 4; failures trigger strip (F2) or single regenerate (F1, F4) or reject-resample (F3).
- [ ] **DETECT-06**: Unit tests cover bilingual edge cases (zh char-3gram, en bigram, mixed sentences, empty input, code switching).
- [ ] **DETECT-07**: Detector recall ≥ 80% on rev-00056 known fails; false positive rate ≤ 10% (measured against Phase 34 baseline).

### IMPERFECT — ImperfectionInjector + 3-arm A/B (Phase 36)

- [ ] **IMPERFECT-01**: 3-arm A/B router (config `PA_IMPERFECTION_ARM=control|low|high`); arms = 0% / 15% / 30% firing rate.
- [ ] **IMPERFECT-02**: Position constraint enforced — turn-onset only, never mid-clause (Pinguet 2023 evidence). Unit-tested.
- [ ] **IMPERFECT-03**: zh policies (`packages/pa-orchestrator/src/voice/imperfection/policies-zh.ts`) — fillers (`嗯` / `那个` / `我想想`), self-correct (`啊不对，是X`), uncertainty (`说不清是不是`).
- [ ] **IMPERFECT-04**: en policies (`packages/pa-orchestrator/src/voice/imperfection/policies-en.ts`) — fillers (`uh` / `I mean` / `like`), self-correct (`wait no, *X`), uncertainty (`not sure if`).
- [ ] **IMPERFECT-05**: Type priority enforced: self-correct > hesitate > clarify > uncertainty (per Schroeder 2024 evidence: corrected typos most humanizing).
- [ ] **IMPERFECT-06**: A/B harness via `tests/scenarios/pairwise-runner.mjs` — 3 arms × 2 swaps per scenario = 6 judge calls per scenario; 6 scenarios = 36 calls (~$0.08).
- [ ] **IMPERFECT-07**: Winner arm determined via pre-registered statistical significance criteria (≥10pp improvement on humanness axes vs control). Losers' code paths kept but disabled.

### FSM — State Machine (Phase 37)

- [ ] **FSM-01**: 5 UX state enum in `packages/pa-orchestrator/src/voice/fsm/ux-state.ts` — `WarmCurious` / `PlayfulTease` / `SoftConcerned` / `FirmDirect` / `QuietWitness`.
- [ ] **FSM-02**: ESConv 8 strategy enum (zh + en bilingual labels) in `fsm/strategies.ts` — `Question` / `Restatement` / `Reflection` / `SelfDisclosure` / `Affirmation` / `Suggestion` / `Information` / `Other`.
- [ ] **FSM-03**: State × strategy allowed-set table in `fsm/transitions.ts` (per ESConv 3 stages: Exploration / Comforting / Action). Each UX state allows subset of 8 strategies.
- [ ] **FSM-04**: `fsm/state-classifier.ts` — sentiment + keyword + history → `ux_state` classification (no LLM; rule-based). Unit-tested on labeled bilingual fixtures.
- [ ] **FSM-05**: TransESC-style transition table — given previous strategy, weight allowed next-strategy probabilities for continuity.
- [ ] **FSM-06**: Voice rewriter Phase 3 prompt extended with `ux_state` directive + `allowed_strategies` whitelist; LLM constrained to choose strategy ∈ allowed set.
- [ ] **FSM-07**: `strategy_fit` axis in eval verifies Claire's chosen strategy ∈ allowed set 100%; ux_state classifier accuracy ≥ 70% on labeled set.

### MEMORY — Memory Policy (Phase 38)

- [ ] **MEMORY-01**: `memory-policy/advice-tracker.ts` — records each "advice given" with BGE-M3 embedding, stores in Firestore `pa_voice_advice_history/{userId}/{turnId}`.
- [ ] **MEMORY-02**: `memory-policy/contradiction.ts` — Mem0 fact diff detector; flags when new fact contradicts stored persona facts.
- [ ] **MEMORY-03**: Voice rewriter Phase 3 prompt extended with "已经给过的建议: [list]" / "Already-given advice: [list]" injection from advice-tracker.
- [ ] **MEMORY-04**: Pin Mem0 fact-extractor model to Qwen-7B+ tier (env `MEM0_EXTRACTOR_MODEL=Qwen/Qwen2.5-7B-Instruct` minimum); reject 1.5B configurations.
- [ ] **MEMORY-05**: Bilingual retrieval test — 50 queries (zh + en + mixed) verify Mem0 returns correct facts; precision ≥ 70%, recall ≥ 60%.
- [ ] **MEMORY-06**: 50-turn synthetic conversation test — advice repeat rate (cos-sim > 0.85) drops from baseline to < 5%.

### BENCH — External Auto Benchmarks (Phase 39, all 5)

- [ ] **BENCH-01**: BotChat (open-compass) integration — bilingual auto Turing-style; double-LLM chat then judge "is this human-like". Run Qwen-7B raw + Qwen-7B + Claire stack.
- [ ] **BENCH-02**: CharacterEval (morecry) integration — Chinese 77-character role-play, 12 metrics. Submit Qwen-7B + Claire stack; compare to public leaderboard (GPT-4 / Qwen-72B / Baichuan-13B / ChatGLM3 / MiniMax abab).
- [ ] **BENCH-03**: EmpatheticDialogues (facebookresearch) — English 25k empathy convs. Run Claire stack on subset 1000; compare to BlenderBot / Qwen baselines.
- [ ] **BENCH-04**: ESConv (thu-coai) — English emotional support 8 strategies. Auto-eval on subset 200 convs.
- [ ] **BENCH-05**: RoleLLM (InteractiveNLP-Team) — English 100-character role-play. Subset 50 characters.
- [ ] **BENCH-06**: Aggregate report `.planning/benchmark-v1.4.md` comparing Claire stack vs Qwen-7B raw vs published baselines per benchmark; computed delta + statistical significance.
- [ ] **BENCH-07**: Total spend ≤ $25 across all 5 benchmarks; cost ledger logged per benchmark. Claire stack ≥ Qwen-72B raw on ≥ 1 of 5 = success criterion.

### BIBLE — Bible v7.5 + Crisis Red-team + Ship (Phase 40)

- [ ] **BIBLE-01**: Bible v7.5 published as `packages/pa-orchestrator/src/voice/bible-v7.5.md`; supersedes v7.4. Adds: bilingual NEVER rules + zh+en slang bank (curated via Phase 18 lexicon + new additions).
- [ ] **BIBLE-02**: Crisis safety prompt section — bilingual keyword triggers (`自杀` / `不想活` / `想死` / `suicide` / `kill myself` etc.) + safe response template (refer 心理援助热线 400-161-9995 + Crisis Text Line 741741) + explicit "do not validate dark feelings" directive.
- [ ] **BIBLE-03**: 3-sentence cap directive at top of Bible v7.5 (reinforces F2 detector).
- [ ] **SHIP-01**: Feature flag `PA_HUMANIZE_RUNTIME_ENABLED` — defaults off; gradual rollout via `firebase functions:config:set`.
- [ ] **SHIP-02**: 20 crisis red-team prompts (zh + en, varied severity) → safety branch route 100% of time. Auto-test in CI.
- [ ] **SHIP-03**: SiliconFlow prefix cache POC (D7) — Bible v7.5 + few-shot bank prefix cached per session. Measure: ≥ 20% latency reduction at zero quality cost.
- [ ] **SHIP-04**: Final audit — all 5 success metrics meet target vs Phase 34 baseline; benchmark report meets ≥ 1 of 5 criterion.
- [ ] **SHIP-05**: Production rollout to closed beta with kill switch + dashboard panel showing 5 metrics + benchmark scores.

---

## v1.4 P1 (post-milestone)

- HUMANIZE-RFT: collect ≥10k human-validated bilingual turns; evaluate fine-tuning ROI (rejected for v1.4 by D1)
- HUMANIZE-VOICE-DRIFT: identity drift telemetry extension
- TURING-HUMAN: Jones & Bergen 5-min replication with WeKruit beta users (50 raters, $300, 7d)
- TEXTUREPOOL: recruit 10 users × 2h interview, build 250 fact pool (genagents reflection pattern)

## v1.4 Out of scope (explicit exclusions)

- Sonnet / Opus model escalation (Adam-locked)
- Fine-tuning / RFT / character LoRA (no anchor data)
- LangGraph, DSPy import (Adam-locked)
- Reflexion-lite critic loop (D1 — 5 papers show LLM judge bias amplifies F2/F4)
- New monorepo package (D8)
- Plutchik 8-dim engineering layer (D11 — 大连理工 7-class replaces; FSM does the actual work)
- Big5-Chat trait scoring (D11 — Claire persona sufficient)
- LoCoMo memory benchmark (repo offline)
- OpenAI text-embedding swap (D14 — BGE-M3 multilingual sufficient and free)
- Crisis routing classifier (D4 — Bible prompt section is sufficient and matches FTC/Senate regulatory minimum)
- TexturePool 250 facts (defer to v1.5)
- 5-min Turing test human raters (defer to v1.5; demographic mismatch)

---

## Traceability — v1.4

| REQ-ID | Phase |
|---|---|
| HARNESS-01 .. HARNESS-05 | Phase 33 |
| BASELINE-01 .. BASELINE-04 | Phase 34 |
| DETECT-01 .. DETECT-07 | Phase 35 |
| IMPERFECT-01 .. IMPERFECT-07 | Phase 36 |
| FSM-01 .. FSM-07 | Phase 37 |
| MEMORY-01 .. MEMORY-06 | Phase 38 |
| BENCH-01 .. BENCH-07 | Phase 39 |
| BIBLE-01 .. BIBLE-03, SHIP-01 .. SHIP-05 | Phase 40 |

100% coverage: every v1.4 REQ-ID maps to exactly one phase.

---

## v1.1 Active Requirements (PRESERVED — Pre-Launch Hardening + Companion Brain)

**Goal:** Closed-beta launchable (≤20 hand-picked users) within 3 weeks. Fix companion voice on gpt-5.4-nano (no Sonnet escalation), migrate iMessage channel to Sendblue, close output normalization + safety gaps, revive proactive check-in.

**Last updated:** 2026-04-27

### VOICE — Companion Voice v1 (static base)

- [x] **VOICE-01**: System prompt rewritten using Snapchat MyAI skeleton (concise, friend register, no monologue, sparse emoji, never self-identifies as AI).
- [x] **VOICE-02**: PA persona is encoded as PA self-backstory (not a user-attribute table) per Tendera "facts as voice" pattern; per-user facts stay in mem0 layer, never injected as bullet specs.
- [x] **VOICE-03**: System prompt ships with 3 in-character `mes_example` few-shot dialogue turns demonstrating implicit ack ("柠檬茶女孩 🍋" pattern) instead of explicit catalog ("好的，我记住了").
- [x] **VOICE-04**: System prompt includes `first_mes` voice anchor (research-validated highest-ROI lever for small-model voice).
- [x] **VOICE-05**: Post-history voice reminder (50-100 tokens) injected before user's latest turn so voice constraints survive long context.
- [x] **VOICE-06**: Character Bible v1 written (Adam owner) — PA name, backstory, 3 verbal tics, reaction templates, signature emoji, code-switch policy, length cap.
- [ ] **VOICE-07**: zh + en slang lexicon curated (≤10 zh + ≤7 en signature terms with usage notes); used at most 1-2 per turn, not stacked.
- [ ] **VOICE-08**: Eval rubric extended with 4 voice axes — `warmth_no_sycophancy`, `in_character_voice`, `no_robot_filler`, `length_appropriateness` — pairwise judge against current-prompt baseline.
- [ ] **VOICE-09**: Eval LLM-judge auto-fail patterns include zh + en filler blacklist (`好的，我记住了 / 收到 / 没问题，我会记得 / "It's important to" / "Remember,"`); blacklist is NOT in system prompt (token activation risk).
- [ ] **VOICE-10**: 5+ companion-voice golden scenarios added to harness as anchor benchmark.

### ADAPT — Adaptive Mirror Layer

- [x] **ADAPT-01**: Per-turn user-style analyzer extracts register / language ratio / emoji frequency / length from user's last 3-5 turns.
- [x] **ADAPT-02**: Dynamic mirror snippet injected post-history per turn.
- [x] **ADAPT-03**: Long-term style preferences accumulated in mem0 and re-injected via persona card extension.
- [x] **ADAPT-04**: Mirror layer kill switch (`PA_VOICE_MIRROR_DISABLED=true`) for rollback.
- [x] **ADAPT-05**: Eval scenario for mirror — turn 1 user formal → PA formal; turn 2 user slangy → PA slangy.

### NORM — Output Normalization

- [ ] **NORM-01**: New module `packages/pa-orchestrator/src/output-normalizer.ts` runs at orchestrator exit (channel-agnostic).
- [ ] **NORM-02**: Strips markdown emphasis: `**X** / *X* / __X__ / _X_ / `X` / ```X``` → `X`.
- [ ] **NORM-03**: Converts markdown links `[text](url)` → `text url`; strips `?utm_*=...&...` tracking params.
- [ ] **NORM-04**: List markers `- ` and `* ` → `· ` (CJK-friendly bullet).
- [ ] **NORM-05**: Whitespace collapse: ≥3 blank lines → 2; trailing whitespace trimmed.
- [ ] **NORM-06**: Length cap (>600 chars) triggers chunk-split or graceful truncate.
- [ ] **NORM-07**: Eval rubric gains 5th axis `iMessage_render_safe` — auto-fail on regex match.
- [ ] **NORM-08**: Unit tests cover 8+ edge cases.

### CHANNEL — Sendblue Channel Migration

- [x] **CHANNEL-01..09**: All shipped 2026-04-27 (see prior REQUIREMENTS history; Sendblue cutover complete).

### PROACTIVE — Proactive Check-in

- [x] **PROACTIVE-01..07**: All shipped 2026-04-28.

### BETA — Closed Beta Onboarding + Safety

- [ ] **BETA-01**: Onboarding flow for first-contact user.
- [ ] **BETA-02**: `pa_abuse_events` producer wired at 3 points.
- [ ] **BETA-03**: Dashboard abuse panel.
- [ ] **BETA-04**: Allowlist UI in dashboard.
- [ ] **BETA-05**: Beta user runbook.

---

## P1 — Should have (post-beta, before public launch)

- VOICE-RFT: collect ≥10k human-validated turns, evaluate fine-tuning ROI
- ADAPT-DRIFT: identity drift telemetry from `pa_audit_events`
- CHANNEL-WHATSAPP: WhatsApp Business adapter
- WEB-FALLBACK: Firebase Auth web chat
- SECRETS-MIGRATE: move `.env` to GCP Secret Manager
- GDPR-DELETE: user-level export + delete API

---

## v1.1 Traceability

| REQ-ID | Phase |
|---|---|
| VOICE-01 .. VOICE-10 | Phase 18 |
| ADAPT-01 .. ADAPT-05 | Phase 19 |
| NORM-01 .. NORM-08 | Phase 20 |
| CHANNEL-01 .. CHANNEL-09 | Phase 21 |
| PROACTIVE-01 .. PROACTIVE-07 | Phase 22 |
| BETA-01 .. BETA-05 | Phase 23 |
