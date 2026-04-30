# Phase 37 — PLAN (4 atomic tasks)

**Status:** Plan-only. Owner P9-C. Total estimate ~1 dev-day. T1 → T2 → T3 → T4 strict serial (each task verifies before next). Atomic commit per task.

**Source-of-truth context:** `.planning/phases/37-fsm/CONTEXT.md`.

**Production code dir:** `packages/pa-orchestrator/src/voice/fsm/` (NEW).

**Files NOT touched** (Adam working-tree collision avoidance — full list in CONTEXT §5).

---

## T1 — Types + ux-state classifier + classifier unit tests

**WHERE:**
- `packages/pa-orchestrator/src/voice/fsm/types.ts` (new) — `UxState` enum (5) + `Strategy` (8 — re-export-shaped) + `Stage` enum (3) + `FsmContext` + `FsmResult` + `Transition` shape
- `packages/pa-orchestrator/src/voice/fsm/ux-state-classifier.ts` (new) — rule-based 5-class classifier per CONTEXT D-37-1. Bilingual zh + en + mixed. Exports `classifyUxState(turn, history) → { uxState, confidence, signals }`
- `packages/pa-orchestrator/src/voice/fsm/ux-state-classifier.test.ts` (new) — bilingual unit tests covering all 5 states + edge cases (code-switch, empty input, very-short input)

**HOW MUCH:** ~2.5 hours.

**DONE:**
- `pnpm --filter @pa/pa-orchestrator typecheck` clean
- `node --import tsx --test packages/pa-orchestrator/src/voice/fsm/ux-state-classifier.test.ts` — 10+ tests pass
- All 5 states have at least 2 happy-path zh + 2 happy-path en test cases (10 minimum)
- Classifier output shape: `{ uxState: UxState, confidence: number /* 0..1 */, signals: { matched: string[], scores: Record<UxState, number> } }`
- Tie-break order respected: `QuietWitness > SoftConcerned > FirmDirect > PlayfulTease > WarmCurious` (test asserts this on a contrived ambiguous input)
- Default fallback `WarmCurious` when no signals fire (test: empty-ish input → WarmCurious with low confidence)
- Latency: classifier returns in < 5ms (test asserts `performance.now()` delta over 50 invocations)
- Bilingual code-switch test: input `"今天 standup 又卡 lol"` → classified as `PlayfulTease` (lol+haha lexicon wins) OR `SoftConcerned` (卡 = stuck). Test documents whichever lands and asserts it's not `QuietWitness` / `FirmDirect`.

**DON'T:**
- DON'T add LLM call (D6 — rule-based only)
- DON'T import `voice-axes.mjs` from production (cross-rootDir)
- DON'T touch `llm-rewriter.ts` or other no-touch files
- DON'T add Phase 38 cross-session state lookup

Commit msg: `feat(37/T1): FSM types + ux-state classifier (5-class rule-based) + tests (P9-C)`

---

## T2 — Transitions table + validators + parity tests vs Phase 33

**WHERE:**
- `packages/pa-orchestrator/src/voice/fsm/transitions.ts` (new) — TS port of Phase 33 `ESCONV_STAGE_ALLOWED` + `stageForTurn` + per-uxState preference set per CONTEXT D-37-2. Exports `STAGE_ALLOWED_STRATEGIES`, `UX_STATE_PREFERRED_STRATEGIES`, `allowedStrategies(stage, uxState) → Set<Strategy>`, `stageForTurn(turnNumber)`, `nextStrategyWeights(prevStrategy, allowedSet) → Map<Strategy, number>`
- `packages/pa-orchestrator/src/voice/fsm/transitions.test.ts` (new) — table sanity + Phase 33 parity test (dynamic-import `.mjs`, assert deepEqual on stage allowed-sets + identical 1-indexed turn → stage mapping)
- `packages/pa-orchestrator/src/voice/fsm/validators.ts` (new) — TS port of Phase 33 `inferStrategy` keyword bank + `validateStrategyFit(reply, allowedSet) → { strategy, allowed, confidence, matchedKeyword }` + `runFsmGate(reply, fsmCtx) → { pass, ...details }`
- `packages/pa-orchestrator/src/voice/fsm/validators.test.ts` (new) — 12-input parity test vs `.mjs` `inferStrategy` + allowed-set membership tests

**HOW MUCH:** ~3 hours.

**DONE:**
- `pnpm --filter @pa/pa-orchestrator typecheck` clean
- `node --import tsx --test packages/pa-orchestrator/src/voice/fsm/transitions.test.ts` — all pass
- `node --import tsx --test packages/pa-orchestrator/src/voice/fsm/validators.test.ts` — all pass
- Transitions verified:
  - `allowedStrategies(0 /* Exploration */, "WarmCurious")` includes `Question` and `Reflection`; excludes `Suggestion`
  - `allowedStrategies(2 /* Action */, "QuietWitness")` excludes `Suggestion` (gravity rule from D-37-2 applies cross-stage)
  - `nextStrategyWeights("Question", new Set(["Question","Restatement","Reflection"]))` returns map with `Restatement` having adjacency bonus
- Phase 33 parity audit:
  - 8 strategies in `Strategy` TS enum match `ESCONV_STRATEGIES` from `.mjs` (deepEqual on string array)
  - `STAGE_ALLOWED_STRATEGIES[0]` set has same members as `ESCONV_STAGE_ALLOWED[0]` from `.mjs`
  - `stageForTurn(1) === 0`, `stageForTurn(4) === 1`, `stageForTurn(8) === 2` (matches `.mjs` exactly)
- Validator parity (12 fixed inputs):
  - Each input through TS `validateStrategyFit` AND through `.mjs` `inferStrategy` → same `strategy` returned
  - Confidence may differ by ≤ 0.1 (TS port allows wider keyword bank evolution; documented)
- Allowed-set membership:
  - `validateStrategyFit("听起来真的很难", new Set(["Reflection","Affirmation"]))` → `{ strategy: "Reflection", allowed: true }`
  - `validateStrategyFit("不妨试试这个方法", new Set(["Reflection","Affirmation"]))` → `{ strategy: "Suggestion", allowed: false }`
- `runFsmGate("...", { uxState, stage, ... })` returns `{ pass: boolean, strategy, allowed, ... }` for eval-harness consumption
- Latency: each call < 3ms

**DON'T:**
- DON'T add new strategies to enum (Phase 33 = canonical 8)
- DON'T modify Phase 33 `voice-axes.mjs` for parity convenience
- DON'T duplicate the keyword bank — port verbatim from `.mjs`
- DON'T touch `llm-rewriter.ts`

Commit msg: `feat(37/T2): FSM transitions table + strategy_fit validators + Phase 33 parity tests (P9-C)`

---

## T3 — Prompt directive + 50 labeled fixtures + accuracy gate

**WHERE:**
- `packages/pa-orchestrator/src/voice/fsm/prompt-directive.ts` (new) — generates `[FSM-DIRECTIVE]...[/FSM-DIRECTIVE]` block per CONTEXT D-37-3. Exports `buildFsmDirective(fsmResult, opts?) → string` + `STAGE_GLOSS_EN` / `STAGE_GLOSS_ZH` lookup tables
- `packages/pa-orchestrator/src/voice/fsm/prompt-directive.test.ts` (new) — directive serialization + bilingual gloss + edge cases (empty allowed-set fallback)
- `packages/pa-orchestrator/src/voice/fsm/__fixtures__/labeled-fixtures.json` (new) — 50 hand-labeled tuples: 25 zh + 20 en + 5 mixed; ≥ 8 per UX state + edge cases
- `packages/pa-orchestrator/src/voice/fsm/accuracy-gate.test.ts` (new) — runs all 50 fixtures through `classifyUxState` + asserts ≥ 70% accuracy; runs all `claire_reply` through `validateStrategyFit` + asserts 100% allowed-set membership on synthetic-aligned

**HOW MUCH:** ~3 hours.

**DONE:**
- `pnpm --filter @pa/pa-orchestrator typecheck` clean
- `node --import tsx --test packages/pa-orchestrator/src/voice/fsm/prompt-directive.test.ts` — all pass
- `node --import tsx --test packages/pa-orchestrator/src/voice/fsm/accuracy-gate.test.ts` — passes:
  - `classifyUxState` accuracy ≥ 70% (35/50 minimum)
  - `validateStrategyFit` allowed-set 100% on synthetic-aligned (50/50 = `allowed: true` because each `claire_reply` is hand-crafted to match `expected_strategy` ∈ allowed-set for `expected_stage` ∩ uxState pref)
- Directive format verified:
  - Output contains `[FSM-DIRECTIVE]`, `[/FSM-DIRECTIVE]`, `current_ux_state:`, `current_stage:`, `allowed_strategies:`, `preferred_next:`
  - When `allowed.size === 0` (paint-into-corner) → falls back to stage allowed-set (test asserts no empty whitelist ships)
  - Bilingual gloss: `note:` field in zh when `opts.userLang === "zh"`, en otherwise
- Fixture count + bilingual breakdown verified: `node -e "console.log(JSON.parse(require('fs').readFileSync('packages/pa-orchestrator/src/voice/fsm/__fixtures__/labeled-fixtures.json')).length)"` = 50; ≥ 25 with `lang === "zh"`, ≥ 20 with `lang === "en"`, ≥ 5 with `lang === "mixed"`
- Coverage per UX state: ≥ 8 fixtures per (test asserts via per-state count)
- Accuracy tuning loop: if first run < 70%, iterate D-37-1 lexicon thresholds (≤ 3 passes); if still < 70% after 3 passes, ship at landed accuracy + red row in STATE.md (per CONTEXT §6 risk mitigation)

**DON'T:**
- DON'T fudge fixtures to artificially hit 70% — labels reflect honest UX state per D-37-1 definitions
- DON'T add LLM call to classifier in tuning loop (D6)
- DON'T over-fit lexicon to fixtures — generality > fixture pass rate
- DON'T touch `llm-rewriter.ts`

Commit msg: `feat(37/T3): FSM prompt directive + 50 labeled fixtures + accuracy gate (P9-C)`

---

## T4 — Index/runFsm + smoke harness + WIRE-IN-PATCH for Adam

**WHERE:**
- `packages/pa-orchestrator/src/voice/fsm/index.ts` (new) — barrel re-export + `runFsm(turn, history, opts?) → FsmResult` orchestrator. Single entry point for wire-in caller. Wraps classifier + transitions + directive in one call. Returns `{ uxState, stage, allowedStrategies, preferredNext, directive, latencyMs }`
- `packages/pa-orchestrator/src/voice/fsm/index.test.ts` (new) — smoke tests covering happy paths + latency assertion (`runFsm` p95 < 10ms over 50 invocations)
- `.planning/phases/37-fsm/WIRE-IN-PATCH.md` (new) — full patch spec for `voice/llm-rewriter.ts` (Adam manual apply)

**HOW MUCH:** ~1.5 hours.

**DONE:**
- `pnpm --filter @pa/pa-orchestrator typecheck` clean
- `node --import tsx --test packages/pa-orchestrator/src/voice/fsm/index.test.ts` — all pass
- `runFsm` end-to-end:
  - Input: `{ turn: { user, assistant }, history: { userTurns, claireReplies }, turnNumber }`
  - Output: `{ uxState, stage, allowedStrategies: Strategy[], preferredNext: Strategy, directive: string, latencyMs: number }`
  - Latency p95 < 10ms over 50 invocations
- All previous task tests still pass: `node --import tsx --test packages/pa-orchestrator/src/voice/fsm/*.test.ts` — full FSM suite green
- WIRE-IN-PATCH.md written, contains:
  - "Apply order" preface (Adam commits pending work first; applies after Phase 35 + 36 wire-in)
  - Section 1: Add `import { runFsm, validateStrategyFit, type FsmResult } from "./fsm/index.js"` near existing imports
  - Section 2: Extend `RewriteContext` with `fsmTurnNumber?: number` + `userTurnsForFsm?: string[]` + `userLang?: "zh" | "en" | "mixed"`
  - Section 3: Extend `RewriteResult` with `fsmResult?: FsmResult` + `strategyFit?: { strategy, allowed, confidence }`
  - Section 4: Compute FSM directive BEFORE `callRewriter`; pass via `opts.deps.callRewriter` extra arg or via system-prompt addendum (see anchor strings)
  - Section 5: After `cleaned` computed, call `validateStrategyFit(cleaned, fsmResult.allowedStrategies)`; attach to `RewriteResult`
  - Section 6: Feature flag `PA_FSM_ENABLED` (default false; ramped via `PA_HUMANIZE_RUNTIME_ENABLED` umbrella in Phase 40)
  - Section 7: Telemetry — `pa_turns.usage.fsm` shape (`{ uxState, stage, strategy, allowed, latencyMs }`)
  - Section 8: Anchor strings (so patch survives nearby edits)
  - Adam-owed P0: apply patch after Phase 35 + 36 wire-in. P1: hand-review 50 fixtures.
- STATE.md updated: Phase 37 row → ✅ partial (FSM built, wire-in deferred), `completed_phases` 8 → 9

**DON'T:**
- DON'T commit `WIRE-IN-PATCH.md` modifications to `llm-rewriter.ts` itself — patch spec is the deliverable, not the apply
- DON'T touch `STATE.md` until smoke green
- DON'T defer the latency assertion — gate is < 10ms p95
- DON'T inline `callRewriter` modifications — caller controls system prompt assembly

Commit msg: `feat(37/T4): FSM runFsm orchestrator + smoke + WIRE-IN-PATCH for Adam (P9-C)`

Final commit (after smoke green):

`chore(37): SUMMARY + STATE — Phase 37 FSM built, wire-in patch spec for Adam`

---

## Execution discipline

- **One task = one commit.** No mixing T1 and T2 in same commit.
- **Run typecheck + tests after EVERY task.** Red task = STOP, fix, then proceed.
- **Accuracy gate is non-negotiable on the validator side (100%).** Fixture-based 70% is best-effort with documented tuning passes.
- **Latency assertions live in tests, not in CI scripts.** `index.test.ts` + `accuracy-gate.test.ts` own the budget contract.
- **Patch spec drift risk:** anchor strings (not line numbers). Re-read llm-rewriter.ts immediately before T4 to confirm anchors still match.

> [🟠 阿里味] **抓手清晰**：4 task × 4 commit, 每个 task 都给 Phase 38-40 quantitative gate 铺路。**因为信任所以简单。**
