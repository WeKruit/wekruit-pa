/**
 * Tests for the unified context-aware conversational tagging interface
 * (Adam 顶层设计, 2026-05-30). ONE entry point, routed by purpose, LLM-driven,
 * validated against shared-tags closed enums — no regex.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  extractFromConversation,
  type ConversationLlmCall,
} from "../conversation-tagging.js"

function stub(json: Record<string, unknown>): ConversationLlmCall {
  return async () => ({ json })
}

test("onboarding_slot → canonical tag deltas routed to pa-users.tags (OR + hardness)", async () => {
  const llm = stub({
    tagDeltas: {
      companySize: ["early_startup", "enterprise"],
      minSalary: 140000,
      preferenceHardness: { salary: { hardness: "soft", bufferPct: 0.07 } },
    },
  })
  const r = await extractFromConversation(
    { purpose: "onboarding_slot", onboardingSlot: "culture_stage" },
    "a small startup or big tech, need 140k but could flex to 130",
    llm,
  )
  assert.deepEqual(r.tagDeltas.companySize, ["early_startup", "enterprise"])
  assert.equal(r.tagDeltas.minSalary, 140000)
  const ph = (r.tagDeltas as { preferenceHardness?: Record<string, { hardness?: string; bufferPct?: number; source?: string }> }).preferenceHardness ?? {}
  assert.equal(ph.salary?.hardness, "soft")
  assert.equal(ph.salary?.bufferPct, 0.07)
  assert.equal(ph.salary?.source, "onboarding")
  assert.deepEqual(r.hardnessDeltas, ph)
  assert.deepEqual(r.routedWrites, [{ target: "pa_users_tags", reason: "onboarding_slot" }])
  assert.deepEqual(r.feedbackEvents, [])
})

test("post_rec_feedback → feedback event (sentiment+reason) + tag deltas + both routes", async () => {
  const llm = stub({
    replyKind: "feedback_answer",
    sentiment: "negative",
    reasonCategory: "wrong_industry",
    tagDeltas: {
      industrySector: ["healthcare_and_life_sciences"],
      negativeIndustrySector: ["financial_technology"],
    },
  })
  const r = await extractFromConversation(
    { purpose: "post_rec_feedback", recommendation: { jobId: "job-123", role: "SWE" } },
    "all fintech, I'm actually into healthcare",
    llm,
  )
  assert.equal(r.feedbackEvents.length, 1)
  assert.equal(r.feedbackEvents[0].sentiment, "negative")
  assert.equal(r.feedbackEvents[0].reasonCategory, "wrong_industry")
  assert.equal(r.feedbackEvents[0].recommendation?.jobId, "job-123")
  assert.deepEqual(r.tagDeltas.industrySector, ["healthcare_and_life_sciences"])
  assert.deepEqual(r.tagDeltas.negativeIndustrySector, ["financial_technology"])
  const targets = r.routedWrites.map((w) => w.target).sort()
  assert.deepEqual(targets, ["feedback_event", "pa_users_tags"])
})

test("post_rec_feedback carries replyKind for yield routing", async () => {
  const llm = stub({ replyKind: "explicit_question", sentiment: "ambiguous" })
  const r = await extractFromConversation(
    { purpose: "post_rec_feedback" },
    "what preferences did you save for me?",
    llm,
  )
  assert.equal(r.feedbackEvents[0].replyKind, "explicit_question")
})

test("job_preference_change → durable tags to pa-users.tags", async () => {
  const llm = stub({ tagDeltas: { targetRoleFunction: ["product_management"], negativeRoleFunction: ["software_engineering"] } })
  const r = await extractFromConversation(
    { purpose: "job_preference_change" },
    "product strategy only, not engineering",
    llm,
  )
  assert.deepEqual(r.tagDeltas.targetRoleFunction, ["product_management"])
  assert.deepEqual(r.tagDeltas.negativeRoleFunction, ["software_engineering"])
  assert.deepEqual(r.routedWrites, [{ target: "pa_users_tags", reason: "job_preference_change" }])
})

test("off-vocab picks are dropped (closed-enum validation, no regex)", async () => {
  const llm = stub({ tagDeltas: { industrySector: ["healthcare_and_life_sciences", "made_up"] } })
  const r = await extractFromConversation({ purpose: "freeform_chat" }, "healthcare", llm)
  assert.deepEqual(r.tagDeltas.industrySector, ["healthcare_and_life_sciences"])
})

test("no llm / empty message → empty result (never throws)", async () => {
  const empty = await extractFromConversation({ purpose: "onboarding_slot" }, "", stub({}))
  assert.deepEqual(empty.tagDeltas, {})
  assert.deepEqual(empty.routedWrites, [])
  const noLlm = await extractFromConversation({ purpose: "onboarding_slot" }, "hi", undefined)
  assert.deepEqual(noLlm.tagDeltas, {})
})
