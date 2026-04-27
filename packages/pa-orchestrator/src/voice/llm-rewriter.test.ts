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
 */
import test from "node:test"
import assert from "node:assert/strict"

import { rewriteIfOff, type RewriterDeps } from "./llm-rewriter.js"

/**
 * Helper: build a fake LLM dep that returns the given completion text once,
 * recording the prompt it was called with for inspection.
 */
function fakeRewriter(returnText: string, opts: { delayMs?: number; throwAfter?: boolean } = {}): {
  deps: RewriterDeps
  calls: { rawText: string }[]
} {
  const calls: { rawText: string }[] = []
  const deps: RewriterDeps = {
    callRewriter: async (rawText, _signal) => {
      calls.push({ rawText })
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      if (opts.throwAfter) throw new Error("simulated upstream error")
      return returnText
    },
  }
  return { deps, calls }
}

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
  const draft = "你现在是想找个人接住你一下 😌 我懂."
  const cleaned = "听着挺累的."
  const { deps } = fakeRewriter(cleaned)
  const result = await rewriteIfOff(draft, { deps })
  assert.equal(result.text, cleaned)
  assert.equal(result.rewriteApplied, true)
})

test("rewriteIfOff: productivity-coach probe removed", async () => {
  const draft = "听起来挺难的.\n你现在最想先把哪一件搞定?"
  const cleaned = "听起来挺难的."
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
