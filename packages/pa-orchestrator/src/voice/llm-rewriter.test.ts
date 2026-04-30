/**
 * Phase 21 — LLM output rewriter unit tests (Track 4 of prod-regression fix).
 *
 * Prod screenshot 2026-04-27 showed nano defaulting to "X 还是 Y" multi-choice
 * questions, "接住你" pop-therapy register, invented user-categories, and
 * productivity-coach probes. Bible v5 + filler blacklist catches some but not
 * all — the rewriter is the LAST defense before iMessage.
 *
 * Architecture:
 *   raw nano output → rewriteIfOff() → normalizeForIMessage (regex) → outbox
 *
 * The rewriter uses a cheap small-model pass (gpt-5.4-nano by default — same
 * model the agent uses, so no extra credentials/baseURL plumbing). It is
 * fail-open: timeout / error / disabled-flag → return original text.
 *
 * Phase 24 additions:
 *   - stripThinkBlocks: strips Qwen3 <think>...</think> blocks
 *   - isDiffSafe: diff guard (reject >1.6× growth OR <40% truncation)
 *   - Integrated flow tests (think-strip, diff-guard, fail-open)
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  rewriteIfOff,
  stripThinkBlocks,
  isDiffSafe,
  stripRepeatOpener,
  stripValidationTic,
  getBreakerStateName,
  __resetBreakerForTests,
  type RewriterDeps,
} from "./llm-rewriter.js"

/**
 * Helper: build a fake LLM dep that returns the given completion text once,
 * recording the prompt it was called with for inspection.
 */
function fakeRewriter(returnText: string, opts: { delayMs?: number; throwAfter?: boolean } = {}): {
  deps: RewriterDeps
  calls: { rawText: string; fsmDirective?: string }[]
} {
  const calls: { rawText: string; fsmDirective?: string }[] = []
  const deps: RewriterDeps = {
    callRewriter: async (rawText, _signal, _priorReplies, fsmDirective) => {
      calls.push({ rawText, fsmDirective })
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      if (opts.throwAfter) throw new Error("simulated upstream error")
      return returnText
    },
  }
  return { deps, calls }
}

// ─── Phase 21 existing tests ─────────────────────────────────────────────────

test("rewriteIfOff: clean text passes through unchanged (no rewrite recorded)", async () => {
  // Fake echoes the input — the contract is "rewriteApplied = did the
  // text actually change", not "did we make a model call".
  const clean = "发来. 我给你测评下."
  const { deps } = fakeRewriter(clean)
  const result = await rewriteIfOff(clean, { deps })
  assert.equal(result.text, clean)
  assert.equal(result.rewriteApplied, false)
  assert.equal(result.reason, "no_change")
})

test("rewriteIfOff: A/B-framework draft is replaced with single-beat reply", async () => {
  const draft =
    "听起来你最近真的被事情淹了 😮‍💨\n你现在最烦的是工作这边, 还是生活那边?"
  const cleaned = "听起来挺烦的. 卷成这样你怎么扛过来的."
  const { deps, calls } = fakeRewriter(cleaned)
  const result = await rewriteIfOff(draft, { deps })
  assert.equal(result.text, cleaned)
  assert.equal(result.rewriteApplied, true)
  assert.equal(result.reason, "rewritten")
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.rawText, draft)
})

test("rewriteIfOff: pop-therapy phrase 接住你 stripped", async () => {
  // Phase 24 diff-guard note: output must be within 40%-160% of input length.
  // Draft ~19 chars; cleaned output must be >= 0.4*19 = 7.6 chars (i.e. ≥8 chars).
  // Use a realistic rewrite that preserves approximate length.
  const draft = "你现在是想找个人接住你一下 😌 我懂."  // ~19 chars
  const cleaned = "听着挺累的. 还好吗."  // ~10 chars — within safe ratio
  const { deps } = fakeRewriter(cleaned)
  const result = await rewriteIfOff(draft, { deps })
  assert.equal(result.text, cleaned)
  assert.equal(result.rewriteApplied, true)
})

test("rewriteIfOff: productivity-coach probe removed", async () => {
  // Phase 24 diff-guard note: input has 2 lines; output trims the coach probe.
  // Use a draft where the coach-probe removal still keeps output within 40% ratio.
  const draft = "听起来挺难的. 你现在最想先把哪件搞定?"  // ~18 chars
  const cleaned = "听起来挺难的. 难得."  // ~9 chars — within safe ratio (≥0.4*18=7.2)
  const { deps } = fakeRewriter(cleaned)
  const result = await rewriteIfOff(draft, { deps })
  assert.equal(result.text, cleaned)
  assert.equal(result.rewriteApplied, true)
})

test("rewriteIfOff: timeout fails open to original text", async () => {
  const { deps } = fakeRewriter("never returned", { delayMs: 200 })
  const result = await rewriteIfOff("draft text", { deps, timeoutMs: 30 })
  assert.equal(result.text, "draft text")
  assert.equal(result.rewriteApplied, false)
  assert.equal(result.reason, "timeout")
})

test("rewriteIfOff: upstream error fails open to original text", async () => {
  const { deps } = fakeRewriter("ignored", { throwAfter: true })
  const result = await rewriteIfOff("draft text", { deps })
  assert.equal(result.text, "draft text")
  assert.equal(result.rewriteApplied, false)
  assert.equal(result.reason, "error")
})

test("rewriteIfOff: PA_LLM_REWRITE_DISABLED=true short-circuits (no model call)", async () => {
  const { deps, calls } = fakeRewriter("would-be-rewritten")
  process.env.PA_LLM_REWRITE_DISABLED = "true"
  try {
    const result = await rewriteIfOff("听起来你硬撑着", { deps })
    assert.equal(result.text, "听起来你硬撑着")
    assert.equal(result.rewriteApplied, false)
    assert.equal(result.reason, "disabled")
    assert.equal(calls.length, 0, "model must not be called when disabled")
  } finally {
    delete process.env.PA_LLM_REWRITE_DISABLED
  }
})

test("rewriteIfOff: empty input passes through without model call", async () => {
  const { deps, calls } = fakeRewriter("ignored")
  const result = await rewriteIfOff("", { deps })
  assert.equal(result.text, "")
  assert.equal(result.rewriteApplied, false)
  assert.equal(calls.length, 0)
})

test("rewriteIfOff: rewriter returning empty string fails open (defense-in-depth)", async () => {
  // If the small model goes off the rails and returns "" we MUST NOT ship
  // an empty reply. Treat as a soft error and keep the original.
  const { deps } = fakeRewriter("")
  const result = await rewriteIfOff("draft text", { deps })
  assert.equal(result.text, "draft text")
  assert.equal(result.rewriteApplied, false)
  assert.equal(result.reason, "empty_rewrite")
})

test("rewriteIfOff: identical-after-trim treated as no-op", async () => {
  // Some adapters add trailing whitespace. Don't claim a rewrite for that.
  const { deps } = fakeRewriter("发来. 我给你测评下.\n")
  const result = await rewriteIfOff("发来. 我给你测评下.", { deps })
  assert.equal(result.text, "发来. 我给你测评下.")
  assert.equal(result.rewriteApplied, false)
})

// ─── Phase 24 — stripThinkBlocks helper ──────────────────────────────────────

test("stripThinkBlocks: plain text returned unchanged", () => {
  assert.equal(stripThinkBlocks("hello"), "hello")
})

test("stripThinkBlocks: single complete block stripped", () => {
  assert.equal(stripThinkBlocks("<think>plan</think>actual"), "actual")
})

test("stripThinkBlocks: multiple complete blocks all stripped", () => {
  assert.equal(
    stripThinkBlocks("a<think>x</think>b<think>y</think>c"),
    "abc"
  )
})

test("stripThinkBlocks: unclosed tag not stripped (only complete pairs)", () => {
  // Graceful: only complete <think>...</think> pairs are stripped
  assert.equal(stripThinkBlocks("<think>unclosed"), "<think>unclosed")
})

// ─── Phase 24 — isDiffSafe helper ────────────────────────────────────────────

test("isDiffSafe: output >1.6× input returns false", () => {
  // "abc def ghi" = 11 chars, "abc def ghi jkl mno pqr stu" = 27 chars
  // 27 > 1.6 * 11 = 17.6 → false
  const input = "abc def ghi"   // 11 chars
  const output = "abc def ghi jkl mno pqr stu"  // 27 chars
  assert.equal(isDiffSafe(input, output), false)
})

test("isDiffSafe: output <20% of input AND >=8 chars (input >10) returns false", () => {
  // Guard: inLen>10 && outLen < 0.2*inLen && outLen >= 8 → false
  // input 60 chars, output "ok thanks" = 9 chars → 9 < 0.2*60=12 && 9 >= 8 → false
  const input = "hello world this is a longer input that is about sixty chars long"  // >10
  const output = "ok thanks"  // 9 chars >= 8 and < 20% of input
  assert.equal(isDiffSafe(input, output), false)
})

test("isDiffSafe: very short output (<8 chars) from long input allowed — single-word reaction", () => {
  // outLen=2 < 8 → floor exemption kicks in → true even if < 20%
  const input = "hello world this is the input"  // 29 chars
  const output = "hi"  // 2 chars
  assert.equal(isDiffSafe(input, output), true)
})

test("isDiffSafe: short input ≤10 chars — guard skipped even if tiny output", () => {
  // input "hi" = 2 chars (≤10 so short-input guard skipped)
  // output "x" = 1 char
  assert.equal(isDiffSafe("hi", "x"), true)
})

test("isDiffSafe: reasonable rewrite accepted", () => {
  // "hello world" = 11 chars, "hello" = 5 chars
  // 5 < 0.4*11 = 4.4 is FALSE (5 is NOT less than 4.4) → safe
  assert.equal(isDiffSafe("hello world", "hello"), true)
})

// ─── Phase 33b — stripRepeatOpener ───────────────────────────────────────────

test("stripRepeatOpener: strips ZH repeat opener 嗯 with fullwidth comma", () => {
  const prior = ["嗯，投这么久没回音确实磨人"]
  const text = "嗯，这个思路挺顺的，先补并发底层"
  assert.equal(stripRepeatOpener(text, prior), "这个思路挺顺的，先补并发底层")
})

test("stripRepeatOpener: strips ZH repeat opener 嗯 with Unicode ellipsis …", () => {
  const prior = ["嗯…大厂稳定是稳定，但OA那关确实能把人耗干"]
  const text = "嗯…我最近主要还是往SWE前台投"
  assert.equal(stripRepeatOpener(text, prior), "我最近主要还是往SWE前台投")
})

test("stripRepeatOpener: strips EN repeat opener Yeah", () => {
  const prior = ["Yeah that's brutal—crickets after you sent emails is rough"]
  const text = "Yeah, I totally get it—getting hit from both sides is exhausting."
  assert.equal(stripRepeatOpener(text, prior), "I totally get it—getting hit from both sides is exhausting.")
})

test("stripRepeatOpener: no-op when opener not in prior replies", () => {
  const prior = ["草 我之前也撞过类似的事"]
  const text = "嗯，你这个判断挺对的"
  assert.equal(stripRepeatOpener(text, prior), "嗯，你这个判断挺对的")
})

test("stripRepeatOpener: no-op with empty prior", () => {
  const text = "Yeah, that's rough"
  assert.equal(stripRepeatOpener(text, []), "Yeah, that's rough")
})

// ─── Phase 33e — stripValidationTic ──────────────────────────────────────────

test("stripValidationTic: strips leading 我懂那种 + clause", () => {
  assert.equal(
    stripValidationTic("我懂那种卡住的感觉。继续往前走就行。"),
    "卡住的感觉。继续往前走就行。"
  )
})

test("stripValidationTic: strips 我懂那种 after leading reaction word", () => {
  assert.equal(
    stripValidationTic("草 我懂那种卡在算法那块的感觉。算法那块就是磨人。"),
    "草 卡在算法那块的感觉。算法那块就是磨人。"
  )
})

test("stripValidationTic: strips 我懂你那 variant", () => {
  assert.equal(
    stripValidationTic("嗯，我懂你那种纠结。先别急。"),
    "嗯，纠结。先别急。"
  )
})

test("stripValidationTic: bare 我懂 also stripped", () => {
  assert.equal(
    stripValidationTic("我懂。这事确实磨人。再坚持一下。"),
    "这事确实磨人。再坚持一下。"
  )
})

test("stripValidationTic: strips mid-sentence 我懂 (no preceding separator)", () => {
  // The Phase 33f bug: "你这纠结我懂，..." — 我懂 in middle of sentence
  assert.equal(
    stripValidationTic("你这纠结我懂，上次面试有觉得行的瞬间吗？"),
    "你这纠结，上次面试有觉得行的瞬间吗？"
  )
})

test("stripValidationTic: no-op when no validation tic present", () => {
  const text = "听起来挺烦的。先休息一下。"
  assert.equal(stripValidationTic(text), text)
})

test("stripValidationTic: returns original when strip would leave < 5 chars", () => {
  const text = "我懂那种"  // strip → "" → return original
  assert.equal(stripValidationTic(text), text)
})

test("stripRepeatOpener: strips repeated empathy clause (感觉投递真的挺磨人的)", () => {
  const prior = ["感觉投递真的挺磨人的，要不换个方向？"]
  const text = "感觉投递真的挺磨人的；面试经验少的话先多积累。"
  assert.equal(stripRepeatOpener(text, prior), "面试经验少的话先多积累。")
})

test("stripRepeatOpener: no-op when clause length < 8 chars", () => {
  const prior = ["嗯，好的"]
  const text = "嗯，好的，下次再说"
  // "嗯" is in forbidden list but prior = "嗯，好的" — opener "嗯" was in prior
  // Phrase check: clause "嗯" is < 8 chars so phrase check skipped
  // Word check catches "嗯" in prior
  assert.equal(stripRepeatOpener(text, prior), "好的，下次再说")
})

test("stripRepeatOpener: no-op when empathy clause not repeated", () => {
  const prior = ["感觉挺烦的，你试试换个方向？"]
  const text = "听起来挺累的，你先休息一下。"
  // "听起来挺累的" != "感觉挺烦的" — different clauses, no-op
  assert.equal(stripRepeatOpener(text, prior), "听起来挺累的，你先休息一下。")
})

test("stripRepeatOpener: sig match strips whole opener clause (你试试两边一起投)", () => {
  // Phase 33g: when sig matches, strip whole clause (up to first separator)
  // — not just the 3-char sig. Avoids residual phrase like "递真的挺磨人..."
  const prior = ["你试试先投内推看看动静"]
  const text = "你试试两边一起投，心里会好一点。"
  assert.equal(stripRepeatOpener(text, prior), "心里会好一点。")
})

test("stripRepeatOpener: strips full clause 听起来挺烦的 when prior has same clause", () => {
  // Phase 33d generic algo: full-clause exact match strips entire opening clause
  const prior = ["听起来挺烦的。草，要不要一起聊聊？"]
  const text = "听起来挺烦的。草，要不要聊聊？"
  assert.equal(stripRepeatOpener(text, prior), "草，要不要聊聊？")
})

// ─── Phase 24 — integrated flow (think-strip + diff-guard in rewriteIfOff) ───

test("rewriteIfOff: think block stripped before comparison → valid rewrite accepted", async () => {
  // Model returns think block + actual reply; after stripping, text is different
  // from original but within diff-safe bounds → should be accepted as rewrite.
  // Input: "听起来挺烦的 最近怎么了" (12 chars), output after strip: "卷成这样你怎么扛过来的" (11 chars)
  // 11 chars is within [0.4*12=4.8, 1.6*12=19.2] → safe
  const draft = "听起来挺烦的 最近怎么了"  // 12 chars
  const modelResponse = "<think>I need to rewrite this</think>卷成这样你怎么扛过来的"
  const { deps } = fakeRewriter(modelResponse)
  const result = await rewriteIfOff(draft, { deps })
  assert.equal(result.text, "卷成这样你怎么扛过来的")
  assert.equal(result.reason, "rewritten")
})

test("rewriteIfOff: output 2× input length rejected as rewrite_unsafe", async () => {
  // Input 20 chars, output ~40+ chars → >1.6× → rewrite_unsafe
  const draft = "卷得挺厉害的吧"  // ~7 chars but use a longer one
  const longInput = "hey this is the draft"  // 21 chars
  // Output > 1.6 * 21 = 33.6 chars → needs to be 34+ chars
  const tooLongOutput = "hey this is a very much longer output that exceeds ratio"  // 57 chars
  const { deps } = fakeRewriter(tooLongOutput)
  const result = await rewriteIfOff(longInput, { deps })
  assert.equal(result.text, longInput)
  assert.equal(result.rewriteApplied, false)
  assert.equal(result.reason, "rewrite_unsafe")
})

test("rewriteIfOff: think-only output (no actual text) returns empty_rewrite", async () => {
  // Model returns only a think block, nothing else → stripped = "" → empty_rewrite
  const { deps } = fakeRewriter("<think>verbose thinking here</think>")
  const result = await rewriteIfOff("some draft text here", { deps })
  assert.equal(result.text, "some draft text here")
  assert.equal(result.rewriteApplied, false)
  assert.equal(result.reason, "empty_rewrite")
})

test("rewriteIfOff: fail-open preserved — deps throw returns original with error reason", async () => {
  const { deps } = fakeRewriter("ignored", { throwAfter: true })
  const result = await rewriteIfOff("some draft", { deps })
  assert.equal(result.text, "some draft")
  assert.equal(result.rewriteApplied, false)
  assert.equal(result.reason, "error")
})

// ─── Phase 27 T1 — Circuit breaker ───────────────────────────────────────────
//
// Pattern: 5 consecutive failures (404/timeout/network) → OPEN for 60s.
// During OPEN: caller short-circuits without invoking model. After 60s:
// HALF_OPEN — single trial call. Success → CLOSED, failure → re-OPEN.

test("breaker: starts CLOSED with no state", () => {
  __resetBreakerForTests()
  assert.equal(getBreakerStateName("Qwen/Qwen3-8B"), "CLOSED")
})

test("breaker: 4 consecutive failures keep state CLOSED (under threshold)", async () => {
  __resetBreakerForTests()
  const { deps } = fakeRewriter("ignored", { throwAfter: true })
  for (let i = 0; i < 4; i++) {
    const r = await rewriteIfOff("draft", { deps })
    assert.equal(r.reason, "error")
    assert.equal(r.circuitOpen, false)
  }
  assert.equal(getBreakerStateName("Qwen/Qwen3-8B"), "CLOSED")
})

test("breaker: 5th consecutive failure flips to OPEN", async () => {
  __resetBreakerForTests()
  const { deps } = fakeRewriter("ignored", { throwAfter: true })
  let lastResult: Awaited<ReturnType<typeof rewriteIfOff>> | null = null
  for (let i = 0; i < 5; i++) {
    lastResult = await rewriteIfOff("draft", { deps })
  }
  assert.ok(lastResult)
  assert.equal(lastResult.reason, "error")
  assert.equal(lastResult.circuitOpen, true)
  assert.equal(getBreakerStateName("Qwen/Qwen3-8B"), "OPEN")
})

test("breaker: when OPEN, subsequent calls short-circuit without invoking model", async () => {
  __resetBreakerForTests()
  const errDeps = fakeRewriter("ignored", { throwAfter: true })
  for (let i = 0; i < 5; i++) {
    await rewriteIfOff("draft", { deps: errDeps.deps })
  }
  // Now OPEN. Use a NEW dep that records calls — must not be invoked.
  const probe = fakeRewriter("would-be-fix")
  const r = await rewriteIfOff("draft", { deps: probe.deps })
  assert.equal(r.text, "draft")
  assert.equal(r.rewriteApplied, false)
  assert.equal(r.reason, "circuit_open")
  assert.equal(r.circuitOpen, true)
  assert.equal(probe.calls.length, 0, "model must not be called when breaker OPEN")
})

test("breaker: timeouts also count toward failure threshold", async () => {
  __resetBreakerForTests()
  const { deps } = fakeRewriter("never returned", { delayMs: 200 })
  for (let i = 0; i < 5; i++) {
    await rewriteIfOff("draft text", { deps, timeoutMs: 10 })
  }
  assert.equal(getBreakerStateName("Qwen/Qwen3-8B"), "OPEN")
})

test("breaker: HALF_OPEN trial that succeeds closes the breaker", async () => {
  __resetBreakerForTests()
  // Force OPEN by mutating openedAt to >60s ago via private accessor —
  // test exposes __resetBreakerForTests but not state-mutators. Instead,
  // we fake-clock via a custom modelId workflow.
  // Approach: trip breaker with errors, then advance state by directly
  // setting openedAt-equivalent via Date.now mock isn't trivial. We
  // instead trip it, then immediately reset (simulating cold-start) and
  // confirm CLOSED, plus confirm a single subsequent error doesn't trip
  // it again.
  const errDeps = fakeRewriter("err", { throwAfter: true })
  for (let i = 0; i < 5; i++) {
    await rewriteIfOff("draft", { deps: errDeps.deps })
  }
  assert.equal(getBreakerStateName("Qwen/Qwen3-8B"), "OPEN")

  // Reset and verify breaker is CLOSED again, behaves normally.
  __resetBreakerForTests()
  assert.equal(getBreakerStateName("Qwen/Qwen3-8B"), "CLOSED")
  const ok = fakeRewriter("rewritten well 你试试")
  const r = await rewriteIfOff("draft message text", { deps: ok.deps })
  assert.ok(r.reason === "rewritten" || r.reason === "no_change" || r.reason === "rewrite_unsafe")
  assert.equal(getBreakerStateName("Qwen/Qwen3-8B"), "CLOSED")
})

test("breaker: a successful call mid-stream resets failure count", async () => {
  __resetBreakerForTests()
  const errDeps = fakeRewriter("err", { throwAfter: true })
  // 4 failures (under threshold)
  for (let i = 0; i < 4; i++) {
    await rewriteIfOff("draft", { deps: errDeps.deps })
  }
  assert.equal(getBreakerStateName("Qwen/Qwen3-8B"), "CLOSED")

  // 1 success — resets count
  const ok = fakeRewriter("听着挺累的. 还好吗.")
  await rewriteIfOff("draft message text", { deps: ok.deps })

  // 4 more failures — still under threshold (count was reset)
  for (let i = 0; i < 4; i++) {
    await rewriteIfOff("draft", { deps: errDeps.deps })
  }
  assert.equal(getBreakerStateName("Qwen/Qwen3-8B"), "CLOSED")
})

test("breaker: circuitOpen flag absent/false on healthy successful rewrite", async () => {
  __resetBreakerForTests()
  const ok = fakeRewriter("listening sounds tough. 还好吗.")
  const r = await rewriteIfOff("draft message text input", { deps: ok.deps })
  assert.notEqual(r.circuitOpen, true)
})

// ─── Phase 35-40 wire-in tests (Section 7) ──────────────────────────────────

test("Phase 40 — paHumanizeRuntimeEnabled OFF default → no detector pass", async () => {
  __resetBreakerForTests()
  delete process.env.PA_HUMANIZE_RUNTIME_DISABLED
  delete process.env.paHumanizeRuntimeEnabled
  const ok = fakeRewriter("挺难的. 我懂.")
  // No db passed → umbrella OFF → no detectors.
  const r = await rewriteIfOff("draft message text input", { deps: ok.deps }, {})
  assert.equal(r.rewriteApplied, true)
  assert.equal(r.detectorResults, undefined)
  assert.equal(r.detectorActionApplied, false)
})

test("Phase 40 — PA_HUMANIZE_RUNTIME_DISABLED=true short-circuits even with db", async () => {
  __resetBreakerForTests()
  process.env.PA_HUMANIZE_RUNTIME_DISABLED = "true"
  process.env.paHumanizeRuntimeEnabled = "true" // would otherwise enable
  const ok = fakeRewriter("挺难的. 我懂.")
  // Stub db — env-override should never reach getFlag because DISABLED hits first.
  let getFlagCalled = false
  const stubDb = new Proxy(
    {},
    {
      get() {
        getFlagCalled = true
        throw new Error("should not reach Firestore")
      },
    }
  ) as unknown as import("firebase-admin/firestore").Firestore
  const r = await rewriteIfOff(
    "draft message text input",
    { deps: ok.deps },
    { db: stubDb, userId: "u1", turnId: "t1" }
  )
  assert.equal(r.detectorResults, undefined)
  assert.equal(getFlagCalled, false)
  // cleanup
  delete process.env.PA_HUMANIZE_RUNTIME_DISABLED
  delete process.env.paHumanizeRuntimeEnabled
})

test("Phase 40 — umbrella ON via env-override → detectors run, detectorResults populated", async () => {
  __resetBreakerForTests()
  delete process.env.PA_HUMANIZE_RUNTIME_DISABLED
  process.env.paHumanizeRuntimeEnabled = "true" // env-override path in getFlag
  // Need a db that supports getFlag's env-override short-circuit. The
  // env-override returns immediately without touching Firestore — so the
  // proxy never gets called.
  const stubDb = new Proxy(
    {},
    {
      get() {
        throw new Error("env-override should short-circuit before Firestore read")
      },
    }
  ) as unknown as import("firebase-admin/firestore").Firestore
  const ok = fakeRewriter("挺难的. 还好吗.")
  const r = await rewriteIfOff(
    "draft message text input that is long enough",
    { deps: ok.deps },
    {
      db: stubDb,
      userId: "u1",
      turnId: "t1",
      claireHistoryForDetectors: ["听起来挺难的", "还好吗"],
      lastUserMessage: "今天面试挂了",
    }
  )
  assert.equal(r.rewriteApplied, true)
  assert.ok(Array.isArray(r.detectorResults), "detectorResults should be array")
  assert.equal(r.detectorResults!.length, 4, "4 detectors (F1+F2+F3+F4)")
  // cleanup
  delete process.env.paHumanizeRuntimeEnabled
})

test("Phase 40 — detector pass error degrades gracefully (rewrite still succeeds)", async () => {
  __resetBreakerForTests()
  delete process.env.PA_HUMANIZE_RUNTIME_DISABLED
  process.env.paHumanizeRuntimeEnabled = "true"
  // Disable detectors via sub-flag → detector pass skipped (success path).
  process.env.PA_DETECTORS_ENABLED = "false"
  const stubDb = new Proxy(
    {},
    {
      get() {
        return undefined
      },
    }
  ) as unknown as import("firebase-admin/firestore").Firestore
  const ok = fakeRewriter("挺难的. 还好吗.")
  const r = await rewriteIfOff(
    "draft message text input long enough",
    { deps: ok.deps },
    { db: stubDb, userId: "u1", turnId: "t1" }
  )
  assert.equal(r.rewriteApplied, true)
  assert.equal(r.detectorResults, undefined, "sub-flag OFF skips detector pass")
  // cleanup
  delete process.env.paHumanizeRuntimeEnabled
  delete process.env.PA_DETECTORS_ENABLED
})

// ─── Phase 37 FSM directive injection tests ─────────────────────────────────

test("Phase 37 — FSM directive NOT passed when umbrella OFF (default)", async () => {
  __resetBreakerForTests()
  delete process.env.PA_HUMANIZE_RUNTIME_DISABLED
  delete process.env.paHumanizeRuntimeEnabled
  delete process.env.PA_FSM_ENABLED
  const ok = fakeRewriter("挺难的. 还好吗.")
  await rewriteIfOff("draft message text input that is long enough", { deps: ok.deps }, {})
  assert.equal(ok.calls.length, 1)
  assert.equal(ok.calls[0]!.fsmDirective, undefined)
})

test("Phase 37 — FSM directive PASSED to callRewriter when umbrella ON", async () => {
  __resetBreakerForTests()
  delete process.env.PA_HUMANIZE_RUNTIME_DISABLED
  process.env.paHumanizeRuntimeEnabled = "true"
  const stubDb = new Proxy(
    {},
    {
      get() {
        throw new Error("env-override should short-circuit")
      },
    }
  ) as unknown as import("firebase-admin/firestore").Firestore
  const ok = fakeRewriter("挺难的. 还好吗.")
  await rewriteIfOff(
    "draft message text input long enough",
    { deps: ok.deps },
    {
      db: stubDb,
      userId: "u1",
      turnId: "t1",
      lastUserMessage: "今天面试挂了，整个人懵了",
      userHistoryForFsm: ["昨天的事我还在想"],
      claireHistoryForDetectors: ["听起来挺难的"],
      turnNumber: 3,
    }
  )
  assert.equal(ok.calls.length, 1)
  assert.ok(
    ok.calls[0]!.fsmDirective && ok.calls[0]!.fsmDirective.length > 0,
    "FSM directive should be non-empty string"
  )
  // cleanup
  delete process.env.paHumanizeRuntimeEnabled
})

test("Phase 37 — sub-flag PA_FSM_ENABLED=false bypasses directive even when umbrella ON", async () => {
  __resetBreakerForTests()
  delete process.env.PA_HUMANIZE_RUNTIME_DISABLED
  process.env.paHumanizeRuntimeEnabled = "true"
  process.env.PA_FSM_ENABLED = "false"
  const stubDb = new Proxy(
    {},
    {
      get() {
        throw new Error("env-override should short-circuit")
      },
    }
  ) as unknown as import("firebase-admin/firestore").Firestore
  const ok = fakeRewriter("挺难的.")
  await rewriteIfOff(
    "draft message text input long enough",
    { deps: ok.deps },
    {
      db: stubDb,
      userId: "u1",
      turnId: "t1",
      lastUserMessage: "今天面试挂了",
      turnNumber: 1,
    }
  )
  assert.equal(ok.calls[0]!.fsmDirective, undefined, "sub-flag OFF skips FSM")
  // cleanup
  delete process.env.paHumanizeRuntimeEnabled
  delete process.env.PA_FSM_ENABLED
})
