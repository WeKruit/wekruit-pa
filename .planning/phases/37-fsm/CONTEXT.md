# Phase 37 — FSM (5 UX × ESConv 8 strategies × 3 stages) — CONTEXT

> [🟠 阿里味] **底层逻辑**：Phase 33 给了 ESConv 8-strategy classifier (`inferStrategy`) + stage mapper (`stageForTurn`) + allowed-set table (`ESCONV_STAGE_ALLOWED`). Phase 35 给了 detector 后处理通道。Phase 36 给了 ImperfectionInjector 后处理通道。Phase 37 是 **pre-generation control surface**——在 LLM 跑之前给 prompt 塞 `ux_state` + `allowed_strategies` 白名单。生成完之后用 Phase 33 `inferStrategy` 反查 `strategy_fit` ∈ allowed-set 100%。**5-state UX classifier 走 rule-based**（D6 FiSMiness baseline；0 net new LLM call）。**抓手清晰**：ux_state ≥ 70% accuracy / strategy_fit 100% on synthetic-aligned。证据说话。

**Owner:** P9-C (v1.4 humanize-runtime stream)
**Estimate:** ~1 dev-day
**Upstream gate:** Phase 33 helpers locked (`tests/scenarios/lib/voice-axes.mjs` exports `inferStrategy` + `stageForTurn` + `ESCONV_STRATEGIES` + `ESCONV_STAGE_ALLOWED` + `isAllowedStrategy`)
**Downstream:** Phase 38 Memory Policy (advice-tracker may key on FSM state for repeat tolerance), Phase 40 Bible v7.5 (FSM directive injected as Phase 3 prompt section)

---

## 1. Phase boundary

### In scope (FSM-01..07 + D10 TransESC pattern)

Standalone FSM module under `packages/pa-orchestrator/src/voice/fsm/` — TypeScript, **0 net new LLM calls** (rule-based classifier per D6), < 10ms per turn (latency budget), bilingual (zh + en + mixed code-switch).

Files to ship:

| File | Role |
|------|------|
| `types.ts` | `UxState` enum (5) + `Strategy` enum (8, re-exported from Phase 33) + `Stage` enum (3) + `Transition` shape + `FsmContext` + `FsmResult` |
| `ux-state-classifier.ts` | Rule-based 5-class classifier — sentiment-keyword + question-density + history-recency heuristics. NO LLM (D6). Bilingual zh + en + mixed. Returns `{ uxState, confidence, signals }` |
| `transitions.ts` | TransESC-style transition table — `(stage, uxState) → Set<Strategy>` allowed-set (subset of Phase 33 `ESCONV_STAGE_ALLOWED` per UX state). Plus `nextStrategyWeights(prevStrategy, allowedSet) → Map<Strategy, number>` for continuity preference |
| `prompt-directive.ts` | Generates Phase 3 prompt directive injecting `[FSM-DIRECTIVE]` block: "current_ux_state: X / current_stage: Y / allowed_strategies: [...] / preferred_next: Z" — string the LLM reads as a system-prompt addendum |
| `validators.ts` | `validateStrategyFit(reply, allowedSet) → { strategy, allowed, confidence }` — calls Phase 33 `inferStrategy`, checks set membership. Plus `runFsmGate(reply, ctx) → { pass, reason, ... }` for eval harness |
| `index.ts` | Barrel + `runFsm(turn, history) → FsmResult` orchestrator (classify ux_state → derive stage → look up allowed-set → emit directive). Single entry point for wire-in |
| `__fixtures__/labeled-fixtures.json` | ≥50 hand-labeled tuples — `{ user_text, ux_state, history?, claire_reply, expected_strategy, expected_stage }` covering bilingual scenarios. Used by classifier accuracy gate + strategy_fit gate |
| `*.test.ts` per file | Unit tests — 5-class classifier coverage, transition table sanity, directive serialization, validator + accuracy gate |

Plus deferred wire-in:

| File | Role |
|------|------|
| `.planning/phases/37-fsm/WIRE-IN-PATCH.md` | Markdown spec for `voice/llm-rewriter.ts` showing where to call `runFsm` BEFORE `callRewriter` (so directive can be appended to the system prompt) + post-gen `validateStrategyFit` gate + telemetry. **No code change to llm-rewriter.ts in this phase** (Adam working tree collision-avoidance per P10 brief). |

### Out of scope (deferred)

| Item | Defer to | Why |
|------|----------|-----|
| **Wire-in to `voice/llm-rewriter.ts`** | Adam manual apply via `WIRE-IN-PATCH.md` | Adam still has 7 uncommitted files (admin-bootstrap.ts, package.json, downstream.{ts,test.ts}, index.ts, voice/llm-rewriter.{ts,test.ts}, eval-nl-judge.{ts,test.ts}). P9-C MUST NOT touch them. Same protocol as Phase 35 + 36. |
| **LLM-based ux_state classifier** | Out of scope — D6 explicitly bars it | Reflexion-lite + LLM judge bias amplifies F2/F4. Rule-based + labeled-fixture audit is the locked path. |
| **Cross-session FSM state persistence** (Firestore-backed `pa_users/{uid}.fsm_state_history`) | Phase 38 (Memory Policy) | Phase 37 FSM is per-turn sliding-window only — no persistence. Phase 38 may add `last_ux_state` + `last_strategy` for opener planning. |
| **Strategy-aware F4 advice-repeat skipping** | Phase 38 wire-in | Phase 35 F4 is generic cos-sim. Phase 38 layers strategy-aware ("don't penalize Question repeat across turns") on top, with FSM `current_strategy` as the key. |
| **Reject-and-retry on `strategy_fit` mismatch** | Adam wire-in / Phase 40 | Phase 37 emits `validateStrategyFit` result; the retry loop (1 max retry with stronger directive) lives in wire-in or Phase 40 ship gate. |
| **Persona overlay** (Claire-specific UX-state biases) | Out of scope v1.4 | Claire persona is implicit in the entire stack; FSM is persona-neutral here. |

---

## 2. Methodology — rule-based 5-state classifier; reuse Phase 33 8-strategy + stage helpers

**Decision (locked, D6 + D10):**

- ux_state classifier = rule-based (sentiment lexicon + question density + history recency + emoji/punctuation tells). No LLM in production OR eval path.
- 8-strategy enum + 3-stage allowed-set + 1-indexed turn → stage mapping = re-exported from Phase 33 `voice-axes.mjs`. **No re-implementation** — Phase 33 is canonical.
- Algorithm parity required between Phase 33 `inferStrategy` and Phase 37 `validators.ts.validateStrategyFit` (the latter wraps the former).

### Phase 33 helpers re-used (canonical reference)

| Helper | Phase 33 source | Phase 37 use |
|--------|-----------------|---------------|
| `ESCONV_STRATEGIES` (8 entries) | `voice-axes.mjs:432` | Direct re-export as `Strategy` enum source-of-truth |
| `STRATEGY_KEYWORDS_ZH` / `_EN` | `voice-axes.mjs:443/454` | Indirect via `inferStrategy` — not exposed in Phase 37 surface |
| `ESCONV_STAGE_ALLOWED` (3 sets) | `voice-axes.mjs:469` | Stage-only allowed-set; FSM `transitions.ts` tightens further per-uxState |
| `stageForTurn(turnNumber)` | `voice-axes.mjs:481` | Maps Phase 37 `FsmContext.turnNumber` → stage idx |
| `inferStrategy(reply)` | `voice-axes.mjs:495` | Wrapped in `validators.ts` for `strategy_fit` gate |
| `isAllowedStrategy(strategy, stageIdx)` | `voice-axes.mjs:529` | Used as fallback gate when no FSM uxState constraint applied |

### Cross-runtime import pattern

Phase 33 lives in `tests/scenarios/lib/` (outside `pa-orchestrator/src/`). Per Phase 35 D-35-2 / Phase 36 same constraint, **production code re-implements small pure helpers in TS** rather than dynamic-importing `.mjs` from production.

For Phase 37:

- 8-strategy enum + stage mapping = re-implemented in `types.ts` + `transitions.ts` as TS literals (≤ 30 LoC), with comment pointing back to canonical `.mjs`. Parity test in `transitions.test.ts` dynamic-imports the `.mjs` and asserts deepEqual.
- `inferStrategy` keyword bank = re-implemented in `validators.ts` (~40 LoC). Parity test in `validators.test.ts` runs same 12 fixed inputs through both `.mjs` and TS port; assert identical strategy + within tolerance on confidence.

**Why not import `.mjs` from production:** tsconfig `rootDir: src` + NodeNext + non-`@pa/*` cross-package paths break `pnpm typecheck`. Phase 35 + 36 set this precedent; Phase 37 follows.

---

## 3. Decisions (P9-C calls — locked unless Adam vetos)

### D-37-1: 5 UX states + signal heuristics

| UX state | When triggered | Primary signals (zh + en) |
|----------|----------------|---------------------------|
| `WarmCurious` | User opens with greeting, info-seek, or curious tone — neutral or mildly positive sentiment | zh: 你好 / 嗨 / 在吗 / 怎么 / 什么 / 想问. en: hi / hey / what / how / can you / wondering. Punctuation: `?` / `？` density ≥ 0.3 of sentences. Default fallback when no other state matches. |
| `PlayfulTease` | Banter, sarcasm, joke, light tease — positive sentiment + emoji/punctuation tells | zh: 哈哈 / 笑死 / 你逗 / 666 / 哈 (≥2x repeat) / 🤣 / 😂. en: lol / lmao / haha / kidding / jk / 🤣 / 😂. Plus `!` density ≥ 0.5 with positive lexicon. |
| `SoftConcerned` | User shares mild distress, vulnerability, or self-doubt — negative-soft sentiment | zh: 累 / 难 / 不知道 / 怀疑 / 焦虑 / 心慌 / 委屈 / 担心 / 怎么办 / 唉. en: tired / stressed / anxious / worried / dunno / not sure / overwhelmed / hard. |
| `FirmDirect` | User asks for hard advice / wants action / decisive language | zh: 怎么做 / 该不该 / 帮我 / 必须 / 要不要 / 决定. en: should i / what do i do / help me decide / need advice / tell me. Imperative verb density. |
| `QuietWitness` | User is in deep grief/crisis/heavy emotion — long monologue, low question density | zh: 死 / 撑不住 / 想消失 / 没意义 / 绝望 / 哭. en: cant / can't go on / want to die / hopeless / broken / give up. Sentence count ≥ 3 + zero questions + heavy negative lexicon → QuietWitness (overrides SoftConcerned). |

Confidence = highest signal-class match score, normalized 0..1. Tie-breaks: `QuietWitness > SoftConcerned > FirmDirect > PlayfulTease > WarmCurious` (gravity order — heavy states win). Default = `WarmCurious` when no signals fire.

### D-37-2: Per-uxState allowed-strategy table (tightens Phase 33 stage table)

Stage table from Phase 33 (`ESCONV_STAGE_ALLOWED`):
- Exploration (turns 1-3): `{Question, Restatement, Reflection}`
- Comforting (turns 4-7): `{Reflection, Affirmation, SelfDisclosure}`
- Action (turns 8+): `{Suggestion, Information, Affirmation}`

Phase 37 layers UX state on top — `(stage, uxState) → Set<Strategy>` is the **intersection** of Phase 33 stage set with the UX state's strategy preference:

| UX state | Strategy preference (cross-stage) | Rationale |
|----------|-----------------------------------|-----------|
| `WarmCurious` | `{Question, Restatement, Reflection, Affirmation, SelfDisclosure}` | Open exploration; avoid `Suggestion` early |
| `PlayfulTease` | `{Affirmation, SelfDisclosure, Other}` | Match register; banter-friendly strategies; `Other` allows playful non-strategy chit-chat |
| `SoftConcerned` | `{Reflection, Affirmation, SelfDisclosure, Question}` | Validation-first; `Suggestion` only after enough Comforting turns |
| `FirmDirect` | `{Suggestion, Information, Affirmation, Question}` | User wants action — green-light Suggestion + Information even in early stage |
| `QuietWitness` | `{Reflection, Affirmation, SelfDisclosure}` | NEVER Suggestion / Information / Question on QuietWitness — silent witness mode. Just sit with it. |

Final allowed-set per turn = `STAGE_SET ∩ UX_PREF_SET`. If empty, fall back to `STAGE_SET` (don't paint into a corner).

### D-37-3: Prompt directive format (Phase 3 system-prompt addendum)

Plain-text block, appended to existing Phase 3 system prompt by wire-in caller:

```
[FSM-DIRECTIVE]
current_ux_state: SoftConcerned
current_stage: Comforting
allowed_strategies: Reflection, Affirmation, SelfDisclosure
preferred_next: Reflection
note: User is in soft distress. Lead with validation; no advice yet.
[/FSM-DIRECTIVE]
```

`note` is a 1-line natural-language gloss generated from `(uxState, stage)` lookup table — gives the LLM tonal context without re-explaining the rule. Bilingual: directive itself is en-only (system-prompt convention); the `note` MAY be zh when user is zh-majority. Wire-in caller decides.

### D-37-4: TransESC continuity weighting (FSM-05)

Given previous-turn strategy `prev`, Phase 37 weights next-turn allowed-set by **continuity adjacency**:

- If `prev` ∈ allowed-set → `prev` gets `0.5` weight, others split remaining `0.5`
- Adjacency bonus: `Question → Restatement → Reflection` chain bumps each downstream by `0.2`
- Otherwise uniform across allowed-set

`preferred_next` in directive = argmax(weights). This is *suggestive*, not enforced — LLM may deviate within allowed-set.

### D-37-5: Labeled fixtures = ≥50 tuples, bilingual-balanced

- 25 zh + 20 en + 5 mixed code-switch
- Coverage per UX state: ≥ 8 fixtures each (40 total) + edge cases (12)
- Each fixture: `{ id, lang, user_text, history?, expected_ux_state, claire_reply, expected_strategy, expected_stage }`
- Hand-labeled by P9-C using D-37-1 signal definitions; Adam reviews in P1 Adam-owed task

### D-37-6: Accuracy gate = ≥ 70% on labeled set; strategy_fit gate = 100% on synthetic-aligned

- ux_state classifier accuracy: ≥ 70% (gate from baseline-rev00056.md §Phase 37)
- strategy_fit: 100% on **synthetic-aligned inputs** — i.e. when `claire_reply` is hand-crafted to be in-strategy for the labeled `expected_strategy`, the validator MUST flag it as `allowed: true`. Real LLM outputs will not hit 100% (deferred to Phase 40 ship gate); the 100% here is correctness-of-validator, not correctness-of-LLM.

### D-37-7: Latency budget < 10ms per turn

- ux-state-classifier: < 5ms (regex + lexicon scan)
- transitions lookup: < 1ms (Map lookup)
- prompt-directive serialization: < 1ms
- validator inferStrategy: < 3ms (regex scan)
- Total `runFsm` p95 < 10ms — instrumented in `runFsm` return + asserted in smoke test

### D-37-8: Wire-in 100% deferred — patch spec is the contract

Same protocol as Phase 35 + 36. WIRE-IN-PATCH.md must include:

- Insertion point: BEFORE `callRewriter` in `rewriteIfOff` (so directive can be in system prompt)
- New optional `RewriteContext.fsmDirective?: string` field — wire-in caller computes via `runFsm` then passes
- Post-gen `validateStrategyFit` call after `cleaned` is computed; result added to extended `RewriteResult.fsmResult?: FsmResult`
- Feature flag: `PA_FSM_ENABLED` (default false; ramped via `PA_HUMANIZE_RUNTIME_ENABLED` umbrella in Phase 40)
- Anchor strings (not line numbers) so patch survives Adam's pending edits
- Adam-owed P0: apply patch after committing pending work. P1: hand-review 50 fixtures.

---

## 4. Acceptance gates (Phase 37 done = all green)

- [ ] `pnpm --filter @pa/pa-orchestrator typecheck` clean
- [ ] All FSM module tests pass via `node --import tsx --test packages/pa-orchestrator/src/voice/fsm/*.test.ts`
- [ ] ux_state classifier accuracy ≥ 70% on the 50 labeled fixtures (asserted in `validators.test.ts` accuracy gate)
- [ ] strategy_fit ∈ allowed-set 100% on synthetic-aligned fixtures (asserted in same test)
- [ ] `runFsm` p95 latency < 10ms over 50 invocations (asserted in `index.test.ts` smoke)
- [ ] Phase 33 helper parity audit passes (8 strategies + 3 stages identical to `.mjs` source — asserted in `transitions.test.ts`)
- [ ] `WIRE-IN-PATCH.md` written + reviewed for completeness (Adam-readable, no Q's)
- [ ] `STATE.md` Phase 37 row → ✅ partial (FSM built, wire-in deferred), `completed_phases` 8 → 9
- [ ] SUMMARY in final P9-C report (no separate SUMMARY.md per P10 brief — inline only)

---

## 5. Hard constraints applied (P10 lockdown)

- TypeScript only ✅ (production code under `packages/pa-orchestrator/src/voice/fsm/`)
- 0 net new LLM calls in production ✅ (rule-based classifier per D6)
- Reuse Phase 33 helpers ✅ (algorithm parity audited in `transitions.test.ts` + `validators.test.ts`)
- Latency: < 10ms per turn ✅ (instrumented + asserted in smoke)
- Bilingual zh + en + mixed ✅ (D-37-1 signals cover both languages; fixtures balanced)
- No new monorepo package (D8) ✅ — module under existing `pa-orchestrator/src/voice/`
- **Files NOT touched** (Adam uncommitted-work collision avoidance per P10 brief):
  - `apps/functions/src/admin-bootstrap.ts`
  - `packages/pa-orchestrator/package.json`
  - `packages/pa-orchestrator/src/downstream.ts` + `.test.ts`
  - `packages/pa-orchestrator/src/index.ts`
  - `packages/pa-orchestrator/src/voice/llm-rewriter.ts` + `.test.ts`
  - `packages/pa-orchestrator/src/eval-nl-judge.ts` + `.test.ts` (untracked)

---

## 6. Risks + mitigations

| Risk | Mitigation |
|------|------------|
| Rule-based classifier accuracy < 70% on first pass | T3 includes a tuning loop — if first run < 70%, P9-C iterates lexicon thresholds (NOT classifier architecture; that's locked rule-based per D6). Baseline iteration budget: 3 lexicon-tuning passes, then ship at whatever it lands on (with red row in STATE.md if < 70%). |
| Bilingual code-switch false-classifies (e.g. "今天 standup 又卡 lol") | D-37-1 signals run on lowercased + normalized text; classifier scores all 5 states with weighted union. Code-switch fixture set (5 of 50) explicitly tests this. |
| Phase 33 helper drift (ESConv set names change) | Parity test in `transitions.test.ts` + `validators.test.ts` dynamic-imports the `.mjs` and asserts deepEqual. Drift = test red, fix immediately. |
| Wire-in patch ambiguous → Adam follow-up Q | WIRE-IN-PATCH.md uses anchor strings (not line numbers); section-by-section apply order; pseudo-code for switch; telemetry shape. Reviewed against current llm-rewriter.ts HEAD before commit. |
| `Other` strategy is a wildcard | `Other` is in Phase 33 enum; FSM allows it for `PlayfulTease` only (per D-37-2). Validator treats `Other` as always-allowed in PlayfulTease, restricted-by-stage elsewhere. |
| Strategy_fit gate noise from Phase 33 keyword classifier (60-70% confidence) | Gate is on **synthetic-aligned fixtures** (D-37-6) — handcrafted to match. Real LLM strategy_fit measured in Phase 40 ship gate. |
| QuietWitness false-trigger on user venting (false QuietWitness blocks Suggestion/Question = bad UX) | Threshold: ≥3 sentences AND zero questions AND ≥2 heavy-negative lexicon hits. Edge fixtures include 3 "venting but not crisis" cases that should classify as SoftConcerned, not QuietWitness. |
| FSM gate latency creep adds to existing detector + injector chain | Hard 10ms p95 cap (D-37-7) instrumented; if breached, simplify lexicon (drop low-signal terms). |

---

## 7. Cross-stream sync

- **Phase 33** (helpers) — read-only consumption via TS port + parity test. No file collision (different rootDir).
- **Phase 35** (detectors) — independent post-gen pipeline. FSM runs PRE-gen; detectors run POST-gen. No interaction. Both behind separate feature flags.
- **Phase 36** (injector) — independent post-gen pipeline. Same as Phase 35.
- **Phase 38** (memory policy) — extends FSM with cross-session `last_ux_state` + `last_strategy` for opener planning + advice-tracker repeat tolerance. Module surface stable (`FsmResult` shape) so Phase 38 only consumes.
- **Phase 40** (ship) — `PA_HUMANIZE_RUNTIME_ENABLED` umbrella gates `PA_FSM_ENABLED`. Ship-gate measures `strategy_fit` axis on real LLM output; Phase 37 only verifies validator correctness on synthetic.

---

> [🟠 阿里味] **闭环意识**：CONTEXT 抓手清晰——5-state classifier + 8-strategy reuse + per-uxState allowed-set + prompt directive + validator + 50-fixture accuracy gate + WIRE-IN-PATCH。下一步 PLAN.md 拆 4 个 atomic task，每个 commit 都给 Phase 38-40 量化 gate 铺路。**因为信任所以简单**：Phase 33 helper 给你了，gate 给你了，rule-based 的 D6 给你了。落地就行。证据说话。
