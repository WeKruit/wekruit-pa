/**
 * Layer 1 unit tests — q_yoe V2 GuidedOpenJudge path.
 */
import test from "node:test"
import assert from "node:assert/strict"

import { makeYoeQuestion, type YoeAnswer } from "../questions.js"
import type { LlmCallFn } from "../judges/guided-open.js"
import type { JudgeCtx } from "../question.js"

function ctx(): JudgeCtx {
  return { userId: "u", turnId: "t" }
}

function makeQuestionWithJson(json: string | Error) {
  let calls = 0
  const llm: LlmCallFn = async () => {
    calls++
    if (json instanceof Error) throw json
    return json
  }
  return {
    q: makeYoeQuestion(undefined, () => llm),
    calls: () => calls,
  }
}

async function judge(reply: string, value: YoeAnswer) {
  const { q } = makeQuestionWithJson(JSON.stringify({
    intent: "provided",
    value,
    confidence: 0.98,
  }))
  return q.judge.judge(reply, "en", ctx())
}

test("q-yoe: '2years' → 2 via GuidedOpen", async () => {
  const r = await judge("2years", 2)
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, 2)
})

test("q-yoe: long natural answer with '2 years' parses before LLM", async () => {
  const { q, calls } = makeQuestionWithJson(JSON.stringify({
    intent: "unclear",
    clarifyingQuestion: "roughly how many years?",
  }))
  const r = await q.judge.judge(
    "About 2 years of hands-on work if you count the Tesla internship and startup/operator builds.",
    "en",
    ctx()
  )
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, 2)
  assert.equal(calls(), 0)
})

test("q-yoe: LLM string value '2years' is parsed as 2", async () => {
  const r = await judge("2years", "2years" as unknown as YoeAnswer)
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, 2)
})

test("q-yoe: LLM string range '3-5 years' is parsed as 3", async () => {
  const r = await judge("3-5 years", "3-5 years" as unknown as YoeAnswer)
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, 3)
})

test("q-yoe: '3年' → 3", async () => {
  const r = await judge("3年", 3)
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, 3)
})

test("q-yoe: 'fresh grad' → fresh", async () => {
  const r = await judge("fresh grad", "fresh")
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "fresh")
})

test("q-yoe: ambiguous answer stays unclear", async () => {
  const { q } = makeQuestionWithJson(JSON.stringify({
    intent: "unclear",
    clarifyingQuestion: "roughly how many years?",
  }))
  const r = await q.judge.judge("a few years", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "unclear")
})

test("q-yoe: punctuation skips LLM", async () => {
  const { q, calls } = makeQuestionWithJson(JSON.stringify({
    intent: "provided",
    value: 0,
    confidence: 0.99,
  }))
  const r = await q.judge.judge("？？？", "zh", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
  assert.equal(calls(), 0)
})
