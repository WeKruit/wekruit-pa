import type {
  ConversationOwner,
  OwnerDecision,
  TurnContext,
} from "./conversation-turn-arbiter.js"

export type ConversationDeliveryAction =
  | "no_response"
  | "tapback_only"
  | "micro_ack"
  | "answer_then_continue"
  | "status_then_async_tool"
  | "tool_result_reply"
  | "fit_gate_question"
  | "rich_recommendation_summary"

export type ConversationEvidenceKind =
  | "shared_onboarding_answer"
  | "durable_preference"
  | "prescreen_answer"
  | "job_interest"
  | "tool_result"

export type ConversationEvidenceWrite = {
  kind: ConversationEvidenceKind
  sourceTurnId: string
  sourceMessageId?: string
  owner: ConversationOwner
  action: ConversationDeliveryAction
  toolCallId?: string
  evidenceSpan: string
  confidence: number
  scope: "durable" | "one_off" | "workflow"
  operation: "set" | "append" | "remove" | "clarify"
  targetPath: string
  value: unknown
}

export type RejectedConversationAction = {
  action: ConversationDeliveryAction
  reason: string
}

export type ConversationDeliveryPlan = {
  outboundTextRequired: boolean
  reaction?: "like" | "love" | "emphasize" | "laugh" | "question"
  statusText?: string
}

export type ConversationActionDecision = {
  selectedAction: ConversationDeliveryAction
  rejectedActions: RejectedConversationAction[]
  reason: string
  deliveryPlan: ConversationDeliveryPlan
  replyGuidance: string[]
  requiredTraceFields: string[]
  noOutboundReason?: string
  toolCallIds: string[]
}

export type WarmConciseWordingPolicy = {
  required: string[]
  forbiddenPhrases: string[]
  guidance: string[]
}

export function decideConversationDeliveryAction(
  context: TurnContext,
  ownerDecision: OwnerDecision,
): ConversationActionDecision {
  const rejectedActions: RejectedConversationAction[] = []
  const text = normalize(context.inbound.text)
  const toolCallIds = collectCompletedToolCallIds(context)

  if (toolCallIds.length > 0) {
    return actionDecision({
      selectedAction: "tool_result_reply",
      rejectedActions,
      reason: "Completed tool output is available; compose a grounded answer from stored tool evidence.",
      deliveryPlan: { outboundTextRequired: true },
      replyGuidance: [
        "Answer from the tool result, not from generic memory.",
        "Mention the concrete result before asking the next step.",
      ],
      requiredTraceFields: ["toolCallIds", "evidenceWrites", "outboundSource"],
      toolCallIds,
    })
  }

  if (isLinkQuestionWithInterest(text)) {
    return actionDecision({
      selectedAction: "answer_then_continue",
      rejectedActions,
      reason: "User asked for a link while also giving interest feedback; answer the question before any follow-up gate.",
      deliveryPlan: { outboundTextRequired: true },
      replyGuidance: [
        "Answer the explicit question first.",
        "Then ask one role-specific fit gate only if needed before forwarding.",
      ],
      requiredTraceFields: ["evidenceWrites", "outboundSource"],
      toolCallIds,
    })
  }

  if (ownerDecision.selectedOwner === "prescreen_outcome_explainer") {
    return actionDecision({
      selectedAction: "answer_then_continue",
      rejectedActions,
      reason: "Prescreen outcome questions need a concrete explanation before any workflow continuation.",
      deliveryPlan: { outboundTextRequired: true },
      replyGuidance: [
        "Answer the user’s fit question first.",
        "Use prescreen evidence and one specific improvement point.",
        "Do not send a generic location or onboarding question in the same turn.",
      ],
      requiredTraceFields: ["evidenceWrites", "outboundSource"],
      toolCallIds,
    })
  }

  if (
    ownerDecision.selectedOwner === "job_search" ||
    ownerDecision.orderedActions.some((action) => action.kind === "run_job_search")
  ) {
    return actionDecision({
      selectedAction: "status_then_async_tool",
      rejectedActions,
      reason: "Matching/search is tool-backed and may take time, so Claire should acknowledge quickly before the tool result.",
      deliveryPlan: {
        outboundTextRequired: true,
        statusText: "Got it. I’m checking that against the roles now.",
      },
      replyGuidance: [
        "Send a concise status before tool work if matching is not immediate.",
        "When the result is ready, present one focused role with why it is worth attention.",
      ],
      requiredTraceFields: ["toolCallIds", "evidenceWrites", "outboundSource"],
      toolCallIds,
    })
  }

  if (ownerDecision.selectedOwner === "durable_preference_update") {
    return actionDecision({
      selectedAction: "micro_ack",
      rejectedActions,
      reason: "Durable preference update should be acknowledged briefly after evidence is stored.",
      deliveryPlan: { outboundTextRequired: true },
      replyGuidance: [
        "Acknowledge the preference in one short sentence.",
        "Do not run matching until the preference write is committed.",
      ],
      requiredTraceFields: ["evidenceWrites", "outboundSource"],
      toolCallIds,
    })
  }

  if (ownerDecision.selectedOwner === "active_workflow") {
    if (isAffirmativeReply(text) && immediatelyPrecedingAssistantExpectsAnswer(context)) {
      rejectedActions.push({
        action: "micro_ack",
        reason: "An affirmative to a pending workflow question must advance, not re-ask the same prompt as a bare acknowledgment.",
      })
      return actionDecision({
        selectedAction: "answer_then_continue",
        rejectedActions,
        reason: "User gave an affirmative answer to the pending workflow question; advance the workflow instead of re-asking it.",
        deliveryPlan: { outboundTextRequired: true },
        replyGuidance: [
          "Treat the affirmative as the answer to the pending question; do not repeat that question.",
          "Store the answer, then advance to the next workflow step or question.",
        ],
        requiredTraceFields: ["evidenceWrites", "outboundSource"],
        toolCallIds,
      })
    }
    return actionDecision({
      selectedAction: "micro_ack",
      rejectedActions,
      reason: "Active workflow answer should be stored and acknowledged without over-explaining.",
      deliveryPlan: { outboundTextRequired: true },
      replyGuidance: [
        "Store the active workflow answer before composing the next prompt.",
        "Keep any acknowledgment brief and specific to the prior question.",
      ],
      requiredTraceFields: ["evidenceWrites", "outboundSource"],
      toolCallIds,
    })
  }

  if (ownerDecision.selectedOwner === "shared_onboarding") {
    if (ownerDecision.orderedActions.some((action) => action.kind === "clarify_shared_onboarding")) {
      return actionDecision({
        selectedAction: "answer_then_continue",
        rejectedActions,
        reason: "Active shared onboarding needs a clarifying re-ask, not a recommendation tapback or slot mutation.",
        deliveryPlan: { outboundTextRequired: true },
        replyGuidance: [
          "Do not store the unclear reply as an onboarding answer.",
          "Briefly re-ask the active onboarding slot in natural language.",
          "Do not infer recommendation interest from older messages.",
        ],
        requiredTraceFields: ["noForbiddenMutations", "outboundSource"],
        toolCallIds,
      })
    }
    return actionDecision({
      selectedAction: "answer_then_continue",
      rejectedActions,
      reason: "Shared onboarding answer can advance only after slot evidence is committed.",
      deliveryPlan: { outboundTextRequired: true },
      replyGuidance: [
        "Store the slot answer first.",
        "Ask only the next active slot; do not ask multiple questions.",
      ],
      requiredTraceFields: ["evidenceWrites", "outboundSource"],
      toolCallIds,
    })
  }

  if (
    isShortLowInformationAck(text) &&
    (recentAssistantSaidToolWorkIsInProgress(context) ||
      (hasAssistantContext(context) &&
        !immediatelyPrecedingAssistantExpectsAnswer(context) &&
        // Defer to the recommendation-decision gate below, which records the
        // short ack as recommendation-interest evidence rather than a bare
        // statement ack. Both are tapback_only, but the recommendation path
        // carries extra evidence we must not drop.
        !recentAssistantAskedForRecommendationDecision(context)))
  ) {
    const afterStatus = recentAssistantSaidToolWorkIsInProgress(context)
    rejectedActions.push(
      {
        action: "micro_ack",
        reason: afterStatus
          ? "A text acknowledgment would add noise after an already-clear status update."
          : "A text acknowledgment to a short ack on a statement would push an unsolicited new question.",
      },
      { action: "status_then_async_tool", reason: "Tool/search status was already sent in the previous assistant turn." },
    )
    return actionDecision({
      selectedAction: "tapback_only",
      rejectedActions,
      reason: afterStatus
        ? "Short low-information acknowledgment after an in-progress status is best handled as a reaction."
        : "Short low-information acknowledgment to a Claire statement (not a question) is best handled as a reaction, not a fresh question.",
      deliveryPlan: { outboundTextRequired: false, reaction: "like" },
      noOutboundReason: afterStatus ? "low_information_ack_after_status" : "low_information_ack_after_statement",
      replyGuidance: [
        "Do not send a text reply.",
        "Use a like tapback when the channel supports reactions.",
      ],
      requiredTraceFields: ["noOutboundReason", "deliveryPlan"],
      toolCallIds,
    })
  }

  if (
    isShortLowInformationAck(text) &&
    recentAssistantAskedForRecommendationDecision(context) &&
    !immediatelyPrecedingAssistantExpectsAnswer(context)
  ) {
    rejectedActions.push(
      { action: "micro_ack", reason: "A text acknowledgment would repeat the candidate's short recommendation signal." },
      { action: "rich_recommendation_summary", reason: "Claire already sent the recommendation summary." },
    )
    return actionDecision({
      selectedAction: "tapback_only",
      rejectedActions,
      reason: "Short low-information acknowledgment after a recommendation is an interest signal, not a request for another text reply.",
      deliveryPlan: { outboundTextRequired: false, reaction: "like" },
      noOutboundReason: "low_information_ack_after_recommendation",
      replyGuidance: [
        "Do not send a text reply.",
        "Use a like tapback when the channel supports reactions.",
        "Record the short acknowledgement as recommendation interest evidence.",
      ],
      requiredTraceFields: ["noOutboundReason", "deliveryPlan", "evidenceWrites"],
      toolCallIds,
    })
  }

  if (ownerDecision.selectedOwner === "safety_control") {
    return actionDecision({
      selectedAction: "answer_then_continue",
      rejectedActions,
      reason: "Control/privacy turns need explicit confirmation.",
      deliveryPlan: { outboundTextRequired: true },
      replyGuidance: ["Answer the control/privacy instruction directly and avoid unrelated workflow continuation."],
      requiredTraceFields: ["outboundSource"],
      toolCallIds,
    })
  }

  return actionDecision({
    selectedAction: "answer_then_continue",
    rejectedActions,
    reason: "Default Claire reply should answer the turn directly.",
    deliveryPlan: { outboundTextRequired: true },
    replyGuidance: ["Answer the user’s explicit question first, then continue only if useful."],
    requiredTraceFields: ["outboundSource"],
    toolCallIds,
  })
}

export function buildConversationEvidenceWrites(
  context: TurnContext,
  ownerDecision: OwnerDecision,
  actionDecision: ConversationActionDecision,
): ConversationEvidenceWrite[] {
  const text = context.inbound.text.trim()
  const writes: ConversationEvidenceWrite[] = []
  const base = {
    sourceTurnId: context.turnId,
    owner: ownerDecision.selectedOwner,
    action: actionDecision.selectedAction,
    evidenceSpan: text.slice(0, 240),
  }

  if (ownerDecision.selectedOwner === "shared_onboarding" && context.sharedOnboarding?.currentQuestionId) {
    const targetPath = `sharedOnboarding.answers.${context.sharedOnboarding.currentQuestionId}`
    if (!ownerDecision.forbiddenMutations.includes(targetPath)) {
      writes.push({
        ...base,
        kind: "shared_onboarding_answer",
        confidence: highestIntentConfidence(ownerDecision, "shared_onboarding_answer", 0.81),
        scope: "workflow",
        operation: "set",
        targetPath,
        value: text,
      })
    }
  }

  if (ownerDecision.selectedOwner === "active_workflow" && context.activeWorkflow?.kind === "job_prescreen") {
    const qid = context.activeWorkflow.currentQuestionId ?? "current"
    writes.push({
      ...base,
      kind: "prescreen_answer",
      confidence: highestIntentConfidence(ownerDecision, "active_workflow_answer", 0.84),
      scope: "workflow",
      operation: "set",
      targetPath: `prescreen.sessions.${context.prescreenEvidence?.sessionId ?? "active"}.answers.${qid}`,
      value: {
        answer: text,
        questionId: qid,
      },
    })
  }

  if (ownerDecision.selectedOwner === "durable_preference_update" || ownerDecision.orderedActions.some((action) => action.kind === "commit_memory")) {
    writes.push({
      ...base,
      kind: "durable_preference",
      confidence: highestIntentConfidence(ownerDecision, "durable_preference_update", 0.86),
      scope: "durable",
      operation: inferPreferenceOperation(text),
      targetPath: "pa-users.conversationDerivedPreferences",
      value: text,
    })
  }

  if (isLinkQuestionWithInterest(normalize(text))) {
    writes.push({
      ...base,
      kind: "job_interest",
      confidence: 0.78,
      scope: "one_off",
      operation: "append",
      targetPath: "pa-candidate-job-states.current.interestSignals",
      value: {
        text,
        askedForLink: true,
      },
    })
  }

  if (
    actionDecision.selectedAction === "tapback_only" &&
    actionDecision.noOutboundReason === "low_information_ack_after_recommendation"
  ) {
    writes.push({
      ...base,
      kind: "job_interest",
      confidence: 0.72,
      scope: "one_off",
      operation: "append",
      targetPath: "pa-candidate-job-states.current.interestSignals",
      value: {
        text,
        signal: "short_ack_after_recommendation",
        acknowledged: true,
        recentRecommendation: latestRecommendationPrompt(context),
      },
    })
  }

  for (const result of context.toolResults ?? []) {
    if (result.status !== "completed") continue
    writes.push({
      ...base,
      kind: "tool_result",
      toolCallId: result.toolCallId,
      confidence: 1,
      scope: "one_off",
      operation: "append",
      targetPath: `pa-tool-calls.${result.toolCallId}.conversationEvidence`,
      value: {
        name: result.name,
        resultSummary: result.resultSummary,
      },
    })
  }

  return writes
}

export function summarizeWarmConciseWordingPolicy(): WarmConciseWordingPolicy {
  return {
    required: [
      "answer_explicit_question_first",
      "one_idea_per_bubble",
      "use_available_evidence",
      "ask_one_followup",
      "concrete_fit_feedback",
    ],
    forbiddenPhrases: [
      "overall fit looks low",
      "optimize your candidacy",
      "leverage your background",
      "circle back",
      "synergy",
      "as an AI",
    ],
    guidance: [
      "Warm concise voice: human, fast, specific, lightly conversational.",
      "Do not copy Standout’s lowercase or slang-heavy tone.",
      "Use short transitions such as Got it, Makes sense, or I’m checking that now.",
      "For role forwarding, ask role-specific gates before saying Claire can push the candidate forward.",
    ],
  }
}

function actionDecision(input: ConversationActionDecision): ConversationActionDecision {
  return input
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim()
}

function isShortLowInformationAck(text: string): boolean {
  return /^(sure|ok|okay|k|yes|yep|yeah|sounds good|fine|great|cool|👍|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿)[.!]*$/i.test(text)
}

/**
 * Affirmative short reply ("yes", "yep", "sure", "sounds good", "absolutely", …).
 * Used to distinguish a yes/no answer to a pending question from a substantive
 * workflow answer, so an affirmative ADVANCES the workflow rather than being
 * acknowledged with a bare micro-ack that re-asks the same question.
 */
function isAffirmativeReply(text: string): boolean {
  return /^(yes|yep|yeah|yup|ya|yah|sure|absolutely|definitely|of course|ok|okay|k|sounds good|sg|for sure|i have|i did|i do|yes i have|yep i have|yeah i have)[.! ]*$/i.test(
    text.trim(),
  )
}

function recentAssistantSaidToolWorkIsInProgress(context: TurnContext): boolean {
  const recent = [...(context.recentOutbound ?? []), ...(context.recentMessages ?? [])]
    .filter((message) => message.role === "assistant" && message.body.trim())
    .slice(-4)
  return recent.some((message) => {
    const body = normalize(message.body)
    return (
      /\b(checking|running|searching|looking|pulling|matching|scan|come back|will come back|roles worth your time)\b/i.test(body) &&
      !body.includes("?")
    )
  })
}

function recentAssistantAskedForRecommendationDecision(context: TurnContext): boolean {
  return recentAssistantBodies(context).some((body) => {
    const recommendation = /\b(found|recommend|role|roles|job|posting|worth your time|line up|fit|forward)\b/i.test(body)
    const decisionPrompt = /\b(see if|if (these|this) fit|lmk|let me know|interesting|why or why not|want me to|push this|move forward)\b/i.test(body)
    return recommendation && decisionPrompt
  })
}

/**
 * True when the LAST thing Claire said was a direct question or an offer/CTA that
 * expects a yes/no answer (e.g. "I can help you prep... — yes?", "want me to push
 * this forward?", "does this look worth a quick screen?"). In that case a short
 * "Yes"/"Sure" is the ANSWER and must be replied to — not suppressed to a tapback,
 * which would dead-end the conversation.
 */
function immediatelyPrecedingAssistantExpectsAnswer(context: TurnContext): boolean {
  const body = mostRecentAssistantBody(context)
  if (!body) return false
  if (body.trim().endsWith("?")) return true
  return /\b(i can help|i can|want me to|do you want|should i|would you like|ready to|are you (open|comfortable|down)|let me know if you( want| 'd like)?|shall i|can i)\b/i.test(body)
}

/**
 * True when there is at least one prior assistant message in context. Guards the
 * "short ack to a statement → tapback" branch so a cold-open short ack (no prior
 * assistant turn) still gets a real reply instead of a silent tapback.
 */
function hasAssistantContext(context: TurnContext): boolean {
  return mostRecentAssistantBody(context) !== null
}

function mostRecentAssistantBody(context: TurnContext): string | null {
  const recent = [...(context.recentOutbound ?? []), ...(context.recentMessages ?? [])]
    .filter((message) => message.role === "assistant" && message.body.trim())
  const sorted = recent
    .slice()
    .sort((a, b) => assistantMessageOrder(a) - assistantMessageOrder(b))
  const last = sorted.at(-1)
  return last ? normalize(last.body) : null
}

function assistantMessageOrder(message: { createdAt?: string }): number {
  const ts = message.createdAt ? Date.parse(message.createdAt) : Number.NaN
  return Number.isFinite(ts) ? ts : 0
}

function latestRecommendationPrompt(context: TurnContext): string | null {
  const body = recentAssistantBodies(context).find((candidate) => {
    const recommendation = /\b(found|recommend|role|roles|job|posting|worth your time|line up|fit|forward)\b/i.test(candidate)
    const decisionPrompt = /\b(see if|if (these|this) fit|lmk|let me know|interesting|why or why not|want me to|push this|move forward)\b/i.test(candidate)
    return recommendation && decisionPrompt
  })
  return body ? body.slice(0, 320) : null
}

function recentAssistantBodies(context: TurnContext): string[] {
  return [...(context.recentOutbound ?? []), ...(context.recentMessages ?? [])]
    .filter((message) => message.role === "assistant" && message.body.trim())
    .slice(-6)
    .map((message) => normalize(message.body))
    .reverse()
}

function isLinkQuestionWithInterest(text: string): boolean {
  const asksForLink = /\b(link|url|job post|posting|details)\b/i.test(text) && text.includes("?")
  const interest = /\b(seems fine|fine|interesting|interested|worth|looks good|sounds good)\b/i.test(text)
  return asksForLink && interest
}

function collectCompletedToolCallIds(context: TurnContext): string[] {
  return (context.toolResults ?? [])
    .filter((result) => result.status === "completed" && result.toolCallId.trim())
    .map((result) => result.toolCallId)
}

function highestIntentConfidence(ownerDecision: OwnerDecision, intent: string, fallback: number): number {
  const frame = ownerDecision.intentFrames
    .filter((item) => item.intent === intent)
    .sort((a, b) => b.confidence - a.confidence)[0]
  return frame?.confidence ?? fallback
}

function inferPreferenceOperation(text: string): ConversationEvidenceWrite["operation"] {
  const value = normalize(text)
  if (/\b(no|not|don't|do not|stop|avoid|exclude)\b/i.test(value)) return "remove"
  if (/\b(only|prefer|preference|rather|instead)\b/i.test(value)) return "set"
  return "append"
}
