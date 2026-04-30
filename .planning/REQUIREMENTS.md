# Requirements

This file is append-only across milestones. Active milestone requirements at top; prior milestone requirements preserved below for traceability.

**Last updated:** 2026-04-29 (v1.4 spawned)

---

## v1.4 Active Requirements — Humanize-Runtime v2 (Bilingual, Eval-First)

**Goal:** Push Claire's bilingual (zh+en) conversational humanness to ~70-80% Pi-level on 5 quantified metrics. Eval-first ordering: no module work until baseline locked. 0 net new LLM calls in production path.

**See:** `MILESTONE-v1.4-humanize-runtime-v2.md` for full Decision Log + reuse manifest.

### HARNESS — Eval Harness Extension (Phase 29, must run first per D16)

- [ ] **HARNESS-01**: Extend `tests/scenarios/lib/voice-axes.mjs` with 4 new axes — `drift_resistance`, `length_compliance`, `advice_novelty`, `strategy_fit`. Each axis returns numeric 0-3 score with rubric.
- [ ] **HARNESS-02**: Multi-turn drift detector script (`tests/scenarios/lib/drift-score.mjs`) — computes 5 success metrics from a conversation transcript.
- [ ] **HARNESS-03**: Bilingual sentence splitter (`tests/scenarios/lib/sentence-split.mjs`) — counts zh sentences (`。！？；…`) and en sentences (`. ! ?`) for length cap detection. Unit-tested on 30+ edge cases.
- [ ] **HARNESS-04**: BGE-M3 sentence-embedding wrapper (`tests/scenarios/lib/embed-sim.mjs`) — uses existing Mem0 SiliconFlow wiring; cosine similarity helper for advice-repeat detection.
- [ ] **HARNESS-05**: 5+ new scenario YAMLs added to `tests/scenarios/scenarios/`: 50-turn drift (zh + en), mixed code-switch, crisis routing red-team (20 prompts), tone shift labeled set.

### BASELINE — Baseline Measurement (Phase 30, gates all subsequent work)

- [ ] **BASELINE-01**: Run `tests/scenarios/pairwise-runner.mjs` against all `eval-voice-*.yaml` on rev-00056; capture per-scenario filler-blacklist hits + voice axes scores.
- [ ] **BASELINE-02**: Run `/tmp/sim-audit-rev56.mjs` (3 personas × 12 turns each); extract 5 success metrics from output.
- [ ] **BASELINE-03**: Write `.planning/baseline-rev00056.md` with locked numbers for all 5 metrics + per-detector false-positive baselines.
- [ ] **BASELINE-04**: Define quantitative gates per Phase 31-36 ("merge if metric X improves by Y%"); committed to milestone doc.

### DETECT — 4 Deterministic Detectors (Phase 31, bilingual)

- [ ] **DETECT-01**: F1 verb-mirror — n-gram overlap detector. zh: char 3-gram. en: word bigram. Compares Claire's reply to previous user turn; threshold default 0.6 (tunable).
- [ ] **DETECT-02**: F2 length cap — counts sentences using `sentence-split.mjs`. Hard cap = 3 sentences. Triggers strip (drop sentences > 3) not regenerate.
- [ ] **DETECT-03**: F3 lang-lock reinforcement — extends existing `LangState` in `pa-orchestrator/src/voice/lang-detect.ts`; reject + resample on >25% off-language tokens.
- [ ] **DETECT-04**: F4 advice-repeat — BGE-M3 cos-sim of new reply vs last 3 Claire turns. Threshold 0.85; trigger novelty directive.
- [ ] **DETECT-05**: All 4 detectors wired into voice rewriter pipeline as Phase 4; failures trigger strip (F2) or single regenerate (F1, F4) or reject-resample (F3).
- [ ] **DETECT-06**: Unit tests cover bilingual edge cases (zh char-3gram, en bigram, mixed sentences, empty input, code switching).
- [ ] **DETECT-07**: Detector recall ≥ 80% on rev-00056 known fails; false positive rate ≤ 10% (measured against Phase 30 baseline).

### IMPERFECT — ImperfectionInjector + 3-arm A/B (Phase 32)

- [ ] **IMPERFECT-01**: 3-arm A/B router (config `PA_IMPERFECTION_ARM=control|low|high`); arms = 0% / 15% / 30% firing rate.
- [ ] **IMPERFECT-02**: Position constraint enforced — turn-onset only, never mid-clause (Pinguet 2023 evidence). Unit-tested.
- [ ] **IMPERFECT-03**: zh policies (`packages/pa-orchestrator/src/voice/imperfection/policies-zh.ts`) — fillers (`嗯` / `那个` / `我想想`), self-correct (`啊不对，是X`), uncertainty (`说不清是不是`).
- [ ] **IMPERFECT-04**: en policies (`packages/pa-orchestrator/src/voice/imperfection/policies-en.ts`) — fillers (`uh` / `I mean` / `like`), self-correct (`wait no, *X`), uncertainty (`not sure if`).
- [ ] **IMPERFECT-05**: Type priority enforced: self-correct > hesitate > clarify > uncertainty (per Schroeder 2024 evidence: corrected typos most humanizing).
- [ ] **IMPERFECT-06**: A/B harness via `tests/scenarios/pairwise-runner.mjs` — 3 arms × 2 swaps per scenario = 6 judge calls per scenario; 6 scenarios = 36 calls (~$0.08).
- [ ] **IMPERFECT-07**: Winner arm determined via pre-registered statistical significance criteria (≥10pp improvement on humanness axes vs control). Losers' code paths kept but disabled.

### FSM — State Machine (Phase 33)

- [ ] **FSM-01**: 5 UX state enum in `packages/pa-orchestrator/src/voice/fsm/ux-state.ts` — `WarmCurious` / `PlayfulTease` / `SoftConcerned` / `FirmDirect` / `QuietWitness`.
- [ ] **FSM-02**: ESConv 8 strategy enum (zh + en bilingual labels) in `fsm/strategies.ts` — `Question` / `Restatement` / `Reflection` / `SelfDisclosure` / `Affirmation` / `Suggestion` / `Information` / `Other`.
- [ ] **FSM-03**: State × strategy allowed-set table in `fsm/transitions.ts` (per ESConv 3 stages: Exploration / Comforting / Action). Each UX state allows subset of 8 strategies.
- [ ] **FSM-04**: `fsm/state-classifier.ts` — sentiment + keyword + history → `ux_state` classification (no LLM; rule-based). Unit-tested on labeled bilingual fixtures.
- [ ] **FSM-05**: TransESC-style transition table — given previous strategy, weight allowed next-strategy probabilities for continuity.
- [ ] **FSM-06**: Voice rewriter Phase 3 prompt extended with `ux_state` directive + `allowed_strategies` whitelist; LLM constrained to choose strategy ∈ allowed set.
- [ ] **FSM-07**: `strategy_fit` axis in eval verifies Claire's chosen strategy ∈ allowed set 100%; ux_state classifier accuracy ≥ 70% on labeled set.

### MEMORY — Memory Policy (Phase 34)

- [ ] **MEMORY-01**: `memory-policy/advice-tracker.ts` — records each "advice given" with BGE-M3 embedding, stores in Firestore `pa_voice_advice_history/{userId}/{turnId}`.
- [ ] **MEMORY-02**: `memory-policy/contradiction.ts` — Mem0 fact diff detector; flags when new fact contradicts stored persona facts.
- [ ] **MEMORY-03**: Voice rewriter Phase 3 prompt extended with "已经给过的建议: [list]" / "Already-given advice: [list]" injection from advice-tracker.
- [ ] **MEMORY-04**: Pin Mem0 fact-extractor model to Qwen-7B+ tier (env `MEM0_EXTRACTOR_MODEL=Qwen/Qwen2.5-7B-Instruct` minimum); reject 1.5B configurations.
- [ ] **MEMORY-05**: Bilingual retrieval test — 50 queries (zh + en + mixed) verify Mem0 returns correct facts; precision ≥ 70%, recall ≥ 60%.
- [ ] **MEMORY-06**: 50-turn synthetic conversation test — advice repeat rate (cos-sim > 0.85) drops from baseline to < 5%.

### BENCH — External Auto Benchmarks (Phase 35, all 5)

- [ ] **BENCH-01**: BotChat (open-compass) integration — bilingual auto Turing-style; double-LLM chat then judge "is this human-like". Run Qwen-7B raw + Qwen-7B + Claire stack.
- [ ] **BENCH-02**: CharacterEval (morecry) integration — Chinese 77-character role-play, 12 metrics. Submit Qwen-7B + Claire stack; compare to public leaderboard (GPT-4 / Qwen-72B / Baichuan-13B / ChatGLM3 / MiniMax abab).
- [ ] **BENCH-03**: EmpatheticDialogues (facebookresearch) — English 25k empathy convs. Run Claire stack on subset 1000; compare to BlenderBot / Qwen baselines.
- [ ] **BENCH-04**: ESConv (thu-coai) — English emotional support 8 strategies. Auto-eval on subset 200 convs.
- [ ] **BENCH-05**: RoleLLM (InteractiveNLP-Team) — English 100-character role-play. Subset 50 characters.
- [ ] **BENCH-06**: Aggregate report `.planning/benchmark-v1.4.md` comparing Claire stack vs Qwen-7B raw vs published baselines per benchmark; computed delta + statistical significance.
- [ ] **BENCH-07**: Total spend ≤ $25 across all 5 benchmarks; cost ledger logged per benchmark. Claire stack ≥ Qwen-72B raw on ≥ 1 of 5 = success criterion.

### BIBLE — Bible v7.5 + Crisis Red-team + Ship (Phase 36)

- [ ] **BIBLE-01**: Bible v7.5 published as `packages/pa-orchestrator/src/voice/bible-v7.5.md`; supersedes v7.4. Adds: bilingual NEVER rules + zh+en slang bank (curated via Phase 18 lexicon + new additions).
- [ ] **BIBLE-02**: Crisis safety prompt section — bilingual keyword triggers (`自杀` / `不想活` / `想死` / `suicide` / `kill myself` etc.) + safe response template (refer 心理援助热线 400-161-9995 + Crisis Text Line 741741) + explicit "do not validate dark feelings" directive.
- [ ] **BIBLE-03**: 3-sentence cap directive at top of Bible v7.5 (reinforces F2 detector).
- [ ] **SHIP-01**: Feature flag `PA_HUMANIZE_RUNTIME_ENABLED` — defaults off; gradual rollout via `firebase functions:config:set`.
- [ ] **SHIP-02**: 20 crisis red-team prompts (zh + en, varied severity) → safety branch route 100% of time. Auto-test in CI.
- [ ] **SHIP-03**: SiliconFlow prefix cache POC (D7) — Bible v7.5 + few-shot bank prefix cached per session. Measure: ≥ 20% latency reduction at zero quality cost.
- [ ] **SHIP-04**: Final audit — all 5 success metrics meet target vs Phase 30 baseline; benchmark report meets ≥ 1 of 5 criterion.
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
| HARNESS-01 .. HARNESS-05 | Phase 29 |
| BASELINE-01 .. BASELINE-04 | Phase 30 |
| DETECT-01 .. DETECT-07 | Phase 31 |
| IMPERFECT-01 .. IMPERFECT-07 | Phase 32 |
| FSM-01 .. FSM-07 | Phase 33 |
| MEMORY-01 .. MEMORY-06 | Phase 34 |
| BENCH-01 .. BENCH-07 | Phase 35 |
| BIBLE-01 .. BIBLE-03, SHIP-01 .. SHIP-05 | Phase 36 |

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
