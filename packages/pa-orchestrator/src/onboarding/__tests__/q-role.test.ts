/**
 * Layer 1 unit tests — q_role (LLMRelevanceJudge with stubbed extractIntent).
 *
 * V1 path: LLMRelevanceJudge wraps a per-step extractIntent function. We stub
 * it with canned `{intent: "provided" | "unclear", value, confidence}` per case.
 * No real LLM, no network.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { LLMRelevanceJudge, type ExtractIntentFn, type IntentResult } from "../judges/llm-relevance.js"
import type { JudgeCtx } from "../question.js"

function ctx(): JudgeCtx {
  return { userId: "u", turnId: "t" }
}

function makeStub(canned: IntentResult<unknown> | null, throws?: Error) {
  let calls = 0
  const fn: ExtractIntentFn = async () => {
    calls++
    if (throws) throw throws
    return canned
  }
  return { fn, get calls() { return calls } } as { fn: ExtractIntentFn; calls: number }
}

function makeJudge(canned: IntentResult<unknown> | null, throws?: Error) {
  const stub = makeStub(canned, throws)
  const J = new LLMRelevanceJudge<unknown>({
    step: "ask_q_role",
    extractIntent: stub.fn,
  })
  return { J, stub }
}

test("q-role: 'engineer' → swe", async () => {
  const { J } = makeJudge({ intent: "provided", value: "swe", confidence: 0.95 })
  const r = await J.judge("engineer", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "swe")
})

test("q-role: 'software engineer' → swe", async () => {
  const { J } = makeJudge({ intent: "provided", value: "swe", confidence: 0.95 })
  const r = await J.judge("software engineer", "en", ctx())
  assert.equal(r.accept, true)
})

test("q-role: 'PM' → product_manager", async () => {
  const { J } = makeJudge({ intent: "provided", value: "product_manager", confidence: 0.92 })
  const r = await J.judge("PM", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "product_manager")
})

test("q-role: 'product manager' → product_manager", async () => {
  const { J } = makeJudge({ intent: "provided", value: "product_manager", confidence: 0.95 })
  const r = await J.judge("product manager", "en", ctx())
  assert.equal(r.accept, true)
})

test("q-role: 'data scientist' → data_science", async () => {
  const { J } = makeJudge({ intent: "provided", value: "data_science", confidence: 0.93 })
  const r = await J.judge("data scientist", "en", ctx())
  assert.equal(r.accept, true)
})

test("q-role: 'ML engineer' → ml_engineer", async () => {
  const { J } = makeJudge({ intent: "provided", value: "ml_engineer", confidence: 0.94 })
  const r = await J.judge("ML engineer", "en", ctx())
  assert.equal(r.accept, true)
})

test("q-role: 'designer' → designer", async () => {
  const { J } = makeJudge({ intent: "provided", value: "designer", confidence: 0.95 })
  const r = await J.judge("designer", "en", ctx())
  assert.equal(r.accept, true)
})

test("q-role: 'researcher' → researcher", async () => {
  const { J } = makeJudge({ intent: "provided", value: "researcher", confidence: 0.92 })
  const r = await J.judge("researcher", "en", ctx())
  assert.equal(r.accept, true)
})

test("q-role: '前端工程师' → frontend", async () => {
  const { J } = makeJudge({ intent: "provided", value: "frontend", confidence: 0.95 })
  const r = await J.judge("前端工程师", "zh", ctx())
  assert.equal(r.accept, true)
})

test("q-role: 'enginer' (typo) → swe", async () => {
  const { J } = makeJudge({ intent: "provided", value: "swe", confidence: 0.85 })
  const r = await J.judge("enginer", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "swe")
})

test("q-role: 'I want to do something cool' → unclear", async () => {
  const { J } = makeJudge({
    intent: "unclear",
    clarifyingQuestion: "swe / pm / research / design — pick one?",
  })
  const r = await J.judge("I want to do something cool", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) {
    assert.equal(r.reason, "unclear")
    assert.match(r.clarifyingQuestion ?? "", /swe|pm|research|design/i)
  }
})

test("q-role: low confidence (0.4) → unclear", async () => {
  const { J } = makeJudge({ intent: "provided", value: "swe", confidence: 0.4 })
  const r = await J.judge("idk maybe engineer-ish", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "unclear")
})

test("q-role: empty/punctuation → irrelevant (no LLM)", async () => {
  const { J, stub } = makeJudge({ intent: "provided", value: "swe", confidence: 0.95 })
  const r = await J.judge("...", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
  assert.equal(stub.calls, 0, "noise should skip LLM")
})

test("q-role: LLM throws → irrelevant", async () => {
  const { J } = makeJudge(null, new Error("network"))
  const r = await J.judge("engineer", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
})
