import assert from "node:assert/strict"
import test from "node:test"

import {
  decideConversationTurnOwner,
  summarizeConversationTurnTrace,
  type TurnContext,
} from "./conversation-turn-arbiter.js"

function baseContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    turnId: "turn-1",
    userId: "u1",
    inbound: {
      text: "hi",
      createdAt: "2026-05-26T22:39:04.000Z",
      channel: "imessage",
    },
    recentMessages: [],
    recentOutbound: [],
    ...overrides,
  }
}

test("arbiter routes Rain fit-improvement question to prescreen outcome explainer instead of shared onboarding", () => {
  const decision = decideConversationTurnOwner(baseContext({
    inbound: {
      text: "Could you help me understand how I could have improved my fit for the above role at Rain?",
      createdAt: "2026-05-26T22:39:04.000Z",
      channel: "imessage",
    },
    sharedOnboarding: {
      active: true,
      currentQuestionId: "industry_interest",
    },
    prescreenEvidence: {
      sessionId: "ps-rain",
      jobId: "rain-product-manager-cards-95ae1a01",
      terminal: "PAUSE",
      summary:
        "Strong PM role fit: end-to-end ownership, integrations, and 3X lead lift. Mentions technical data-flow design and failure handling; lacks concrete implementation depth.",
      evidenceTags: ["product_management", "technical_depth_gap"],
    },
  }))

  assert.equal(decision.selectedOwner, "prescreen_outcome_explainer")
  assert.equal(decision.intentFrames[0]?.intent, "prescreen_outcome_question")
  assert.ok(decision.requiredTools.includes("load_prescreen_evidence"))
  assert.ok(decision.forbiddenMutations.includes("sharedOnboarding.answers.industry_interest"))
  assert.ok(
    decision.rejectedOwners.some((owner) =>
      owner.owner === "shared_onboarding" && /not an answer/i.test(owner.reason)
    ),
  )
})

test("arbiter treats negative role feedback as durable preference before matching", () => {
  const decision = decideConversationTurnOwner(baseContext({
    inbound: {
      text: "Not software developer roles. Product and strategy only, please.",
      createdAt: "2026-05-26T23:01:00.000Z",
      channel: "imessage",
    },
    recentOutbound: [{ role: "assistant", body: "I found two software developer roles.", createdAt: "2026-05-26T23:00:00.000Z" }],
  }))

  assert.equal(decision.selectedOwner, "durable_preference_update")
  assert.equal(decision.intentFrames[0]?.scope, "durable")
  assert.ok(decision.requiredTools.includes("semantic_preference_extraction"))
  assert.deepEqual(decision.orderedActions.map((action) => action.kind), [
    "extract_durable_preferences",
    "commit_memory",
  ])
})

test("arbiter keeps active prescreen answers in the active workflow", () => {
  const decision = decideConversationTurnOwner(baseContext({
    inbound: {
      text: "I designed the CRM sync schema and added retry jobs for failed writes.",
      createdAt: "2026-05-26T22:37:00.000Z",
      channel: "imessage",
    },
    activeWorkflow: {
      kind: "job_prescreen",
      status: "active",
      currentQuestionId: "technical_depth",
    },
  }))

  assert.equal(decision.selectedOwner, "active_workflow")
  assert.equal(decision.intentFrames[0]?.intent, "active_workflow_answer")
  assert.ok(decision.requiredTools.includes("prescreen_turn_handler"))
})

test("arbiter blocks ambiguous shared-onboarding non-answers from advancing the active slot", () => {
  const decision = decideConversationTurnOwner(baseContext({
    inbound: {
      text: "I am not sure what you mean by that.",
      createdAt: "2026-05-26T23:05:00.000Z",
      channel: "imessage",
    },
    sharedOnboarding: {
      active: true,
      currentQuestionId: "location_relocation",
    },
  }))

  assert.equal(decision.selectedOwner, "fallback_claire")
  assert.ok(decision.forbiddenMutations.includes("sharedOnboarding.answers.location_relocation"))
  assert.ok(
    decision.rejectedOwners.some((owner) =>
      owner.owner === "shared_onboarding" && /not an answer/i.test(owner.reason)
    ),
  )
})

test("arbiter accepts concrete shared-onboarding role and special-context answers", () => {
  const mainGoal = decideConversationTurnOwner(baseContext({
    inbound: {
      text: "Software engineering, ideally backend or platform.",
      createdAt: "2026-05-26T23:06:00.000Z",
      channel: "imessage",
    },
    sharedOnboarding: {
      active: true,
      currentQuestionId: "main_goal",
    },
  }))
  const specialContext = decideConversationTurnOwner(baseContext({
    inbound: {
      text: "I need to move fast because severance ends soon, and backend systems are my strongest area.",
      createdAt: "2026-05-26T23:07:00.000Z",
      channel: "imessage",
    },
    sharedOnboarding: {
      active: true,
      currentQuestionId: "special_context",
    },
  }))

  assert.equal(mainGoal.selectedOwner, "shared_onboarding")
  assert.ok(mainGoal.requiredTools.includes("shared_onboarding_writer"))
  assert.equal(specialContext.selectedOwner, "shared_onboarding")
  assert.ok(specialContext.requiredTools.includes("shared_onboarding_writer"))
})

test("arbiter orders multi-intent prescreen explanation before durable preference commit", () => {
  const decision = decideConversationTurnOwner(baseContext({
    inbound: {
      text: "Why was Rain paused, and please stop sending software developer roles; product strategy only.",
      createdAt: "2026-05-26T23:08:00.000Z",
      channel: "imessage",
    },
    sharedOnboarding: {
      active: true,
      currentQuestionId: "industry_interest",
    },
    prescreenEvidence: {
      sessionId: "ps-rain",
      jobId: "rain-product-manager-cards-95ae1a01",
      terminal: "PAUSE",
      summary: "Good product evidence; technical implementation depth was still thin.",
      evidenceTags: ["technical_depth_gap"],
    },
  }))

  assert.equal(decision.selectedOwner, "prescreen_outcome_explainer")
  assert.deepEqual(decision.orderedActions.map((action) => action.kind), [
    "answer_prescreen_outcome",
    "extract_durable_preferences",
    "commit_memory",
  ])
})

test("arbiter trace records the state machine and selected owner", () => {
  const decision = decideConversationTurnOwner(baseContext({
    inbound: {
      text: "Fintech and AI infrastructure.",
      createdAt: "2026-05-26T23:09:00.000Z",
      channel: "imessage",
    },
    sharedOnboarding: {
      active: true,
      currentQuestionId: "industry_interest",
    },
  }))
  const trace = summarizeConversationTurnTrace(baseContext(), decision)

  assert.equal(decision.selectedOwner, "shared_onboarding")
  assert.deepEqual(trace.states, [
    "received",
    "context_loaded",
    "intent_framed",
    "owner_arbitrated",
    "action_planned",
    "tools_executed",
    "memory_committed",
    "outbound_composed",
    "completed",
  ])
  assert.equal(trace.decision.selectedOwner, "shared_onboarding")
})
