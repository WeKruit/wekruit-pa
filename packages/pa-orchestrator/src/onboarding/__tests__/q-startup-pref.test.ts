/**
 * Layer 1 unit tests — q_startup_pref V2 GuidedOpenJudge path.
 */
import test from "node:test"
import assert from "node:assert/strict"

import { makeStartupPrefQuestion } from "../questions.js"
import type { LlmCallFn } from "../judges/guided-open.js"
import type { JudgeCtx } from "../question.js"

function ctx(): JudgeCtx {
  return { userId: "u", turnId: "t" }
}

function makeJudge(json: string) {
  let calls = 0
  const llm: LlmCallFn = async () => {
    calls++
    return json
  }
  const judge = makeStartupPrefQuestion(undefined, () => llm).judge
  return { judge, calls: () => calls }
}

test("q-startup-pref: 'startup' → startup", async () => {
  const { judge } = makeJudge(JSON.stringify({ intent: "provided", value: "startup", confidence: 0.99 }))
  const r = await judge.judge("startup", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "startup")
})

test("q-startup-pref: natural startup preference skips LLM and accepts", async () => {
  const { judge, calls } = makeJudge(JSON.stringify({ intent: "unclear" }))
  const r = await judge.judge(
    "I lean startup or fast-moving early-stage teams, especially fintech or AI tools, but I still care about a solid manager and clear ownership.",
    "en",
    ctx(),
  )
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "startup")
  assert.equal(calls(), 0)
})

test("q-startup-pref: flexible natural wording skips LLM and accepts either", async () => {
  const { judge, calls } = makeJudge(JSON.stringify({ intent: "unclear" }))
  const r = await judge.judge("I am flexible; depends on the team and ownership.", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "either")
  assert.equal(calls(), 0)
})

test("q-startup-pref: 'stable big company' → bigtech", async () => {
  const { judge } = makeJudge(JSON.stringify({ intent: "provided", value: "bigtech", confidence: 0.95 }))
  const r = await judge.judge("stable big company", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "bigtech")
})

test("q-startup-pref: '都行' → either", async () => {
  const { judge } = makeJudge(JSON.stringify({ intent: "provided", value: "either", confidence: 0.95 }))
  const r = await judge.judge("都行", "zh", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "either")
})

test("q-startup-pref: 'startup or bigtech' → either", async () => {
  const { judge } = makeJudge(JSON.stringify({
    intent: "provided",
    value: "startup or bigtech",
    confidence: 0.95,
  }))
  const r = await judge.judge("startup or bigtech", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "either")
})

test("q-startup-pref: unclear remains non-accept", async () => {
  const { judge } = makeJudge(JSON.stringify({
    intent: "unclear",
    clarifyingQuestion: "startup / bigtech / either?",
  }))
  const r = await judge.judge("mid-size scaleup", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "unclear")
})

test("q-startup-pref: empty skips LLM", async () => {
  const { judge, calls } = makeJudge(JSON.stringify({ intent: "provided", value: "either", confidence: 0.99 }))
  const r = await judge.judge("", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
  assert.equal(calls(), 0)
})
