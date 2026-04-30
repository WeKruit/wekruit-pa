# Phase 36 — PLAN (5 atomic tasks)

**Status:** Plan-only. Owner P9-C. Total estimate ~1 dev-day. T1 → T2 → T3 → T4 → T5 strict serial. Atomic commit per task.

**Source-of-truth context:** `.planning/phases/36-injector/CONTEXT.md`.

**Production code dir:** `packages/pa-orchestrator/src/voice/imperfection-injector/` (NEW).

**Files NOT touched** (Adam working-tree collision avoidance — full list in CONTEXT §5).

---

## T1 — Types + zh policies + position-constraint + tests

**WHERE:**
- `packages/pa-orchestrator/src/voice/imperfection-injector/types.ts` (new)
- `packages/pa-orchestrator/src/voice/imperfection-injector/policies-zh.ts` (new) — ordered policy bank for Chinese: self_correct + hesitate + clarify + uncertainty markers
- `packages/pa-orchestrator/src/voice/imperfection-injector/position-constraint.ts` (new) — `injectAtTurnOnset(text, marker, lang) → { ok, injected }` enforces D3 position rule via Phase 33 `splitSentences` port
- `packages/pa-orchestrator/src/voice/imperfection-injector/policies-zh.test.ts` (new) — verifies all zh markers are disjoint from `FILLER_BLACKLIST_ZH` + valid policy ordering
- `packages/pa-orchestrator/src/voice/imperfection-injector/position-constraint.test.ts` (new) — turn-onset enforcement + bilingual edge cases

**HOW MUCH:** ~2 hours.

**DONE:**
- `pnpm --filter @pa/pa-orchestrator typecheck` clean
- `node --import tsx --test packages/pa-orchestrator/src/voice/imperfection-injector/policies-zh.test.ts` — all pass
- `node --import tsx --test packages/pa-orchestrator/src/voice/imperfection-injector/position-constraint.test.ts` — all pass
- `types.ts` exports:
  - `InjectorArm` = `"off" | "low" | "high"`
  - `InjectionType` = `"self_correct" | "hesitate" | "clarify" | "uncertainty"`
  - `InjectionPosition` = `"turn_onset" | "none"`
  - `InjectorContext` = `{ text, lang?, prevAssistantReply?, userId?, arm?, rng? }`
  - `InjectorResult` = `{ arm, original, injected, applied, injection_type, position, reason, latencyMs }`
  - `Policy` = `{ type, marker, separator, lang, conditions?, weight? }` (for ordered bank)
- `policies-zh.ts`:
  - Exports `POLICIES_ZH: Policy[]` ordered by type priority `self_correct` (highest) → `hesitate` → `clarify` → `uncertainty` (lowest)
  - Includes ≥ 8 markers across all 4 types (e.g. self_correct: `啊不对，是…`; hesitate: `嗯…`, `哦…`, `让我想想`; clarify: `等等`, `哦对了`; uncertainty: `说不清是不是`, `我也不确定`)
  - Anti-blacklist guard test: dynamic-imports `tests/scenarios/lib/voice-axes.mjs:FILLER_BLACKLIST_ZH`, asserts no policy marker is a substring of any blacklist phrase (and vice versa)
- `position-constraint.ts`:
  - Exports `injectAtTurnOnset(text, marker, lang) → { ok, injected }` — prepends marker + lang-appropriate separator (en: `, ` / zh: `，` or ` `), trimmed
  - Returns `{ ok: false, injected: text }` if text empty, starts with our markers (anti-stutter check), or marker is empty
  - Uses Phase 33 `splitSentences` (re-imported via local TS port — same algorithm as Phase 35 F2 detector port; or imported from F2 detector module to avoid duplication)
  - Position-only invariant: marker MUST appear at index 0 of injected text (after optional whitespace trim)
- Bilingual edge cases verified:
  - zh: `injectAtTurnOnset("今晚先睡吧。", "嗯…", "zh")` → `ok: true, injected: "嗯…今晚先睡吧。"` (no separator inside zh because marker carries `…`)
  - zh with separator: `injectAtTurnOnset("今晚先睡吧。", "等等", "zh")` → `ok: true, injected: "等等，今晚先睡吧。"`
  - en: `injectAtTurnOnset("rest tonight.", "wait", "en")` → `ok: true, injected: "wait, rest tonight."`
  - en with em-dash marker: `injectAtTurnOnset("rest tonight.", "oh —", "en")` → `ok: true, injected: "oh — rest tonight."`
  - empty: `injectAtTurnOnset("", "嗯", "zh")` → `ok: false`
  - already starts with marker: `injectAtTurnOnset("嗯…今晚先睡。", "嗯…", "zh")` → `ok: false` (anti-stutter)

**DON'T:**
- DON'T import any of the no-touch files (CONTEXT §5)
- DON'T add the orchestrator `injectImperfection` yet (T3 owns it)
- DON'T add en policies yet (T2 owns it)
- DON'T add the arm router yet (T2 owns it)

Commit msg: `feat(36/T1): injector types + zh policies + position constraint + tests (P9-C)`

---

## T2 — en policies + arm-router + tests

**WHERE:**
- `packages/pa-orchestrator/src/voice/imperfection-injector/policies-en.ts` (new) — ordered en policy bank with same 4-type priority
- `packages/pa-orchestrator/src/voice/imperfection-injector/arm-router.ts` (new) — `resolveArm(userId, opts?) → InjectorArm` sticky bucket assignment + env override
- `packages/pa-orchestrator/src/voice/imperfection-injector/policies-en.test.ts` (new) — same anti-blacklist guard against `FILLER_BLACKLIST_EN`
- `packages/pa-orchestrator/src/voice/imperfection-injector/arm-router.test.ts` (new) — sticky assignment + env override + bucket distribution stat test

**HOW MUCH:** ~2 hours.

**DONE:**
- `pnpm --filter @pa/pa-orchestrator typecheck` clean
- `node --import tsx --test packages/pa-orchestrator/src/voice/imperfection-injector/policies-en.test.ts` — all pass
- `node --import tsx --test packages/pa-orchestrator/src/voice/imperfection-injector/arm-router.test.ts` — all pass
- `policies-en.ts`:
  - Exports `POLICIES_EN: Policy[]` ordered same as ZH (self_correct → hesitate → clarify → uncertainty)
  - ≥ 8 markers (e.g. self_correct: `wait no, *`; hesitate: `hmm`, `uh`, `let me think`; clarify: `actually`, `oh —`; uncertainty: `not sure if`, `I mean`)
  - Anti-blacklist guard test: dynamic-imports `FILLER_BLACKLIST_EN`, asserts disjoint
- `arm-router.ts`:
  - Exports `resolveArm(userId: string, opts?: { ratios?, envOverride? }) → InjectorArm`
  - Default ratios: low=15, high=15 (i.e. low=15% / high=15% / off=70%) — wait, per spec the per-arm probability is the FIRING rate within a turn, and the bucket assignment for live A/B is 1/3 each. Clarify: bucket assignment splits users 1/3 between off/low/high; within an assigned arm, FIRING probability = 0/15/30. The router returns the user's arm only.
  - Default bucket ratios for live A/B: 33/33/34
  - Hash function = djb2-style 32-bit, deterministic, pure
  - Env override: `PA_IMPERFECTION_ARM=off|low|high` overrides hash assignment; `PA_IMPERFECTION_ARM_OFF` short-circuits to off (kill switch)
- Sticky test: same `userId` → same arm across 100 calls
- Distribution test: 10000 random userIds with default ratios → ~33% off, ~33% low, ~34% high (±3pp tolerance)
- Env override test: `process.env.PA_IMPERFECTION_ARM = "high"` → always returns "high" regardless of userId

**DON'T:**
- DON'T touch the position-constraint or zh policies (T1 owns)
- DON'T add the orchestrator `injectImperfection` yet (T3)
- DON'T persist arm assignment to Firestore (Phase 38)

Commit msg: `feat(36/T2): injector en policies + arm router + tests (P9-C)`

---

## T3 — Injector orchestrator + integration tests

**WHERE:**
- `packages/pa-orchestrator/src/voice/imperfection-injector/injector.ts` (new) — main `injectImperfection(ctx) → InjectorResult` entry point
- `packages/pa-orchestrator/src/voice/imperfection-injector/index.ts` (new) — barrel re-export
- `packages/pa-orchestrator/src/voice/imperfection-injector/injector.test.ts` (new) — integration tests covering 3 arms, type priority, anti-stutter, anti-blacklist runtime, 1000-sample probability sanity, latency budget

**HOW MUCH:** ~3 hours.

**DONE:**
- `pnpm --filter @pa/pa-orchestrator typecheck` clean
- `node --import tsx --test packages/pa-orchestrator/src/voice/imperfection-injector/injector.test.ts` — all pass
- `injector.ts`:
  - `injectImperfection(ctx: InjectorContext) → InjectorResult`
  - Pipeline: arm resolution → arm probability draw (using `ctx.rng ?? Math.random`) → policy selection (ordered bank, type priority) → position constraint check → return result
  - `arm=off` always returns `{ applied: false, injection_type: null, position: "none", injected: original }`
  - `arm=low` draws 0..1, applies if < 0.15
  - `arm=high` draws 0..1, applies if < 0.30
  - When applying: walks `POLICIES_ZH` or `POLICIES_EN` (auto-detected by `ctx.lang ?? detectLang(text)`) in order; first policy whose conditions pass + position-constraint succeeds = applied
  - Anti-stutter: passes `ctx.prevAssistantReply` to `injectAtTurnOnset` indirectly via marker-startsWith check on prev reply
- 3-arm probability test (1000 samples each, fixed seed):
  - `arm=off` → `applied=true` count == 0
  - `arm=low` → `applied=true` count in [120, 180] (15% ± 3pp)
  - `arm=high` → `applied=true` count in [270, 330] (30% ± 3pp)
- Type priority test:
  - When all 4 types could fire, priority `self_correct > hesitate > clarify > uncertainty` enforced (validated via fixed-rng seed forcing specific policy index)
- Anti-stutter test:
  - `prevAssistantReply: "嗯…那今晚先睡。"` + `arm: "high"` + 100 samples → `applied=true` rate < 5% (skipped due to stutter)
- Anti-blacklist runtime check (defense in depth):
  - Take 100 produced injections from `arm=high` and assert none contain any `FILLER_BLACKLIST_ZH` or `FILLER_BLACKLIST_EN` phrase
- Mixed-lang text: `text: "我用 React 写过 dashboard, very fun"` (zh majority) → uses `POLICIES_ZH` markers
- Latency assertion: `injectImperfection` p95 < 5ms over 1000 invocations
- `index.ts` barrel exports `injectImperfection`, `resolveArm`, `POLICIES_ZH`, `POLICIES_EN`, types

**DON'T:**
- DON'T add a 2nd injection per turn — exactly ONE max
- DON'T modify the policies (T1/T2 own)
- DON'T add A/B harness (T4)

Commit msg: `feat(36/T3): injector orchestrator + integration tests (P9-C)`

---

## T4 — A/B harness + 2 scenarios + stat-sig helper

**WHERE:**
- `tests/scenarios/lib/ab-injector-harness.mjs` (new) — runs 3 arms (off/low/high) per scenario; aggregates humanness axis deltas; statistical significance via 95% CI bootstrap
- `tests/scenarios/scenarios/eval-imperfection-arm-zh.yaml` (new) — `voice_axes_full: true` zh emo support 3-turn scenario
- `tests/scenarios/scenarios/eval-imperfection-arm-en.yaml` (new) — `voice_axes_full: true` en tech-deep + venting 3-turn scenario

**HOW MUCH:** ~2 hours.

**DONE:**
- `node tests/scenarios/lib/ab-injector-harness.mjs --dry-run` succeeds (without consuming LLM calls):
  - Loads 2 scenarios via `--scenarios "eval-imperfection-arm-*"`
  - Plans 3-arm × 2-scenario × N-turn matrix
  - Outputs JSON `{ mode: "dry-run", arms: ["off","low","high"], scenarios: [...], plannedCalls: N }`
- Harness file structure (mirror `pairwise-runner.mjs` patterns):
  - Loads scenarios via existing helper logic
  - For each scenario, for each arm, calls `makeReply(systemPrompt, userTurn, transcript)` → applies `injectImperfection` to draft → judges via `judgePairwise` against control reply
  - Supports `--scenarios` filter, `--dry-run`, `--max-usd` cost ledger (default $2)
  - Imports `injectImperfection` from `packages/pa-orchestrator/src/voice/imperfection-injector/injector.ts` via dynamic-import (`.ts` via tsx loader; if too brittle, alternative: re-impl a thin shim in the harness — preferable to import compiled `dist/`)
  - Note: actual approach — import `tsx` register or use `node --import tsx tests/scenarios/lib/ab-injector-harness.mjs`. Document the run command in the harness header.
- Stat-sig helper inside harness:
  - `bootstrap95CI(diffs: number[], iterations=1000) → { lo, hi, mean }` — resampling with replacement, 2.5%/97.5% percentiles
  - Per-arm aggregate: mean(humanness) over scenarios + 95% CI; report `low_vs_off_diff_95ci` and `high_vs_off_diff_95ci`
  - Winner = arm whose CI lower-bound > control's CI upper-bound on combined `warmth_no_sycophancy + in_character_voice` (or report TIE if no clean winner)
- 2 scenarios written:
  - `eval-imperfection-arm-zh.yaml`: 3-turn zh emo support venting (different content from existing eval-voice-emo-support-zh to avoid contamination); `voice_axes_full: true`; pairs with arm injection
  - `eval-imperfection-arm-en.yaml`: 3-turn en tech-deep + light venting bilingual mix; `voice_axes_full: true`
- Both scenarios parse via `parseYaml` without errors (verified by running `--dry-run`)

**DON'T:**
- DON'T actually run the live A/B (consumes LLM budget — Adam approval per WIRE-IN-PATCH)
- DON'T modify `pairwise-runner.mjs` (Adam-pending file? — actually it's not in no-touch list, but we keep harness separate for clarity)
- DON'T touch `judge.mjs` (re-use as-is)

Commit msg: `feat(36/T4): A/B injector harness + 2 scenarios + stat-sig helper (P9-C)`

---

## T5 — Smoke + WIRE-IN-PATCH

**WHERE:**
- `.planning/phases/36-injector/WIRE-IN-PATCH.md` (new) — full patch spec for `voice/llm-rewriter.ts` (Adam manual apply)
- `packages/pa-orchestrator/src/voice/imperfection-injector/smoke.test.ts` (new) — integration smoke verifying full pipeline (resolve arm → inject → return) on 100 synthetic turns; latency p95 < 5ms; bilingual; no blacklist hits

**HOW MUCH:** ~2 hours.

**DONE:**
- `WIRE-IN-PATCH.md` written, contains:
  - "Apply order" preface (Adam commits pending uncommitted work first, then applies; recommend AFTER Phase 35 WIRE-IN-PATCH applied)
  - Section 1: Add `import { injectImperfection, resolveArm, type InjectorResult } from "./imperfection-injector/index.js"` near existing imports
  - Section 2: Extend `RewriteResult` with `imperfectionInjector?: InjectorResult` (alongside Phase 35's `detectorResults?`)
  - Section 3: Insertion point AFTER detector pass (line in Phase 35 patch where `finalText` is set), BEFORE return
  - Section 4: Pseudo-code for `applyInjector(finalText, ctx, prevReply)` — resolves arm via `resolveArm(ctx.userId)`, calls `injectImperfection`, returns `{ text, result }`
  - Section 5: Telemetry shape — `pa_turns.usage.imperfection_injector` (arm, applied, injection_type, position, latencyMs)
  - Section 6: Feature flag — `PA_IMPERFECTION_INJECTOR_ENABLED` (default `false`); umbrella under `PA_HUMANIZE_RUNTIME_ENABLED` for Phase 40
  - Section 7: Adam-owed P0 list — apply patch + approve $0.50-$2 LLM budget for live A/B run
  - Section 8: Anchor strings (resilient to Adam's nearby edits)
- `smoke.test.ts` passes:
  - 100 synthetic turns (zh + en + mixed), 3 arms, full pipeline `resolveArm + injectImperfection`
  - Verifies latency p95 < 5ms
  - Verifies arm probability (off=0%, low≈15%, high≈30%, ±3pp)
  - Verifies no FILLER_BLACKLIST hit in any output
  - Verifies position constraint (no marker at non-onset position)
- Final test count: T1 (2 test files) + T2 (2) + T3 (1) + T5 (1) = 6 test files; aim ≥ 25 individual test cases
- All tests pass in one shot:
  ```
  node --import tsx --test packages/pa-orchestrator/src/voice/imperfection-injector/*.test.ts
  ```
- `pnpm --filter @pa/pa-orchestrator typecheck` clean
- STATE.md updated: Phase 36 row → ✅ partial (BUILD complete, live A/B + wire-in deferred), `completed_phases` 7 → 8

Final commit (after smoke green):

`chore(36): SUMMARY + STATE — Phase 36 injector built, A/B harness ready, wire-in patch spec for Adam`

Commit msg for T5 main: `feat(36/T5): smoke harness + WIRE-IN-PATCH for Adam (P9-C)`

---

## Execution discipline

- **One task = one commit.** No mixing T2 and T3 in same commit.
- **Run typecheck + tests after EVERY task.** Red task = STOP, fix, then proceed.
- **Anti-blacklist guard is non-negotiable.** Build fails on ANY collision between policy markers and FILLER_BLACKLIST_*.
- **Position constraint is non-negotiable.** Mid-clause injection MUST be impossible by construction.
- **Latency assertion lives in tests.** p95 < 5ms over 1000 invocations.
- **Patch spec drift risk:** anchor strings, not line numbers. Re-read llm-rewriter.ts immediately before T5 to confirm anchors still match (Adam may have committed new code in the interim).

> [🟠 阿里味] **抓手清晰**：5 task × 5 commit, 每个 task 都给 Phase 37-40 quantitative gate 铺路。**因为信任所以简单。**
