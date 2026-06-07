import assert from "node:assert/strict"
import test from "node:test"

import {
  buildTurnIntentPrompt,
  extractTurnIntent,
  validateTurnIntentResult,
  TURN_INTENT_UNAVAILABLE,
  TURN_INTENT_VOCAB,
  type TurnIntentLlmCall,
} from "./turn-intent-extractor.js"

test("validate: closed-vocab labels parsed, off-vocab dropped, absent default", () => {
  const result = validateTurnIntentResult({
    labels: {
      job_search_request: { present: true, confidence: 0.9 },
      durable_preference_update: { present: true, confidence: 1.4 }, // clamp
      not_a_real_label: { present: true, confidence: 0.99 }, // dropped
      meta_question: { present: false, confidence: 0.3 },
    },
    preferencePolarity: "negative",
    evidence: "product roles only",
  })

  assert.equal(result.available, true)
  assert.deepEqual(result.labels.job_search_request, { present: true, confidence: 0.9 })
  assert.deepEqual(result.labels.durable_preference_update, { present: true, confidence: 1 })
  assert.deepEqual(result.labels.meta_question, { present: false, confidence: 0 })
  // Off-vocab key never appears.
  assert.ok(!Object.keys(result.labels).includes("not_a_real_label"))
  assert.equal(result.preferencePolarity, "negative")
  assert.equal(result.evidence, "product roles only")
})

test("validate: present=false zeroes confidence; non-object input → all absent", () => {
  const result = validateTurnIntentResult({
    labels: { confusion: { present: false, confidence: 0.95 } },
  })
  assert.deepEqual(result.labels.confusion, { present: false, confidence: 0 })

  const garbage = validateTurnIntentResult("not json")
  assert.equal(garbage.available, true)
  for (const label of TURN_INTENT_VOCAB) {
    assert.deepEqual(garbage.labels[label], { present: false, confidence: 0 })
  }
})

test("validate: off-vocab preferencePolarity is dropped", () => {
  const result = validateTurnIntentResult({
    labels: { durable_preference_update: { present: true, confidence: 0.8 } },
    preferencePolarity: "sideways",
  })
  assert.equal(result.preferencePolarity, undefined)
})

test("extract: empty text returns the unavailable sentinel without calling the LLM", async () => {
  let called = false
  const llm: TurnIntentLlmCall = async () => {
    called = true
    return { json: {} }
  }
  const result = await extractTurnIntent({ text: "   " }, llm)
  assert.equal(called, false)
  assert.equal(result, TURN_INTENT_UNAVAILABLE)
  assert.equal(result.available, false)
})

test("extract: LLM throw fails OPEN to the unavailable sentinel", async () => {
  const llm: TurnIntentLlmCall = async () => {
    throw new Error("provider 500")
  }
  const result = await extractTurnIntent({ text: "find me jobs" }, llm)
  assert.equal(result.available, false)
})

test("extract: LLM timeout fails OPEN to the unavailable sentinel", async () => {
  const llm: TurnIntentLlmCall = () => new Promise(() => {}) // never resolves
  const result = await extractTurnIntent({ text: "find me jobs" }, llm, { timeoutMs: 20 })
  assert.equal(result.available, false)
})

test("extract: happy path returns validated, available labels", async () => {
  const llm: TurnIntentLlmCall = async () => ({
    json: {
      labels: {
        job_search_request: { present: true, confidence: 0.92 },
        durable_preference_update: { present: true, confidence: 0.7 },
      },
      preferencePolarity: "negative",
      evidence: "no SWE, find me PM",
    },
  })
  const result = await extractTurnIntent({ text: "no SWE, find me PM roles" }, llm)
  assert.equal(result.available, true)
  assert.equal(result.labels.job_search_request.present, true)
  assert.equal(result.labels.durable_preference_update.present, true)
  assert.equal(result.preferencePolarity, "negative")
})

test("prompt: lists every closed label and forbids classifying safety/privacy", () => {
  const prompt = buildTurnIntentPrompt({ text: "hi", hasPrescreenEvidence: true })
  for (const label of TURN_INTENT_VOCAB) {
    assert.ok(prompt.includes(label), `prompt should mention ${label}`)
  }
  assert.match(prompt, /Do NOT classify safety \/ stop \/ privacy \/ unsubscribe/i)
  assert.match(prompt, /prescreen outcome IS on record/i)
})
