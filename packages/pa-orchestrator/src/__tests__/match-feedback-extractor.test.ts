/**
 * Tests for the no-regex (2026-05-30) LLM match-FEEDBACK extractor.
 * Adam directive: the "good or not / why or why not" signal + subscribe intent
 * must be LLM-extracted into structured feedback validated against shared-tags
 * closed enums — never regex/keyword classification.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"

import {
  extractMatchFeedback,
  validateFeedbackResult,
  AMBIGUOUS_FEEDBACK,
  type FeedbackLlmCall,
} from "../match-feedback-extractor.js"

test("validates sentiment/intent/reasonCategory against closed enums; off-vocab → safe defaults", () => {
  const ok = validateFeedbackResult({
    replyKind: "feedback_answer",
    sentiment: "negative",
    intent: "no",
    reasonCategory: "wrong_seniority",
  })
  assert.equal(ok.sentiment, "negative")
  assert.equal(ok.intent, "no")
  assert.equal(ok.reasonCategory, "wrong_seniority")

  const garbage = validateFeedbackResult({
    sentiment: "furious",
    intent: "maybe",
    reasonCategory: "vibes",
    replyKind: "rant",
  })
  assert.equal(garbage.sentiment, "ambiguous")
  assert.equal(garbage.intent, "ambiguous")
  assert.equal(garbage.reasonCategory, "none")
  assert.equal(garbage.replyKind, "feedback_answer")
})

test("OR tag deltas from the dislike reason validate against shared-tags vocab", () => {
  const r = validateFeedbackResult({
    sentiment: "negative",
    reasonCategory: "wrong_industry",
    tagDeltas: {
      industrySector: ["healthcare_and_life_sciences", "not_a_sector"],
      negativeIndustrySector: ["financial_technology"],
      careerStage: "senior",
    },
  })
  assert.deepEqual(r.tagDeltas.industrySector, ["healthcare_and_life_sciences"]) // off-vocab dropped
  assert.deepEqual(r.tagDeltas.negativeIndustrySector, ["financial_technology"])
  assert.equal(r.tagDeltas.careerStage, "senior")
})

test("negativeJobType tag delta validates + passes through (jobType negation parity 2026-06-09)", () => {
  // "stop sending internships, I want full-time" — the dislike reason must be
  // expressible as a jobType negation, not just role/industry.
  const r = validateFeedbackResult({
    sentiment: "negative",
    reasonCategory: "wrong_job_type",
    tagDeltas: {
      targetJobType: ["full_time"],
      negativeJobType: ["internship", "not_a_job_type"],
    },
  })
  assert.deepEqual(r.tagDeltas.targetJobType, ["full_time"])
  assert.deepEqual(r.tagDeltas.negativeJobType, ["internship"], "off-vocab dropped, valid token kept")
})

test("feedback prompt lists negativeJobType as an emittable tagDeltas key", async () => {
  let seenPrompt = ""
  const llm: FeedbackLlmCall = async ({ prompt }) => {
    seenPrompt = prompt
    return { json: {} }
  }
  await extractMatchFeedback(
    { questionKind: "dislike_reason", reply: "I'm not looking for an internship" },
    llm,
  )
  assert.ok(seenPrompt.includes("negativeJobType"), "tagDeltas key list must include negativeJobType")
})

test("extractMatchFeedback fails OPEN to ambiguous on LLM error (no regex fallback)", async () => {
  const throwing: FeedbackLlmCall = async () => {
    throw new Error("provider down")
  }
  const r = await extractMatchFeedback(
    { questionKind: "rec_batch_sentiment", reply: "these were off" },
    throwing,
  )
  assert.deepEqual(r, AMBIGUOUS_FEEDBACK)
})

test("extractMatchFeedback uses the LLM's structured output", async () => {
  const llm: FeedbackLlmCall = async () => ({
    json: { replyKind: "feedback_answer", sentiment: "positive", intent: "ambiguous", reasonCategory: "none" },
  })
  const r = await extractMatchFeedback(
    { questionKind: "rec_batch_sentiment", reply: "these are great!" },
    llm,
  )
  assert.equal(r.sentiment, "positive")
})

test("empty reply → ambiguous without calling the LLM", async () => {
  let called = false
  const llm: FeedbackLlmCall = async () => {
    called = true
    return { json: {} }
  }
  const r = await extractMatchFeedback({ questionKind: "daily_subscribe", reply: "   " }, llm)
  assert.equal(called, false)
  assert.deepEqual(r, AMBIGUOUS_FEEDBACK)
})

test("SOURCE GUARD: the extractor + retention FSM contain no regex sentiment/keyword classification", () => {
  for (const rel of ["../match-feedback-extractor.ts", "../post-match-retention.ts"]) {
    const raw = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n")
    // The real signals of regex classification: RegExp.test() / String.match() /
    // a RegExp constructor. None may appear in the feedback path. (We don't scan
    // for bare `/.../` literals because the FSM copy contains Chinese strings
    // with `/` separators.)
    assert.equal(/\.test\s*\(/.test(code), false, `${rel}: no RegExp.test() classification`)
    assert.equal(/\.match\s*\(/.test(code), false, `${rel}: no String.match() classification`)
    assert.equal(/\bnew\s+RegExp\b/.test(code), false, `${rel}: no RegExp constructor`)
    // The deleted regex detectors must be gone.
    assert.equal(/detectRecBatchSentiment|detectYesNoIntent/.test(code), false, `${rel}: regex detectors removed`)
  }
})
