---
phase: 19-adaptive-mirror
type: context
status: locked
locked_at: 2026-04-27
owner: Adam
depends_on_phase: 18-companion-voice-v1
requirements: [ADAPT-01, ADAPT-02, ADAPT-03, ADAPT-04, ADAPT-05]
---

# Phase 19 — Adaptive Mirror Layer (CONTEXT)

## Goal

PA dynamically mirrors the user's register / language ratio / emoji frequency / sentence length on a per-turn basis, layered on top of Phase 18's static Character Bible voice. Per Meta AI WhatsApp leaked prompt:

> "Mirror user intentionality and style in an EXTREME way."

Phase 18 = "Claire is Claire." Phase 19 = "Claire matches your vibe today."

## Why now (vs. P1 / post-beta)

ROADMAP marks Phase 19 + 22 as P1 — not strict closed-beta launch gates. This phase is being **planned now** so that:
1. Plan exists and is reviewed while voice context is fresh (research artifacts loaded).
2. Execution is unblocked the moment Phase 18 ships.
3. Adam can pull it forward into closed-beta if Phase 18 voice feels too monotonic with 20 real users.

**Execution order is still 18 → 19** (hard dep on Phase 18 post-history voice reminder injection point).

## Decisions (locked — non-negotiable)

| ID | Decision | Source |
|---|---|---|
| **D-01** | Mirror module path: `packages/pa-orchestrator/src/voice/style-analyzer.ts` (new `voice/` subdir under orchestrator). | Adam directive |
| **D-02** | Stay on **gpt-5.4-nano**. Analyzer is deterministic JS heuristics, NOT a model call. No second LLM round-trip per turn. | Adam-locked, PROJECT.md |
| **D-03** | **Positive framing only** in mirror snippet. No negative-instruction blacklists ("don't be formal", "avoid emoji"). Token-activation risk on small models. | Adam-locked, PROJECT.md, VOICE-09 precedent |
| **D-04** | Mirror snippet is injected **post-history, after Phase 18 post-history voice reminder, before model call**. Order: `[system prompt] → [history] → [Phase 18 voice reminder] → [Phase 19 mirror snippet] → [user turn]`. | ADAPT-02 + Phase 18 VOICE-05 ordering |
| **D-05** | Style features sampled from **last 3-5 user turns only** (not assistant turns; not full transcript). Window = min(5, available user turns). | ADAPT-01 |
| **D-06** | Long-term style preferences live in **mem0**, surfaced via **persona card extension** (Phase 11.1 `packages/memory/src/persona-card.ts`). Not a new collection. | ADAPT-03 |
| **D-07** | Kill switch env var: `PA_VOICE_MIRROR_DISABLED=true` → orchestrator skips analyzer + skips mirror snippet → falls back cleanly to Phase 18 static voice. Must be one-line env flip, no code rollback. | ADAPT-04 |
| **D-08** | **No model-based slang classifier.** Slang/formal detection = lexicon match against curated zh + en list (Phase 18 VOICE-07 lexicon, already shipped). Reuse, don't re-author. | Cost + Adam constraint |
| **D-09** | E2E eval scenario uses **same user_id across 3 turns** (turn 1 formal → turn 3 slangy) and asserts mem0 records the preference shift after the session. | ADAPT-05 |
| **D-10** | Style features computed are: `register_score` (0=slangy, 1=formal), `zh_char_ratio` (0-1), `emoji_freq` (emoji/100chars), `avg_sentence_len` (chars), `slang_hits` (count from Phase 18 lexicon). 5 features. No more. | Scope cap |

## Deferred Ideas (NOT in this plan)

| Idea | Reason |
|---|---|
| LLM-based style classifier (second model call per turn) | Cost + latency; D-02 locked nano-only with deterministic analyzer |
| Mirror assistant turns too (not just user turns) | Echo loop risk; D-05 user-only |
| Per-channel mirror profiles (iMessage vs Sendblue vs web) | Sendblue migration is Phase 21; cross-channel persistence is post-launch |
| Voice drift telemetry (`pa_audit_events` extension) | Marked as P1 ADAPT-DRIFT in REQUIREMENTS.md |
| Retrieval-based voice (Chat-Haruhi pattern) | Marked as future architecture in 17-RESEARCH; not this phase |
| User-facing "tone" toggle in dashboard | No UI scope this phase |
| Mirror sentence-rhythm / punctuation style | Out of 5-feature cap (D-10) |

## Claude's Discretion

- Exact regex/Unicode ranges for emoji detection (suggest `\p{Extended_Pictographic}`).
- Exact zh char detection (suggest `[一-鿿]` + extension blocks).
- Exact register_score formula — choose a defensible weighting of (sentence_len, slang_hits, emoji_freq, punctuation_density). Document it in code comment + plan task action.
- Mirror snippet exact wording — must be positive-framing per D-03 and reference current observed style. Sample template provided in PLAN; refine in implementation.
- Mem0 schema field names for preference storage (suggest `voice_style_preference` namespace under existing user partition).
- Whether to debounce mem0 writes (suggest: write only if drift > threshold to avoid churn).

## Hard dependency on Phase 18

This phase **cannot execute** until Phase 18 ships:
- Needs Phase 18 **post-history voice reminder injection point** to inject mirror snippet immediately after.
- Needs Phase 18 **slang lexicon** (VOICE-07) for slang_hits feature.
- Needs Phase 18 **eval rubric (4 voice axes)** to add mirror-specific scenarios alongside.
- Needs Phase 18 **first_mes / mes_example** anchors so mirror doesn't fight the static base.

Plan can be **written and reviewed now**; execution gated on Phase 18 SUMMARY.

## Cross-refs

- Static base: `.planning/phases/18-companion-voice-v1/CHARACTER-BIBLE-v1.md`
- Mirror pattern source: `.planning/phases/17-pre-launch-hardening/17-RESEARCH-raw-artifacts.md` § "Meta AI WhatsApp"
- Persona card: `packages/memory/src/persona-card.ts`
- mem0 helpers: `packages/memory/src/`
- Orchestrator entry: `packages/pa-orchestrator/src/index.ts`
- Eval harness: `tests/scenarios/runner.mjs`
- Memory: `~/.claude/projects/-Users-adam-Desktop-WeKruit-wekruit-pa/memory/companion_voice_constraints.md`
