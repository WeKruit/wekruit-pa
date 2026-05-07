/**
 * Layer 1 unit tests — q_yoe (LLMRelevanceJudge w/ stubbed extractIntent).
 *
 * Covers number / fresh / typo / range / zh.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { LLMRelevanceJudge, type ExtractIntentFn, type IntentResult } from "../judges/llm-relevance.js"
import type { JudgeCtx } from "../question.js"

function ctx(): JudgeCtx {
  return { userId: "u", turnId: "t" }
}

function makeJudge(canned: IntentResult<unknown> | null, throws?: Error) {
  let calls = 0
  const fn: ExtractIntentFn = async () => {
    calls++
    if (throws) throw throws
    return canned
  }
  const stub = { fn, get calls() { return calls } } as { fn: ExtractIntentFn; calls: number }
  const J = new LLMRelevanceJudge<unknown>({
    step: "ask_q_yoe",
    extractIntent: stub.fn,
  })
  return { J, stub }
}

test("q-yoe: '5y' → 5 (1-char-after-trim guard)", async () => {
  const { J } = makeJudge({ intent: "provided", value: 5, confidence: 1.0 })
  const r = await J.judge("5y", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, 5)
})

test("q-yoe: '5 years' → 5", async () => {
  const { J } = makeJudge({ intent: "provided", value: 5, confidence: 0.98 })
  const r = await J.judge("5 years", "en", ctx())
  assert.equal(r.accept, true)
})

test("q-yoe: '3年' → 3", async () => {
  const { J } = makeJudge({ intent: "provided", value: 3, confidence: 0.98 })
  const r = await J.judge("3年", "zh", ctx())
  assert.equal(r.accept, true)
})

test("q-yoe: 'fresh grad' → 0", async () => {
  const { J } = makeJudge({ intent: "provided", value: 0, confidence: 0.95 })
  const r = await J.judge("fresh grad", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, 0)
})

test("q-yoe: '应届' → 0", async () => {
  const { J } = makeJudge({ intent: "provided", value: 0, confidence: 0.95 })
  const r = await J.judge("应届", "zh", ctx())
  assert.equal(r.accept, true)
})

test("q-yoe: '刚毕业' → 0", async () => {
  const { J } = makeJudge({ intent: "provided", value: 0, confidence: 0.95 })
  const r = await J.judge("刚毕业", "zh", ctx())
  assert.equal(r.accept, true)
})

test("q-yoe: '3-5 years' (range) → 4", async () => {
  // LLM may pick the midpoint or one of the endpoints; we just assert accept.
  const { J } = makeJudge({ intent: "provided", value: 4, confidence: 0.9 })
  const r = await J.judge("3-5 years", "en", ctx())
  assert.equal(r.accept, true)
})

test("q-yoe: '10+ years' → 10", async () => {
  const { J } = makeJudge({ intent: "provided", value: 10, confidence: 0.95 })
  const r = await J.judge("10+ years", "en", ctx())
  assert.equal(r.accept, true)
})

test("q-yoe: 'a few years' → unclear", async () => {
  const { J } = makeJudge({
    intent: "unclear",
    clarifyingQuestion: "ballpark a number? 1 / 3 / 5 / 10?",
  })
  const r = await J.judge("a few years", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "unclear")
})

test("q-yoe: 'I'm thinking about it' → unclear", async () => {
  const { J } = makeJudge({
    intent: "unclear",
    clarifyingQuestion: "how many years?",
  })
  const r = await J.judge("I'm thinking about it", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "unclear")
})

test("q-yoe: 'banana' → unclear", async () => {
  const { J } = makeJudge({
    intent: "unclear",
    clarifyingQuestion: "a number works",
  })
  const r = await J.judge("banana", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "unclear")
})

test("q-yoe: '？？？' → irrelevant (no LLM call, pure punct)", async () => {
  const { J, stub } = makeJudge({ intent: "provided", value: 0, confidence: 0.99 })
  const r = await J.judge("？？？", "zh", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
  assert.equal(stub.calls, 0)
})

test("q-yoe: low confidence → unclear", async () => {
  const { J } = makeJudge({ intent: "provided", value: 5, confidence: 0.45 })
  const r = await J.judge("kinda 5", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "unclear")
})
