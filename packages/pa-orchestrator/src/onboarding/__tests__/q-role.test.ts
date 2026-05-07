/**
 * Layer 1 unit tests — q_role V2 GuidedOpenJudge path.
 */
import test from "node:test"
import assert from "node:assert/strict"

import { makeRoleQuestion } from "../questions.js"
import type { LlmCallFn } from "../judges/guided-open.js"
import type { JudgeCtx } from "../question.js"

function ctx(): JudgeCtx {
  return { userId: "u", turnId: "t" }
}

function makeJudge(json: string | Error) {
  let calls = 0
  const llm: LlmCallFn = async () => {
    calls++
    if (json instanceof Error) throw json
    return json
  }
  const judge = makeRoleQuestion(undefined, () => llm).judge
  return { judge, calls: () => calls }
}

test("q-role: 'engineer' → swe via GuidedOpen", async () => {
  const { judge } = makeJudge(JSON.stringify({ intent: "provided", value: "swe", confidence: 0.95 }))
  const r = await judge.judge("engineer", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["swe"])
})

test("q-role: typo 'enginer' → swe via LLM", async () => {
  const { judge } = makeJudge(JSON.stringify({ intent: "provided", value: "swe", confidence: 0.9 }))
  const r = await judge.judge("enginer", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["swe"])
})

test("q-role: 'Swe / pm' accepts multi-role array", async () => {
  const { judge } = makeJudge(JSON.stringify({
    intent: "provided",
    value: ["swe", "pm"],
    confidence: 0.95,
  }))
  const r = await judge.judge("Swe / pm", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["swe", "pm"])
})

test("q-role: LLM string 'swe / pm' is split into multi-role array", async () => {
  const { judge } = makeJudge(JSON.stringify({
    intent: "provided",
    value: "swe / pm",
    confidence: 0.95,
  }))
  const r = await judge.judge("Swe / pm", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["swe", "pm"])
})

test("q-role: unclear role stays on question", async () => {
  const { judge } = makeJudge(JSON.stringify({
    intent: "unclear",
    clarifyingQuestion: "eng / pm / research / design?",
  }))
  const r = await judge.judge("I want to do something cool", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "unclear")
})

test("q-role: noise skips LLM", async () => {
  const { judge, calls } = makeJudge(JSON.stringify({ intent: "provided", value: "swe", confidence: 0.95 }))
  const r = await judge.judge("...", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
  assert.equal(calls(), 0)
})

test("q-role: LLM throw is non-accept", async () => {
  const { judge } = makeJudge(new Error("network"))
  const r = await judge.judge("engineer", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
})
