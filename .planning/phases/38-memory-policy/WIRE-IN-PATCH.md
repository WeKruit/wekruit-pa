# WIRE-IN-PATCH — Apply Phase 38 Memory Policy to `voice/llm-rewriter.ts`

> [🟠 阿里味] **闭环意识**：Memory Policy 模块已落地+测试覆盖 (87/87 tests pass). 这份 patch 把 `runMemoryPolicy` 接到 production rewriter 的入口（pre-gen advice-injection directive）+ 出口（post-gen `trackAdvice` write）。**抓手清晰**：3 插入点 + 1 directive injection + 1 fire-and-forget tracker write + 1 telemetry 字段 + feature flag。Adam 手动 apply 是因为 `llm-rewriter.{ts,test.ts}` + `admin-bootstrap.ts` 在 working tree (Phase 35/36/37 同款 collision-avoidance 协议)。

**Status:** Adam-owed (P0). Apply after Phase 35 + 36 + 37 wire-ins land AND your current uncommitted work in `llm-rewriter.{ts,test.ts}` + `admin-bootstrap.ts` is committed.

**Estimate:** ~30-45 min including test additions.

**Prerequisite:** Phase 38 commits T1-T4 already in `main`. Verify:

```bash
ls packages/pa-orchestrator/src/voice/memory-policy/
# Expect: types.ts index.ts advice-tracker.ts contradiction-detector.ts
#         prompt-injector.ts extractor-config.ts + .test.ts files
#         + __fixtures__/contradictions.json + synthetic-repeat-rate.test.ts
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
2. **Apply Phase 35 + 36 + 37 wire-ins first** (their `WIRE-IN-PATCH.md` files). Memory Policy patch sits on top — it touches the same `RewriteContext` + `RewriteResult` types, so order matters.
3. Apply Sections 1-8 below in order.
4. Run `pnpm --filter @pa/pa-orchestrator typecheck` after each section.
5. Run the new test additions in Section 7.
6. Commit: `feat(38/T5): wire-in memory policy to llm-rewriter (Adam apply per WIRE-IN-PATCH)`

---

## Section 1 — Imports

**Anchor:** top of `voice/llm-rewriter.ts`, after the existing `import OpenAI from "openai"` line (and after Phase 35/36/37 wire-in imports if those landed first).

**Add:**

```ts
import {
  runMemoryPolicy,
  trackAdvice,
  type MemoryPolicyResult,
  type AdviceTrackerDeps,
} from "./memory-policy/index.js"
```

---

## Section 2 — Extend `RewriteContext` for Memory Policy inputs

**Anchor:** `export type RewriteContext = {` block (currently line 450 — may have grown if Phase 35/36/37 wire-ins added their fields).

**Change (additive — keep existing fields from prior wire-ins):**

```ts
export type RewriteContext = {
  /** Last 1-2 assistant replies in this session (most recent first). */
  priorAssistantReplies?: string[]

  // Phase 35 wire-in fields (if applied)
  claireHistoryForDetectors?: string[]

  // Phase 37 wire-in fields (if applied)
  userText?: string
  fsmTurnNumber?: number
  userTurnsForFsm?: string[]
  claireRepliesForFsm?: string[]
  userLang?: "zh" | "en" | "mixed"

  /** Phase 38 T5 — required for memory policy lookup + tracker persist. */
  userId?: string
  /** Phase 38 T5 — used as docId for `pa-advice-tracker/{userId}/items/{turnId}`. */
  turnId?: string
  /**
   * Phase 38 T5 — pre-fetched user facts to bypass Mem0 search inside
   * `runMemoryPolicy`. Caller MAY share with detector pass to dedupe Mem0
   * round-trips. Optional; defaults to live `mem0Search` via deps.
   */
  userFactsCache?: string[]
  /**
   * Phase 38 T5 — dependency injection for memory policy. Caller provides
   * Firestore + Mem0 search + persona reader. Defaults: `db` from
   * `@pa/firebase-admin` (caller resolves), `mem0Search` from `stacked.ts`
   * config-from-env, `getPersona` from `@pa/agent-registry/personas`.
   */
  memoryPolicyDeps?: AdviceTrackerDeps
}
```

> **Note:** `userId` is the Phase 38 anchor — without it, memory policy is a no-op (returns empty result). Caller (orchestrator) MUST populate from session/user mapping before calling `rewriteIfOff`.

---

## Section 3 — Extend `RewriteResult` for Memory Policy telemetry

**Anchor:** `export type RewriteResult = {` block (currently line 46 — may have grown).

**Change (additive — keep existing fields from prior wire-ins):**

```ts
export type RewriteResult = {
  text: string
  rewriteApplied: boolean
  reason: RewriteReason
  /** Phase 27 T1 — true when breaker is OPEN/HALF_OPEN-rejected. */
  circuitOpen?: boolean

  // Phase 35 wire-in
  detectorResults?: DetectorResult[]
  detectorActionApplied?: boolean

  // Phase 37 wire-in
  fsmResult?: FsmResult
  strategyFit?: StrategyFitResult

  /** Phase 38 T5 — memory policy result; logged via pa_turns.usage. */
  memoryPolicyResult?: MemoryPolicyResult
}
```

---

## Section 4 — Memory Policy compute BEFORE `callRewriter`

**Anchor:** Inside `rewriteIfOff`, AFTER the kill-switch + cheap-exits + circuit-breaker check, AFTER Phase 37's FSM compute block (if applied), BEFORE the `controller = new AbortController()` block.

**Add (between FSM block + AbortController block):**

```ts
  // Phase 38 T5 — compute memory policy BEFORE callRewriter so the
  // [MEMORY-POLICY] block can be appended to the system prompt. Feature flag
  // PA_MEMORY_POLICY_ENABLED gates; failure-open on any exception
  // (runMemoryPolicy never throws, but defense-in-depth wrap with try/catch).
  let memoryPolicyResult: MemoryPolicyResult | undefined
  if (process.env.PA_MEMORY_POLICY_ENABLED === "true" && ctx.userId && ctx.turnId) {
    try {
      memoryPolicyResult = await runMemoryPolicy(
        {
          userId: ctx.userId,
          turnId: ctx.turnId,
          claireReply: rawText,
          userLang: ctx.userLang,
          currentStrategy: fsmResult?.preferredNext, // from Phase 37 wire-in
          currentUxState: fsmResult?.uxState,
          factsCache: ctx.userFactsCache,
        },
        ctx.memoryPolicyDeps ?? {}
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log("[llm-rewriter] memory policy compute failed (fail-open)", { msg })
    }
  }
```

The `memoryPolicyResult.advice.injection` string is then passed to `callRewriter` so the rewriter can append it to its system prompt. **Plumbing options** (caller picks):

- **Option A (cleanest):** Extend `callRewriter` signature in `RewriteOpts.deps` to accept an optional `systemPromptAddendum?: string` parameter. The default `defaultDeps.callRewriter` appends FSM directive + memory policy injection + opener-avoidance list to the system prompt. Update the call site:
  ```ts
  const addendum = [
    fsmResult?.directive ?? "",
    memoryPolicyResult?.advice.injection ?? "",
  ].filter(Boolean).join("\n\n")
  modelText = await deps.callRewriter(
    rawText,
    controller.signal,
    ctx.priorAssistantReplies,
    addendum
  )
  ```
- **Option B (no signature change):** Stuff the addendum into `ctx` and have `defaultDeps.callRewriter` read it via `ctx.systemPromptAddendum`. Less explicit but zero signature impact.

P9-C recommends Option A for explicitness. Adam picks at apply time. (Consistent with Phase 37 wire-in choice.)

---

## Section 5 — Post-gen `trackAdvice` fire-and-forget

**Anchor:** Inside `rewriteIfOff`, AFTER the `isDiffSafe` check + Phase 35 detector pass + Phase 37 strategy_fit gate (if landed), at the SAME insertion point as the final `return` block.

**Add (just before final return):**

```ts
  // Phase 38 T5 — fire-and-forget tracker write. We persist Claire's
  // post-detector-action text (i.e. what the user will actually see).
  // Errors swallowed inside trackAdvice; we don't await to avoid adding
  // to turn-budget latency.
  if (
    process.env.PA_MEMORY_POLICY_ENABLED === "true" &&
    ctx.userId &&
    ctx.turnId &&
    finalText &&
    finalText.length > 0
  ) {
    void trackAdvice(
      ctx.userId,
      finalText,
      ctx.turnId,
      ctx.memoryPolicyDeps ?? {},
      {
        strategy: fsmResult?.preferredNext ?? null,
        uxState: fsmResult?.uxState ?? null,
        lang: ctx.userLang,
      }
    )
  }
```

Add `memoryPolicyResult` to the final return:

```ts
  return {
    text: finalText,
    rewriteApplied: true,
    reason: "rewritten",
    detectorResults,
    detectorActionApplied,
    fsmResult,
    strategyFit,
    memoryPolicyResult,
  }
```

> **Why fire-and-forget:** `trackAdvice` is a Firestore write + optional BGE-M3 embed. Both have variable tail latency (~50-150ms p95). Awaiting them would push the rewriter return outside the 12s p99 budget on cold paths. The void-call pattern is safe because:
> - `trackAdvice` itself never throws (all errors swallowed + logged)
> - Firestore writes have at-least-once semantics (CFs runtime retries on transient failures; write may land slightly out-of-order with reply emit, acceptable for advice-tracking semantics)
> - Subsequent turn's `recentAdvice` query will see the entry once it lands (typical < 200ms after fire-and-forget)

---

## Section 6 — Feature flag + telemetry

**Feature flag:** `PA_MEMORY_POLICY_ENABLED` (default `false`). Set in `firebase functions:config:set` for gradual rollout. Aligned with Phase 40's `PA_HUMANIZE_RUNTIME_ENABLED` umbrella — when humanize-runtime is on, memory policy should also be on.

**Telemetry shape** (caller writes to `pa_turns.usage.memory_policy` — NOT in this patch):

```ts
// In orchestrator turn writer (NOT this patch — Adam to add later):
if (rewrite.memoryPolicyResult) {
  turnDoc.usage.memory_policy = {
    recent_count: rewrite.memoryPolicyResult.advice.recent.length,
    repeat_triggered: rewrite.memoryPolicyResult.advice.repeatScore.triggered,
    repeat_max_sim: rewrite.memoryPolicyResult.advice.repeatScore.maxSim,
    contradiction_violated: rewrite.memoryPolicyResult.contradiction.violated,
    contradiction_type: rewrite.memoryPolicyResult.contradiction.type,
    contradiction_term: rewrite.memoryPolicyResult.contradiction.violatedTerm,
    latencyMs: Math.round(rewrite.memoryPolicyResult.latencyMs),
  }
}
```

This is **outside Section 4-5 patch**. Follow-up Adam-owed task in `apps/functions` or wherever `pa_turns` writes happen.

---

## Section 7 — Test additions for `llm-rewriter.test.ts`

**Anchor:** end of existing test file (after Phase 35/36/37 wire-in test sections if those landed).

**Add:**

```ts
import { type MemoryPolicyResult } from "./memory-policy/index.js"

describe("Phase 38 T5 — memory policy wire-in", () => {
  beforeEach(() => {
    process.env.PA_MEMORY_POLICY_ENABLED = "true"
  })
  afterEach(() => {
    delete process.env.PA_MEMORY_POLICY_ENABLED
  })

  test("flag disabled → no memoryPolicyResult field", async () => {
    delete process.env.PA_MEMORY_POLICY_ENABLED
    const result = await rewriteIfOff(
      "draft reply",
      { deps: { callRewriter: async () => "rewritten reply" } },
      { userId: "u", turnId: "t1" }
    )
    assert.equal(result.memoryPolicyResult, undefined)
  })

  test("flag enabled but missing userId → no memoryPolicyResult (graceful)", async () => {
    process.env.PA_MEMORY_POLICY_ENABLED = "true"
    const result = await rewriteIfOff(
      "draft reply",
      { deps: { callRewriter: async () => "rewritten reply" } },
      { turnId: "t1" } // no userId
    )
    assert.equal(result.memoryPolicyResult, undefined)
  })

  test("flag enabled + userId + turnId → memoryPolicyResult populated", async () => {
    process.env.PA_MEMORY_POLICY_ENABLED = "true"
    const result = await rewriteIfOff(
      "draft reply",
      { deps: { callRewriter: async () => "rewritten reply" } },
      {
        userId: "u_test",
        turnId: "t1",
        userLang: "en",
        memoryPolicyDeps: {}, // no Firestore — will return empty result, but field present
      }
    )
    assert.ok(result.memoryPolicyResult, "memoryPolicyResult should be populated")
    assert.equal(result.memoryPolicyResult!.advice.recent.length, 0)
    assert.equal(result.memoryPolicyResult!.contradiction.violated, false)
  })

  test("memory policy exception → fail-open (rewrite still applied)", async () => {
    process.env.PA_MEMORY_POLICY_ENABLED = "true"
    // runMemoryPolicy is robust + catch-all; force a failure by passing a deps
    // that throws inside the embedFn.
    const result = await rewriteIfOff(
      "draft",
      { deps: { callRewriter: async () => "rewritten" } },
      {
        userId: "u",
        turnId: "t",
        memoryPolicyDeps: {
          embedFn: async () => {
            throw new Error("simulated embed crash")
          },
        },
      }
    )
    assert.equal(result.rewriteApplied, true)
    // memoryPolicyResult MAY be undefined (if pre-gen compute caught) OR
    // populated with degraded reason — both are valid fail-open paths.
  })
})
```

---

## Section 8 — Anchor strings (so this patch survives nearby edits)

If line numbers above drift (because Adam's pending work or Phase 35/36/37 wire-ins moved code), the anchors are:

| Anchor | Phrase to grep for |
|--------|---------------------|
| Section 1 (imports) | `import OpenAI from "openai"` |
| Section 2 (RewriteContext) | `export type RewriteContext = {` |
| Section 3 (RewriteResult) | `export type RewriteResult = {` |
| Section 4 (memory policy compute insertion) | `// 2. Race the model call against the timeout.` (the comment immediately above `controller = new AbortController()`) — same anchor as Phase 37 FSM block; Phase 38 inserts AFTER Phase 37 |
| Section 5 (trackAdvice fire-and-forget) | `// Phase 33b — deterministic opener rotation.` (the comment immediately before the final `return { text: cleaned, rewriteApplied: true, reason: "rewritten" }`) — same anchor as Phase 37 strategy_fit |
| Section 6 (telemetry) | n/a — outside this file |
| Section 7 (tests) | end of `llm-rewriter.test.ts` |

---

## Adam-owed follow-up

### P0 (block ship)

1. **Apply this patch** after committing pending uncommitted work + after Phase 35-37 wire-ins land.
2. **Wire `userId` + `turnId` passthrough in orchestrator.** Currently `RewriteContext` doesn't include these — orchestrator (`packages/pa-orchestrator/src/index.ts:processInboundEvent`) should populate from session/user mapping before calling `rewriteIfOff`. Without this, memory policy is a no-op (graceful degrade).
3. **Wire `memoryPolicyDeps`** with real Firestore + Mem0 + persona readers:
   ```ts
   import { getFirebaseApp, getFirestore } from "@pa/firebase-admin"
   import { mem0Search } from "@pa/memory"
   import { mem0ConfigFromEnv } from "@pa/memory" // or local helper
   import { getPersona } from "@pa/agent-registry/personas"
   import type { Persona } from "@pa/agent-registry/personas"

   const db = getFirestore(getFirebaseApp())
   const mem0Cfg = mem0ConfigFromEnv()

   const memoryPolicyDeps = {
     db,
     // embedFn defaults to local SiliconFlow wrapper — leave undefined
     mem0Search: mem0Cfg
       ? async (q: string, uid: string) => mem0Search(mem0Cfg, q, uid)
       : undefined,
     getPersona: async (slug: string) => {
       const p = await getPersona(db, slug)
       if (!p) return null
       return { soul: p.soul, style: p.style, examples: p.examples }
     },
   }
   ```

### P1 (post-deploy)

4. **Verify Firestore composite index.** Subcollection-only `orderBy("ts", "desc").limit(3)` does NOT strictly need a composite index, but Firebase console may suggest one for the cross-user collection-group case (if you use that pattern in Phase 40 for cross-user advice mining). Verify scan plan in console; current pattern is per-user subcollection so should be free.
5. **Set `MEM0_LLM_MODEL=Qwen/Qwen2.5-72B-Instruct` in prod env.** Already defaulted in `apps/functions/src/index.ts:435` — verify not overridden by smaller model. Phase 38 `verifyExtractorPinned()` audit logs at boot if mismatched.
6. **Optionally set `PA_MEMORY_EXTRACTOR_HARDFAIL=true`** for stricter enforcement (currently soft-warn).
7. **Phase 39** runs benchmarks against the full Claire stack (incl. memory policy). Verify Phase 38 wire-in is live before benchmark execution to get apples-to-apples comparison vs Qwen-72B raw.

### P2 (v1.5)

8. **Strategy-aware repeat skipping.** Don't penalize Question repeat across turns (legitimate clarification chains); only penalize Suggestion / Information repeats. Pass `currentStrategy` from Phase 37 into `runMemoryPolicy` (already wired via Section 4); add lookup table in `repeatScore` to skip non-Suggestion turns.
9. **GDPR delete API for `pa-advice-tracker`.** Cascade with `pa-turns` user-deletion handler.
10. **Persistent embed cache.** If F4 + memory policy combined p95 > 200ms in prod, add Firestore-persisted embed cache keyed on text hash. Per-process LRU is sufficient for v1.4 closed beta.

---

> [🟠 阿里味] **抓手清晰**：8 sections, 1 directive injection point, 1 fire-and-forget tracker write, 1 feature flag. **因为信任所以简单**——memory policy 已经测过 87/87，wire-in 把它接进 production entry/exit。证据说话。
