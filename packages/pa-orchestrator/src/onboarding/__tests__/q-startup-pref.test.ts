/**
 * Layer 1 unit tests — q_startup_pref (LLMRelevanceJudge w/ stub).
 */
import test from "node:test"
import assert from "node:assert/strict"
import { LLMRelevanceJudge, type ExtractIntentFn, type IntentResult } from "../judges/llm-relevance.js"
import type { JudgeCtx } from "../question.js"

function ctx(): JudgeCtx {
  return { userId: "u", turnId: "t" }
}

function makeJudge(canned: IntentResult<unknown> | null) {
  let calls = 0
  const fn: ExtractIntentFn = async () => {
    calls++
    return canned
  }
  const J = new LLMRelevanceJudge<unknown>({
    step: "ask_q_startup_pref",
    extractIntent: fn,
  })
  return { J, calls: () => calls }
}

test("q-startup-pref: 'startup' → startup", async () => {
  const { J } = makeJudge({ intent: "provided", value: "startup", confidence: 0.99 })
  const r = await J.judge("startup", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "startup")
})

test("q-startup-pref: 'big tech' → bigtech", async () => {
  const { J } = makeJudge({ intent: "provided", value: "bigtech", confidence: 0.95 })
  const r = await J.judge("big tech", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "bigtech")
})

test("q-startup-pref: 'either' → either", async () => {
  const { J } = makeJudge({ intent: "provided", value: "either", confidence: 0.98 })
  const r = await J.judge("either", "en", ctx())
  assert.equal(r.accept, true)
})

test("q-startup-pref: '都行' → either", async () => {
  const { J } = makeJudge({ intent: "provided", value: "either", confidence: 0.95 })
  const r = await J.judge("都行", "zh", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "either")
})

test("q-startup-pref: '大厂' → bigtech", async () => {
  const { J } = makeJudge({ intent: "provided", value: "bigtech", confidence: 0.97 })
  const r = await J.judge("大厂", "zh", ctx())
  assert.equal(r.accept, true)
})

test("q-startup-pref: 'fast paced startup vibe' → startup", async () => {
  const { J } = makeJudge({ intent: "provided", value: "startup", confidence: 0.9 })
  const r = await J.judge("fast paced startup vibe", "en", ctx())
  assert.equal(r.accept, true)
})

test("q-startup-pref: 'stable big company' → bigtech", async () => {
  const { J } = makeJudge({ intent: "provided", value: "bigtech", confidence: 0.92 })
  const r = await J.judge("stable big company", "en", ctx())
  assert.equal(r.accept, true)
})

test("q-startup-pref: 'mid-size scaleup' → unclear", async () => {
  const { J } = makeJudge({
    intent: "unclear",
    clarifyingQuestion: "startup / bigtech / either — pick one?",
  })
  const r = await J.judge("mid-size scaleup", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "unclear")
})

test("q-startup-pref: empty → irrelevant (no LLM call)", async () => {
  const { J, calls } = makeJudge({ intent: "provided", value: "either", confidence: 0.99 })
  const r = await J.judge("", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
  assert.equal(calls(), 0)
})

test("q-startup-pref: low confidence → unclear", async () => {
  const { J } = makeJudge({ intent: "provided", value: "either", confidence: 0.4 })
  const r = await J.judge("eh maybe", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "unclear")
})
