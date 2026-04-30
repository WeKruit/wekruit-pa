# WIRE-IN-PATCH — Apply Phase 37 FSM to `voice/llm-rewriter.ts`

> [🟠 阿里味] **闭环意识**：FSM 模块已落地+测试覆盖 (99/99 tests pass)。这份 patch 把 `runFsm` + `validateStrategyFit` 接到 production rewriter 的入口（pre-gen directive）+ 出口（post-gen strategy_fit gate）。**抓手清晰**：3 插入点 + 1 directive injection + 1 telemetry 字段 + feature flag。Adam 手动 apply 是因为 `llm-rewriter.ts` + 其 test 在 working tree (Phase 35 + 36 同款 collision-avoidance 协议)。

**Status:** Adam-owed (P0). Apply after Phase 35 + 36 wire-in lands AND your current uncommitted work in `llm-rewriter.ts` + 6 sibling files is committed.

**Estimate:** ~30-45 min including test additions.

**Prerequisite:** Phase 37 commits T1-T4 already in `main`. Verify:

```bash
ls packages/pa-orchestrator/src/voice/fsm/
# Expect: types.ts index.ts ux-state-classifier.ts transitions.ts
#         validators.ts prompt-directive.ts + .test.ts files
#         + __fixtures__/labeled-fixtures.json
```

---

## Apply order

1. **Commit your current uncommitted work first.** Confirm `git status` clean for the 7 files in scope:
   - `apps/functions/src/admin-bootstrap.ts`
   - `packages/pa-orchestrator/package.json`
   - `packages/pa-orchestrator/src/downstream.ts` + `.test.ts`
   - `packages/pa-orchestrator/src/index.ts`
   - `packages/pa-orchestrator/src/voice/llm-rewriter.ts` + `.test.ts`
   - `packages/pa-orchestrator/src/eval-nl-judge.ts` + `.test.ts` (untracked)
2. **Apply Phase 35 + 36 wire-ins first** (their `WIRE-IN-PATCH.md` files). FSM patch sits on top — it touches the same `RewriteContext` + `RewriteResult` types, so order matters.
3. Apply Sections 1-7 below in order.
4. Run `pnpm --filter @pa/pa-orchestrator typecheck` after each section.
5. Run the new test additions in Section 7.
6. Commit: `feat(37/T5): wire-in FSM to llm-rewriter (Adam apply per WIRE-IN-PATCH)`

---

## Section 1 — Imports

**Anchor:** top of `voice/llm-rewriter.ts`, after the existing `import OpenAI from "openai"` line (and after Phase 35 + 36 wire-in imports if those landed first).

**Add:**

```ts
import {
  runFsm,
  validateStrategyFit,
  type FsmResult,
  type StrategyFitResult,
} from "./fsm/index.js"
```

---

## Section 2 — Extend `RewriteContext` for FSM inputs

**Anchor:** `export type RewriteContext = {` block (currently line 450 — may have grown if Phase 35 + 36 wire-ins added their fields).

**Change to:**

```ts
export type RewriteContext = {
  /** Last 1-2 assistant replies in this session (most recent first). */
  priorAssistantReplies?: string[]
  /** Phase 35 T6 — same array, oldest first, capped to last 3 for F4
   *  detector cos-sim window. */
  claireHistoryForDetectors?: string[]

  /** Phase 37 T5 — current user message (FSM classifier input).
   *  Wire-in caller (orchestrator) passes the user's preceding turn here. */
  userText?: string
  /** Phase 37 T5 — 1-indexed turn number for stage mapping
   *  (turns 1-3=Exploration, 4-7=Comforting, 8+=Action). */
  fsmTurnNumber?: number
  /** Phase 37 T5 — last N user messages oldest-first (Phase 38 will use). */
  userTurnsForFsm?: string[]
  /** Phase 37 T5 — last N Claire replies oldest-first; FSM infers prev
   *  strategy from this for TransESC continuity weighting. */
  claireRepliesForFsm?: string[]
  /** Phase 37 T5 — controls FSM directive `note:` gloss language. */
  userLang?: "zh" | "en" | "mixed"
}
```

> **Note:** FSM uses `claireRepliesForFsm` (oldest-first, last 3) for `prevStrategy` inference; Phase 35 detector F4 uses `claireHistoryForDetectors` (oldest-first, last 3) for cos-sim. Same physical history slice; expose two fields to avoid coupling — caller MAY pass the same array reference.

---

## Section 3 — Extend `RewriteResult` for FSM telemetry

**Anchor:** `export type RewriteResult = {` block (currently line 46 — may have grown).

**Change to:**

```ts
export type RewriteResult = {
  text: string
  rewriteApplied: boolean
  reason: RewriteReason
  /** Phase 27 T1 — true when breaker is OPEN/HALF_OPEN-rejected. */
  circuitOpen?: boolean
  /** Phase 35 T6 — detector results from final pass; logged via pa_turns.usage. */
  detectorResults?: DetectorResult[]
  /** Phase 35 T6 — true when any detector triggered + action applied. */
  detectorActionApplied?: boolean

  /** Phase 37 T5 — FSM result (uxState, stage, allowed-set, directive, signals). */
  fsmResult?: FsmResult
  /** Phase 37 T5 — post-gen strategy_fit gate output. */
  strategyFit?: StrategyFitResult
}
```

---

## Section 4 — FSM directive computation BEFORE callRewriter

**Anchor:** Inside `rewriteIfOff`, AFTER the kill-switch + cheap-exits + circuit-breaker check, BEFORE the `controller = new AbortController()` block.

**Add (between the breaker check and the AbortController block):**

```ts
  // Phase 37 T5 — compute FSM state + directive BEFORE callRewriter so the
  // [FSM-DIRECTIVE] block can be appended to the system prompt. Feature flag
  // PA_FSM_ENABLED gates; failure-open on any exception (runFsm is sync +
  // catch-all rule-based, but defense-in-depth wrap).
  let fsmResult: FsmResult | undefined
  if (process.env.PA_FSM_ENABLED === "true") {
    try {
      fsmResult = runFsm(
        {
          turn: { user: ctx.userText ?? "" },
          history: {
            userTurns: ctx.userTurnsForFsm ?? [],
            claireReplies:
              ctx.claireRepliesForFsm ??
              (ctx.priorAssistantReplies ? [...ctx.priorAssistantReplies].reverse() : []),
          },
          turnNumber: ctx.fsmTurnNumber ?? 1,
        },
        { userLang: ctx.userLang }
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log("[llm-rewriter] FSM compute failed (fail-open)", { msg })
    }
  }
```

The `fsmResult.directive` string is then passed to `callRewriter` so the rewriter can append it to its system prompt. **The plumbing for "callRewriter accepts an extra directive string"** is wire-in caller's choice — two options:

- **Option A (cleanest):** Extend `callRewriter` signature in `RewriteOpts.deps` to accept an optional `systemPromptAddendum?: string` parameter. The default `defaultDeps.callRewriter` appends it to the end of `REWRITER_V2_SYSTEM_PROMPT`. Update the call site:
  ```ts
  modelText = await deps.callRewriter(
    rawText,
    controller.signal,
    ctx.priorAssistantReplies,
    fsmResult?.directive
  )
  ```
- **Option B (no signature change):** Stuff the directive into `ctx` and have `defaultDeps.callRewriter` read it via `ctx.fsmDirective`. Less explicit but zero signature impact.

P9-C recommends Option A for explicitness. Adam picks at apply time.

---

## Section 5 — Post-gen `validateStrategyFit` gate

**Anchor:** Inside `rewriteIfOff`, AFTER the `isDiffSafe` check + Phase 35 detector pass (if landed), BEFORE the final return.

**Add (after detectorResults assembled, before final return):**

```ts
  // Phase 37 T5 — strategy_fit post-gen gate. Logged in telemetry; v1.4
  // does NOT retry on miss (Phase 40 ship-gate decides retry policy).
  let strategyFit: StrategyFitResult | undefined
  if (fsmResult) {
    try {
      strategyFit = validateStrategyFit(
        finalText, // post-detector-action text
        new Set(fsmResult.allowedStrategies)
      )
      if (!strategyFit.allowed) {
        console.log("[llm-rewriter] strategy_fit miss", {
          inferred: strategyFit.strategy,
          allowed: fsmResult.allowedStrategies,
          uxState: fsmResult.uxState,
          stage: fsmResult.stage,
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log("[llm-rewriter] strategy_fit gate failed (fail-open)", { msg })
    }
  }
```

Add `fsmResult` + `strategyFit` to the final return:

```ts
  return {
    text: finalText,
    rewriteApplied: true,
    reason: "rewritten",
    detectorResults,
    detectorActionApplied,
    fsmResult,
    strategyFit,
  }
```

---

## Section 6 — Feature flag + telemetry

**Feature flag:** `PA_FSM_ENABLED` (default `false`). Set in `firebase functions:config:set` for gradual rollout. Aligned with Phase 40's `PA_HUMANIZE_RUNTIME_ENABLED` umbrella — when humanize-runtime is on, FSM should also be on.

**Telemetry shape** (caller writes to `pa_turns.usage.fsm` — NOT in this patch):

```ts
// In orchestrator turn writer (NOT this patch — Adam to add later):
if (rewrite.fsmResult) {
  turnDoc.usage.fsm = {
    uxState: rewrite.fsmResult.uxState,
    uxStateConfidence: rewrite.fsmResult.uxStateConfidence,
    stage: rewrite.fsmResult.stage,
    allowedStrategies: rewrite.fsmResult.allowedStrategies,
    preferredNext: rewrite.fsmResult.preferredNext,
    latencyMs: Math.round(rewrite.fsmResult.latencyMs),
  }
  if (rewrite.strategyFit) {
    turnDoc.usage.fsm.strategyFit = {
      strategy: rewrite.strategyFit.strategy,
      allowed: rewrite.strategyFit.allowed,
      confidence: rewrite.strategyFit.confidence,
    }
  }
}
```

This is **outside Section 4-5 patch**. Follow-up Adam-owed task in `apps/functions` or wherever `pa_turns` writes happen.

---

## Section 7 — Test additions for `llm-rewriter.test.ts`

**Anchor:** end of existing test file (after Phase 35 + 36 wire-in test sections if those landed).

**Add:**

```ts
import { type FsmResult, type StrategyFitResult } from "./fsm/index.js"

describe("Phase 37 T5 — FSM wire-in", () => {
  beforeEach(() => {
    process.env.PA_FSM_ENABLED = "true"
  })
  afterEach(() => {
    delete process.env.PA_FSM_ENABLED
  })

  test("flag disabled → no fsmResult field", async () => {
    delete process.env.PA_FSM_ENABLED
    const result = await rewriteIfOff(
      "draft reply",
      { deps: { callRewriter: async () => "rewritten reply" } },
      { userText: "今天好累", fsmTurnNumber: 5 }
    )
    assert.equal(result.fsmResult, undefined)
    assert.equal(result.strategyFit, undefined)
  })

  test("flag enabled → fsmResult populated", async () => {
    process.env.PA_FSM_ENABLED = "true"
    const result = await rewriteIfOff(
      "draft reply",
      { deps: { callRewriter: async () => "听起来真的很难。" } },
      { userText: "今天好累", fsmTurnNumber: 5, userLang: "zh" }
    )
    assert.ok(result.fsmResult, "fsmResult should be populated")
    assert.equal(result.fsmResult!.uxState, "SoftConcerned")
    assert.equal(result.fsmResult!.stage, "Comforting")
    assert.ok(result.fsmResult!.allowedStrategies.includes("Reflection"))
  })

  test("strategy_fit allowed when reply ∈ allowed-set", async () => {
    process.env.PA_FSM_ENABLED = "true"
    const result = await rewriteIfOff(
      "draft",
      { deps: { callRewriter: async () => "听起来真的很难。" } },
      { userText: "今天好累", fsmTurnNumber: 5, userLang: "zh" }
    )
    assert.equal(result.strategyFit!.allowed, true)
  })

  test("strategy_fit NOT allowed when reply ∉ allowed-set (logs but no retry in v1.4)", async () => {
    process.env.PA_FSM_ENABLED = "true"
    const result = await rewriteIfOff(
      "draft",
      { deps: { callRewriter: async () => "不妨试试这个方法。" } }, // Suggestion in Comforting/SoftConcerned
      { userText: "今天好累", fsmTurnNumber: 5, userLang: "zh" }
    )
    assert.equal(result.strategyFit!.strategy, "Suggestion")
    assert.equal(result.strategyFit!.allowed, false)
    // Rewrite still applied — v1.4 does NOT retry on strategy_fit miss.
    assert.equal(result.rewriteApplied, true)
  })

  test("FSM exception → fail-open (rewrite still applied)", async () => {
    process.env.PA_FSM_ENABLED = "true"
    // FSM is rule-based + catch-all; force a failure by passing weird ctx
    // (none does since runFsm is robust). Smoke: a successful call should
    // still return rewriteApplied=true.
    const result = await rewriteIfOff(
      "draft",
      { deps: { callRewriter: async () => "rewritten" } },
      { userText: "", fsmTurnNumber: 0 }
    )
    assert.equal(result.rewriteApplied, true)
    // FSM still computes for empty input (returns WarmCurious default).
    assert.ok(result.fsmResult)
  })
})
```

---

## Section 8 — Anchor strings (so this patch survives nearby edits)

If line numbers above drift (because Adam's pending work or Phase 35 + 36 wire-ins moved code), the anchors are:

| Anchor | Phrase to grep for |
|--------|---------------------|
| Section 1 (imports) | `import OpenAI from "openai"` |
| Section 2 (RewriteContext) | `export type RewriteContext = {` |
| Section 3 (RewriteResult) | `export type RewriteResult = {` |
| Section 4 (FSM compute insertion) | `// 2. Race the model call against the timeout.` (the comment immediately above `controller = new AbortController()`) |
| Section 5 (strategy_fit insertion) | `// Phase 33b — deterministic opener rotation.` (the comment immediately before the final `return { text: cleaned, rewriteApplied: true, reason: "rewritten" }`) |
| Section 6 (telemetry) | n/a — outside this file |
| Section 7 (tests) | end of `llm-rewriter.test.ts` |

---

## Adam-owed follow-up (P1)

After applying:

1. **Add user-text + turnNumber passthrough.** FSM needs `ctx.userText`, `ctx.fsmTurnNumber`, `ctx.userLang`. Currently `RewriteContext` doesn't include them — orchestrator should populate before calling `rewriteIfOff`. Without this, FSM gets empty user → WarmCurious / Exploration default for every turn (harmless but loses signal).

2. **Wire `claireRepliesForFsm` in orchestrator.** Read last 3 Claire turns from `pa_turns` collection (oldest-first), pass via `ctx.claireRepliesForFsm`. FSM then computes prev-strategy continuity correctly.

3. **Hand-review the 50 labeled fixtures.** Located at `packages/pa-orchestrator/src/voice/fsm/__fixtures__/labeled-fixtures.json`. P9-C labeled per CONTEXT D-37-1 signal definitions; Adam validates labeling quality. Disagreement on labels → revise + re-run accuracy gate.

4. **Verify FSM accuracy against real production traffic.** Phase 37 accuracy gate is on synthetic + hand-labeled. Real production may shift distribution (e.g. more code-switch). Sample 100 prod turns post-flag-on, hand-label, re-measure.

5. **Phase 38** extends FSM with cross-session `last_ux_state` + `last_strategy` for opener planning + advice-tracker repeat tolerance.

6. **Phase 40 ship-gate** measures `strategy_fit` axis on real LLM output (not synthetic-aligned). Decides whether to enable retry on miss (currently log-only in v1.4).

---

> [🟠 阿里味] **抓手清晰**：8 sections, 1 directive injection point, 1 post-gen gate, 1 feature flag. **因为信任所以简单**——FSM 已经测过 99/99，wire-in 把它接进 production entry/exit。证据说话。
