import assert from "node:assert/strict"
import test from "node:test"

import {
  decideConversationTurnOwner,
  type OwnerDecision,
  type TurnContext,
} from "./conversation-turn-arbiter.js"
import {
  buildConversationEvidenceWrites,
  decideConversationDeliveryAction,
  summarizeWarmConciseWordingPolicy,
} from "./conversation-action-arbiter.js"

function baseContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    turnId: "turn-action-1",
    userId: "u1",
    inbound: {
      text: "hi",
      createdAt: "2026-05-26T23:11:00.000Z",
      channel: "imessage",
    },
    recentMessages: [],
    recentOutbound: [],
    ...overrides,
  }
}

function decide(context: TurnContext): { ownerDecision: OwnerDecision; action: ReturnType<typeof decideConversationDeliveryAction> } {
  const ownerDecision = decideConversationTurnOwner(context)
  return {
    ownerDecision,
    action: decideConversationDeliveryAction(context, ownerDecision),
  }
}

test("short acknowledgement after async-search status becomes tapback only with no outbound text", () => {
  const context = baseContext({
    inbound: {
      text: "Sure",
      createdAt: "2026-05-26T23:12:00.000Z",
      channel: "imessage",
    },
    recentOutbound: [
      {
        role: "assistant",
        body: "Got it - I’m checking the market now and will come back with roles worth your time.",
        createdAt: "2026-05-26T23:11:30.000Z",
      },
    ],
  })
  const { ownerDecision, action } = decide(context)

  assert.equal(ownerDecision.selectedOwner, "fallback_claire")
  assert.equal(action.selectedAction, "tapback_only")
  assert.equal(action.deliveryPlan.outboundTextRequired, false)
  assert.equal(action.deliveryPlan.reaction, "like")
  assert.ok(action.noOutboundReason)
})

test("short acknowledgement after a recommendation becomes tapback only and records interest evidence", () => {
  const context = baseContext({
    inbound: {
      text: "Sure",
      createdAt: "2026-05-26T23:12:00.000Z",
      channel: "imessage",
    },
    recentOutbound: [
      {
        role: "assistant",
        body: "I found 3 roles that line up with your data analysis lane. See if these fit - if not lmk, I'll keep digging.",
        createdAt: "2026-05-26T23:11:30.000Z",
      },
    ],
  })
  const { ownerDecision, action } = decide(context)
  const writes = buildConversationEvidenceWrites(context, ownerDecision, action)

  assert.equal(ownerDecision.selectedOwner, "fallback_claire")
  assert.equal(action.selectedAction, "tapback_only")
  assert.equal(action.deliveryPlan.outboundTextRequired, false)
  assert.equal(action.deliveryPlan.reaction, "like")
  assert.equal(action.noOutboundReason, "low_information_ack_after_recommendation")
  assert.ok(writes.some((write) => write.kind === "job_interest" && write.operation === "append"))
})

test("short acknowledgement while shared onboarding is active re-asks the slot instead of tapbacking older rec context", () => {
  const context = baseContext({
    inbound: {
      text: "Sure",
      createdAt: "2026-05-26T23:12:00.000Z",
      channel: "imessage",
    },
    sharedOnboarding: {
      active: true,
      currentQuestionId: "main_goal",
    },
    activeWorkflow: {
      kind: "shared_onboarding",
      status: "active",
      currentQuestionId: "main_goal",
    },
    recentOutbound: [
      {
        role: "assistant",
        body: "One role worth your time: Senior Software Engineer at Rain. Tell me if it is interesting, and why or why not.",
        createdAt: "2026-05-26T23:11:30.000Z",
      },
      {
        role: "assistant",
        body: "Before I match roles, what matters most in your next company: career growth, compensation, stability, mission, learning, or something else?",
        createdAt: "2026-05-26T23:11:45.000Z",
      },
    ],
  })
  const { ownerDecision, action } = decide(context)
  const writes = buildConversationEvidenceWrites(context, ownerDecision, action)

  assert.equal(ownerDecision.selectedOwner, "shared_onboarding")
  assert.deepEqual(ownerDecision.orderedActions.map((item) => item.kind), ["clarify_shared_onboarding"])
  assert.equal(action.selectedAction, "answer_then_continue")
  assert.equal(action.deliveryPlan.outboundTextRequired, true)
  assert.equal(action.deliveryPlan.reaction, undefined)
  assert.ok(!writes.some((write) => write.kind === "shared_onboarding_answer"))
  assert.ok(ownerDecision.forbiddenMutations.includes("sharedOnboarding.answers.main_goal"))
})

test("link question plus interest answers the explicit question first and stores job interest evidence", () => {
  const context = baseContext({
    inbound: {
      text: "Do you have a link? Seems fine",
      createdAt: "2026-05-26T23:13:00.000Z",
      channel: "imessage",
    },
    recentOutbound: [
      {
        role: "assistant",
        body: "One role worth your time: Senior Software Engineer at Variance. Tell me if it is interesting, and why or why not.",
        createdAt: "2026-05-26T23:12:30.000Z",
      },
    ],
  })
  const { ownerDecision, action } = decide(context)
  const writes = buildConversationEvidenceWrites(context, ownerDecision, action)

  assert.equal(action.selectedAction, "answer_then_continue")
  assert.ok(action.replyGuidance.some((line) => /answer the explicit question first/i.test(line)))
  assert.ok(writes.some((write) => write.kind === "job_interest" && write.operation === "append"))
})

test("yes after role fit gate advances the workflow and stores a prescreen answer without inventing onboarding evidence", () => {
  const context = baseContext({
    inbound: {
      text: "Yes",
      createdAt: "2026-05-26T23:14:00.000Z",
      channel: "imessage",
    },
    activeWorkflow: {
      kind: "job_prescreen",
      status: "active",
      currentQuestionId: "stack_fit",
    },
    recentOutbound: [
      {
        role: "assistant",
        body: "Before I push this forward, this role leans heavy on React/Next.js with TypeScript. Have you shipped production features in that stack?",
        createdAt: "2026-05-26T23:13:30.000Z",
      },
    ],
  })
  const { ownerDecision, action } = decide(context)
  const writes = buildConversationEvidenceWrites(context, ownerDecision, action)

  assert.equal(ownerDecision.selectedOwner, "active_workflow")
  // F2: an affirmative to a pending question must ADVANCE, not micro_ack/re-ask.
  assert.equal(action.selectedAction, "answer_then_continue")
  assert.ok(
    action.replyGuidance.some((line) => /do not (repeat|re-?ask)/i.test(line)),
    "should instruct not to re-ask the pending question",
  )
  assert.ok(writes.some((write) => write.kind === "prescreen_answer" && write.targetPath.includes("stack_fit")))
  assert.ok(!writes.some((write) => write.kind === "shared_onboarding_answer"))
})

test("F2: bare 'Yes' to a pending workflow question advances instead of re-asking via micro_ack", () => {
  const affirmative = baseContext({
    inbound: { text: "Yes", createdAt: "2026-05-26T23:14:30.000Z", channel: "imessage" },
    activeWorkflow: { kind: "job_prescreen", status: "active", currentQuestionId: "stack_fit" },
    recentOutbound: [
      {
        role: "assistant",
        body: "Have you shipped production features in React/Next.js with TypeScript?",
        createdAt: "2026-05-26T23:14:00.000Z",
      },
    ],
  })
  const affirmativeResult = decide(affirmative)
  assert.equal(affirmativeResult.ownerDecision.selectedOwner, "active_workflow")
  assert.equal(affirmativeResult.action.selectedAction, "answer_then_continue")
  assert.ok(
    affirmativeResult.action.rejectedActions.some((rej) => rej.action === "micro_ack"),
    "micro_ack should be explicitly rejected for an affirmative to a pending question",
  )

  // Guard: a SUBSTANTIVE workflow answer (not a bare affirmative) still micro_acks.
  const substantive = baseContext({
    inbound: {
      text: "Yes, I built the entire payments service end to end with retries and idempotency keys.",
      createdAt: "2026-05-26T23:14:45.000Z",
      channel: "imessage",
    },
    activeWorkflow: { kind: "job_prescreen", status: "active", currentQuestionId: "stack_fit" },
    recentOutbound: [
      {
        role: "assistant",
        body: "Have you shipped production features in React/Next.js with TypeScript?",
        createdAt: "2026-05-26T23:14:00.000Z",
      },
    ],
  })
  assert.equal(decide(substantive).action.selectedAction, "micro_ack")
})

test("F1: short ack to a Claire statement (not a question) becomes tapback only, not a fresh question", () => {
  const context = baseContext({
    inbound: { text: "Ok", createdAt: "2026-05-26T23:20:00.000Z", channel: "imessage" },
    recentOutbound: [
      {
        role: "assistant",
        body: "That role is fully remote and the team is about 40 people right now.",
        createdAt: "2026-05-26T23:19:30.000Z",
      },
    ],
  })
  const { ownerDecision, action } = decide(context)

  assert.equal(ownerDecision.selectedOwner, "fallback_claire")
  assert.equal(action.selectedAction, "tapback_only")
  assert.equal(action.deliveryPlan.outboundTextRequired, false)
  assert.equal(action.deliveryPlan.reaction, "like")
  assert.equal(action.noOutboundReason, "low_information_ack_after_statement")
})

test("F1 guard: short ack to a Claire QUESTION is NOT suppressed to a tapback", () => {
  const context = baseContext({
    inbound: { text: "Yes", createdAt: "2026-05-26T23:21:00.000Z", channel: "imessage" },
    recentOutbound: [
      {
        role: "assistant",
        body: "Are you open to roles that are hybrid in NYC?",
        createdAt: "2026-05-26T23:20:30.000Z",
      },
    ],
  })
  const { action } = decide(context)

  assert.notEqual(action.selectedAction, "tapback_only")
  assert.equal(action.deliveryPlan.outboundTextRequired, true)
})

test("F1 guard: cold-open short ack with no prior assistant turn still gets a real reply", () => {
  const context = baseContext({
    inbound: { text: "Ok", createdAt: "2026-05-26T23:22:00.000Z", channel: "imessage" },
    recentOutbound: [],
    recentMessages: [],
  })
  const { action } = decide(context)

  assert.notEqual(action.selectedAction, "tapback_only")
  assert.equal(action.deliveryPlan.outboundTextRequired, true)
})

test("job search request sends fast status before async matching tool result", () => {
  const context = baseContext({
    inbound: {
      text: "Can you find roles like that in New York?",
      createdAt: "2026-05-26T23:15:00.000Z",
      channel: "imessage",
    },
  })
  const { ownerDecision, action } = decide(context)

  assert.equal(ownerDecision.selectedOwner, "job_search")
  assert.equal(action.selectedAction, "status_then_async_tool")
  assert.ok(action.requiredTraceFields.includes("toolCallIds"))
  assert.ok(action.replyGuidance.some((line) => /status/i.test(line)))
})

test("tool result produces stored evidence and a grounded tool-result reply action", () => {
  const context = baseContext({
    inbound: {
      text: "What did you find?",
      createdAt: "2026-05-26T23:16:00.000Z",
      channel: "imessage",
    },
    toolResults: [
      {
        toolCallId: "tool-1",
        name: "generate_job_recommendations",
        status: "completed",
        resultSummary: "Found one strong role: Senior Software Engineer at Variance.",
      },
    ],
  })
  const ownerDecision: OwnerDecision = {
    selectedOwner: "job_search",
    rejectedOwners: [],
    reason: "Tool result is ready.",
    requiredTools: ["generate_job_recommendations"],
    forbiddenMutations: [],
    intentFrames: [{ intent: "job_search_request", confidence: 0.9, evidenceSpan: "What did you find?", scope: "one_off" }],
    orderedActions: [{ kind: "run_job_search", owner: "job_search", reason: "Tool result ready." }],
  }
  const action = decideConversationDeliveryAction(context, ownerDecision)
  const writes = buildConversationEvidenceWrites(context, ownerDecision, action)

  assert.equal(action.selectedAction, "tool_result_reply")
  assert.deepEqual(action.toolCallIds, ["tool-1"])
  assert.ok(writes.some((write) => write.kind === "tool_result" && write.toolCallId === "tool-1"))
})

test("warm concise wording policy rejects static fit conclusions and corporate wording", () => {
  const policy = summarizeWarmConciseWordingPolicy()

  assert.ok(policy.required.includes("answer_explicit_question_first"))
  assert.ok(policy.required.includes("one_idea_per_bubble"))
  assert.ok(policy.forbiddenPhrases.includes("overall fit looks low"))
  assert.ok(policy.forbiddenPhrases.includes("optimize your candidacy"))
})
