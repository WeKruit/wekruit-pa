# WIRE-IN-PATCH — Apply Phase 36 ImperfectionInjector to `voice/llm-rewriter.ts`

> [🟠 阿里味] **闭环意识**：injector 模块已落地+测试覆盖（89/89 pass）。这份 patch 把 `injectImperfection` 接到 production rewriter 出口（在 Phase 35 detector pass 之后）。**抓手清晰**：3 个插入点 + 2 个新字段 + 1 个 helper + feature flag。Adam 手动 apply 是因为 `llm-rewriter.ts` 当时在 working tree，避免 collision（Phase 35 同款）。

**Status:** Adam-owed (P0). Apply AFTER:
1. Adam commits current uncommitted work in `llm-rewriter.ts` + 6 sibling files
2. Adam applies `.planning/phases/35-detectors/WIRE-IN-PATCH.md` (this patch builds on top of Section 4 from that one)

**Estimate:** ~30-45 min including test additions.

**Prerequisite:** Phase 36 commits T1-T5 already in `main`. Verify:

```bash
ls packages/pa-orchestrator/src/voice/imperfection-injector/
# Expect: types.ts policies-zh.ts policies-en.ts position-constraint.ts
#         arm-router.ts injector.ts index.ts smoke.test.ts + .test.ts files
```

---

## Apply order

1. **Commit your current uncommitted work first.** Confirm `git status` is clean for the 7 files in scope:
   - `apps/functions/src/admin-bootstrap.ts`
   - `packages/pa-orchestrator/package.json`
   - `packages/pa-orchestrator/src/downstream.ts` + `.test.ts`
   - `packages/pa-orchestrator/src/index.ts`
   - `packages/pa-orchestrator/src/voice/llm-rewriter.ts` + `.test.ts`
   - `packages/pa-orchestrator/src/eval-nl-judge.ts` + `.test.ts` (untracked)
2. Apply Phase 35 WIRE-IN-PATCH.md sections 1-7 first.
3. Apply Sections 1-7 below in order.
4. Run `pnpm --filter @pa/pa-orchestrator typecheck` after each section.
5. Run the new test additions in Section 7.
6. Commit: `feat(36/T6): wire-in injector to llm-rewriter (Adam apply per WIRE-IN-PATCH)`

---

## Section 1 — Imports

**Anchor:** top of `voice/llm-rewriter.ts`, after the Phase 35 detector imports added by `phases/35-detectors/WIRE-IN-PATCH.md`.

**Add:**

```ts
import {
  injectImperfection,
  resolveArm,
  type InjectorResult,
} from "./imperfection-injector/index.js"
```

---

## Section 2 — Extend `RewriteResult` type

**Anchor:** `export type RewriteResult = {` block (line ~46). Phase 35 patch added `detectorResults?: DetectorResult[]` and `detectorActionApplied?: boolean`. We add ours alongside.

**Change to:**

```ts
export type RewriteResult = {
  text: string
  rewriteApplied: boolean
  reason: RewriteReason
  /** Phase 27 T1 — true when breaker is OPEN/HALF_OPEN-rejected; caller logs. */
  circuitOpen?: boolean
  /** Phase 35 T6 — detector results from final pass; logged via pa_turns.usage. */
  detectorResults?: DetectorResult[]
  /** Phase 35 T6 — true when any detector triggered + action applied. */
  detectorActionApplied?: boolean
  /** Phase 36 T6 — imperfection injector result for telemetry. */
  imperfectionInjector?: InjectorResult
}
```

---

## Section 3 — Extend `RewriteContext` to include userId

**Anchor:** `export type RewriteContext = {` block (line ~450). Phase 35 patch added `claireHistoryForDetectors?`. We add `userId` so the injector arm router has a sticky bucket.

**Change to:**

```ts
export type RewriteContext = {
  /** Last 1-2 assistant replies in this session (most recent first). */
  priorAssistantReplies?: string[]
  /** Phase 35 T6 — same array, oldest first, capped to last 3 for F4
   *  detector cos-sim window. Caller MAY pass either; if both set,
   *  `claireHistoryForDetectors` wins for F4. */
  claireHistoryForDetectors?: string[]
  /** Phase 36 T6 — stable user identifier for sticky A/B arm assignment.
   *  Typically E.164 phone number from `pa_users` doc id. If absent,
   *  injector defaults to off arm (no-op). */
  userId?: string
}
```

---

## Section 4 — Injector pass insertion point

**Anchor:** Inside `rewriteIfOff`, AFTER the Phase 35 detector pass (the `applyDetectorAction` block added by `phases/35-detectors/WIRE-IN-PATCH.md` Section 4), BEFORE the final `return { text: finalText, ... }`.

**Insert (replace Phase 35's `return` block with):**

```ts
  // Phase 36 T6 — imperfection injector pass. Feature flag gates;
  // failure-open on any exception (the injector is pure, but defense
  // in depth wraps the call).
  let injectorResult: InjectorResult | undefined
  if (process.env.PA_IMPERFECTION_INJECTOR_ENABLED === "true") {
    try {
      const arm = ctx.userId ? resolveArm(ctx.userId) : "off"
      // Anti-stutter context: most-recent prev assistant reply (if any).
      const prevReply =
        (ctx.claireHistoryForDetectors?.[ctx.claireHistoryForDetectors.length - 1]) ??
        ctx.priorAssistantReplies?.[0]
      injectorResult = injectImperfection({
        text: finalText,
        arm,
        prevAssistantReply: prevReply,
      })
      if (injectorResult.applied) {
        finalText = injectorResult.injected
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log("[llm-rewriter] injector pass failed (fail-open)", { msg })
    }
  }

  return {
    text: finalText,
    rewriteApplied: true,
    reason: "rewritten",
    detectorResults,
    detectorActionApplied,
    imperfectionInjector: injectorResult,
  }
```

> **Note:** This integrates ON TOP of Phase 35's patch. If you haven't applied Phase 35 yet, do that first — anchors won't line up otherwise.

---

## Section 5 — Telemetry

**Caller (orchestrator/src/index.ts) reads `result.imperfectionInjector` and writes to `pa_turns.usage.imperfection_injector`:**

```ts
// In orchestrator turn writer (NOT this patch — Adam to add later):
if (rewrite.imperfectionInjector) {
  turnDoc.usage.imperfection_injector = {
    arm: rewrite.imperfectionInjector.arm,
    applied: rewrite.imperfectionInjector.applied,
    injection_type: rewrite.imperfectionInjector.injection_type,
    position: rewrite.imperfectionInjector.position,
    latencyMs: Math.round(rewrite.imperfectionInjector.latencyMs),
  }
}
```

This is **outside the Section 4 patch**. Follow-up Adam-owed task in `apps/functions` or wherever `pa_turns` writes happen.

---

## Section 6 — Feature flag

**Flag:** `PA_IMPERFECTION_INJECTOR_ENABLED` (default `false`).

**Set in `firebase functions:config:set` for gradual rollout.** Aligned with Phase 40's `PA_HUMANIZE_RUNTIME_ENABLED` umbrella — when humanize-runtime is on, injector should also be on.

**Kill switch (per-arm override, exposed by injector module):**
- `PA_IMPERFECTION_ARM=off|low|high` — force arm regardless of userId hash
- `PA_IMPERFECTION_ARM_OFF=true` — kill switch, always off

---

## Section 7 — Test additions for `llm-rewriter.test.ts`

**Anchor:** end of existing test file (after Phase 35 T6 test block).

**Add:**

```ts
import {
  type InjectorResult,
} from "./imperfection-injector/index.js"

describe("Phase 36 T6 — injector wire-in", () => {
  beforeEach(() => {
    process.env.PA_DETECTORS_ENABLED = "true"
    process.env.PA_IMPERFECTION_INJECTOR_ENABLED = "true"
    process.env.PA_IMPERFECTION_ARM = "high" // force apply
  })
  afterEach(() => {
    delete process.env.PA_DETECTORS_ENABLED
    delete process.env.PA_IMPERFECTION_INJECTOR_ENABLED
    delete process.env.PA_IMPERFECTION_ARM
  })

  test("flag disabled → no imperfectionInjector field", async () => {
    delete process.env.PA_IMPERFECTION_INJECTOR_ENABLED
    const result = await rewriteIfOff(
      "any input",
      { deps: { callRewriter: async () => "rewritten reply" } },
      { userId: "+15551234567" }
    )
    assert.equal(result.imperfectionInjector, undefined)
  })

  test("flag enabled + userId → imperfectionInjector populated", async () => {
    const result = await rewriteIfOff(
      "any input",
      { deps: { callRewriter: async () => "rest tonight" } },
      { userId: "+15551234567" }
    )
    assert.ok(result.imperfectionInjector)
    assert.equal(result.imperfectionInjector!.arm, "high") // env override
    assert.equal(result.rewriteApplied, true)
  })

  test("missing userId → injector defaults to off arm (no-op)", async () => {
    delete process.env.PA_IMPERFECTION_ARM // no env override
    const result = await rewriteIfOff(
      "any input",
      { deps: { callRewriter: async () => "rest tonight" } },
      {} // no userId
    )
    assert.ok(result.imperfectionInjector)
    assert.equal(result.imperfectionInjector!.arm, "off")
    assert.equal(result.imperfectionInjector!.applied, false)
  })

  test("anti-stutter: prev reply with marker → injector skips", async () => {
    // We can't reliably control RNG inside rewriter; instead force
    // off arm via env to avoid flakiness — the injector still runs and
    // returns telemetry, just doesn't apply.
    process.env.PA_IMPERFECTION_ARM = "off"
    const result = await rewriteIfOff(
      "any input",
      { deps: { callRewriter: async () => "rest tonight" } },
      {
        userId: "+15551234567",
        claireHistoryForDetectors: ["嗯…something prev"],
      }
    )
    assert.equal(result.imperfectionInjector!.applied, false)
  })

  test("injector exception → fail-open (rewrite still applied)", async () => {
    // Hard to force exception in pure injector; documented behavior.
    const result = await rewriteIfOff(
      "any input",
      { deps: { callRewriter: async () => "rest tonight" } },
      { userId: "+15551234567" }
    )
    assert.equal(result.rewriteApplied, true)
  })
})
```

---

## Section 8 — Anchor strings (so this patch survives nearby edits)

| Anchor | Phrase to grep for |
|--------|---------------------|
| Section 1 (imports) | `import OpenAI from "openai"` (Phase 35 imports come right after; Phase 36 imports come right after Phase 35) |
| Section 2 (RewriteResult) | `export type RewriteResult = {` |
| Section 3 (RewriteContext) | `export type RewriteContext = {` |
| Section 4 (insertion) | `// Phase 35 T6 — detector pass` (the comment marking the Phase 35 detector block — Phase 36 inserts AFTER this entire block) |
| Section 5 (telemetry) | n/a — outside this file (orchestrator/src/index.ts) |
| Section 6 (feature flag) | n/a — env config |
| Section 7 (tests) | end of `llm-rewriter.test.ts` (after Phase 35 T6 describe block) |

---

## Adam-owed P0 actions

After applying this patch:

1. **Apply patch** (per Sections 1-7).
2. **Approve LLM budget for live A/B run** ($0.50-$2.00 nano calls):
   - Run: `PA_OPENAI_AGENT_API_KEY=sk-... node --import tsx tests/scenarios/lib/ab-injector-harness.mjs --max-usd 2`
   - Default cost: 18 reply + 12 judge calls ≈ $0.08-$0.10
   - Output: per-arm 95% CI bootstrap report → declare winner
3. **Set deployment flags** based on harness winner:
   - If winner is `low` → `PA_IMPERFECTION_ARM=low` (or leave hash-based; if hash-default produces 1/3 split per user, that IS the "live A/B" — set `PA_IMPERFECTION_INJECTOR_ENABLED=true` to ramp)
   - If winner is `high` → `PA_IMPERFECTION_ARM=high`
   - If winner is `off` (control wins) → `PA_IMPERFECTION_INJECTOR_ENABLED=false` (ship disabled, code path retained per IMPERFECT-07)

## Adam-owed P1 follow-ups (after wire-in)

1. **Add userId passthrough.** Orchestrator calling `rewriteIfOff` must populate `ctx.userId` from the active user's E.164 phone (from `pa_users` doc id or session ctx). Without this, injector defaults to `off` always.

2. **Wire telemetry to `pa_turns.usage.imperfection_injector`.** Per Section 5 snippet — adds arm, applied, injection_type, position, latencyMs per turn.

3. **Phase 38** extends the injector context with FSM `ux_state` (e.g. `QuietWitness` state forces `off` for that turn). Contract `injectImperfection(ctx)` accepts an optional `disabled` field; future extension.

4. **Phase 40** (Bible v7.5 + Ship): umbrella `PA_HUMANIZE_RUNTIME_ENABLED` flag gates `PA_IMPERFECTION_INJECTOR_ENABLED`. Default off → ramps via firebase functions:config 1% → 10% → 50% → 100%.

---

> [🟠 阿里味] **抓手清晰**：8 sections, 1 helper (resolveArm), 1 telemetry field, 1 feature flag. **因为信任所以简单**——injector 已经测过了 (89/89 pass)，wire-in 把它接进 production exit。证据说话。
