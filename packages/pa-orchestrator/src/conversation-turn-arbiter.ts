import type {
  ConversationActionDecision,
  ConversationEvidenceWrite,
} from "./conversation-action-arbiter.js"
import type { TurnIntentResult } from "./turn-intent-extractor.js"

export type TurnState =
  | "received"
  | "context_loaded"
  | "intent_framed"
  | "owner_arbitrated"
  | "action_planned"
  | "tools_executed"
  | "memory_committed"
  | "outbound_composed"
  | "completed"

export type TurnIntent =
  | "safety_control"
  | "explicit_meta_question"
  | "prescreen_outcome_question"
  | "durable_preference_update"
  | "job_search_request"
  | "active_workflow_answer"
  | "shared_onboarding_answer"
  | "shared_onboarding_clarification"
  | "fallback_claire"

export type ConversationOwner =
  | "safety_control"
  | "explicit_explanation"
  | "prescreen_outcome_explainer"
  | "durable_preference_update"
  | "job_search"
  | "active_workflow"
  | "shared_onboarding"
  | "post_match_retention"
  | "fallback_claire"

export type RequiredTool =
  | "load_prescreen_evidence"
  | "prescreen_turn_handler"
  | "semantic_preference_extraction"
  | "commit_memory"
  | "generate_job_recommendations"
  | "shared_onboarding_writer"

export type ArbiterActionKind =
  | "answer_prescreen_outcome"
  | "extract_durable_preferences"
  | "commit_memory"
  | "run_job_search"
  | "route_active_workflow"
  | "write_shared_onboarding_answer"
  | "clarify_shared_onboarding"
  | "fallback_reply"
  | "safety_control"

export type TurnContext = {
  turnId: string
  userId: string
  inbound: {
    text: string
    createdAt?: string
    channel?: string
  }
  activeWorkflow?: {
    kind: "job_prescreen" | "shared_onboarding" | "post_match_retention" | "generic"
    status?: string
    currentQuestionId?: string | null
  } | null
  recentOutbound?: Array<{
    role?: "assistant" | "user" | "system"
    body: string
    createdAt?: string
  }>
  recentMessages?: Array<{
    role?: "assistant" | "user" | "system"
    body: string
    createdAt?: string
  }>
  prescreenEvidence?: PrescreenEvidence | null
  sharedOnboarding?: {
    active: boolean
    currentQuestionId?: string | null
  } | null
  preferenceState?: Record<string, unknown> | null
  toolResults?: Array<{
    toolCallId: string
    name: string
    status: "completed" | "failed" | "pending"
    resultSummary?: string
  }>
  /**
   * 2026-06-05 regex→LLM-intent migration (Target A). When present (and
   * `available`), `buildIntentFrames` derives the MEANING signals (meta /
   * prescreen-outcome / durable-pref / job-search / acknowledgment / confusion)
   * from these LLM labels instead of the regex predicates. STATE guards
   * (prescreenEvidence, activeWorkflow status, sharedOnboarding active) are
   * still applied deterministically by `framesFromLlmIntent`. SAFETY/marker
   * regexes are NOT migrated and still run unconditionally.
   *
   * Computed only for canary cohort (flag `paTurnIntentLlmEnabled`) at the
   * orchestrator call site; off-flag / unavailable → undefined → regex path.
   */
  llmIntent?: TurnIntentResult | null
  /**
   * A8 delegation: the result of the existing `judgeSharedOnboardingAnswer`
   * LLM judge (computed at the call site when shared onboarding is active).
   * When non-null it REPLACES the `isSharedOnboardingSlotAnswer` keyword bank
   * for deciding shared_onboarding_answer / clarification / slot-suppression.
   * Null/undefined → fall back to the regex slot-answer predicate (today's path).
   */
  sharedOnboardingAnswerAccepted?: boolean | null
}

export type PrescreenEvidence = {
  sessionId: string
  jobId?: string
  terminal?: string
  summary?: string
  evidenceTags?: string[]
}

export type IntentFrame = {
  intent: TurnIntent
  confidence: number
  evidenceSpan: string
  scope: "durable" | "one_off" | "workflow"
}

export type RejectedOwner = {
  owner: ConversationOwner
  reason: string
}

export type OwnerDecision = {
  selectedOwner: ConversationOwner
  rejectedOwners: RejectedOwner[]
  reason: string
  requiredTools: RequiredTool[]
  forbiddenMutations: string[]
  intentFrames: IntentFrame[]
  orderedActions: Array<{ kind: ArbiterActionKind; owner: ConversationOwner; reason: string }>
}

export type TurnTrace = {
  traceVersion: 1
  turnId: string
  userId: string
  states: TurnState[]
  decision: OwnerDecision
  actionDecision?: ConversationActionDecision
  evidenceWrites?: ConversationEvidenceWrite[]
  inbound: {
    text: string
    createdAt?: string
    channel?: string
  }
}

const TRACE_STATES: TurnState[] = [
  "received",
  "context_loaded",
  "intent_framed",
  "owner_arbitrated",
  "action_planned",
  "tools_executed",
  "memory_committed",
  "outbound_composed",
  "completed",
]

export function decideConversationTurnOwner(context: TurnContext): OwnerDecision {
  const text = normalizeText(context.inbound.text)
  const frames = buildIntentFrames(context, text)
  const rejectedOwners = rejectedOwnersFor(context, text)
  const forbiddenMutations = forbiddenMutationsFor(context, text)
  const requiredTools = new Set<RequiredTool>()

  for (const frame of frames) {
    if (frame.intent === "prescreen_outcome_question") requiredTools.add("load_prescreen_evidence")
    if (frame.intent === "durable_preference_update") {
      requiredTools.add("semantic_preference_extraction")
      requiredTools.add("commit_memory")
    }
    if (frame.intent === "job_search_request") requiredTools.add("generate_job_recommendations")
    if (frame.intent === "active_workflow_answer") requiredTools.add("prescreen_turn_handler")
    if (frame.intent === "shared_onboarding_answer") requiredTools.add("shared_onboarding_writer")
  }

  const hasPrescreenOutcomeQuestion = frames.some((frame) => frame.intent === "prescreen_outcome_question")
  const hasExplicitMetaQuestion = frames.some((frame) => frame.intent === "explicit_meta_question")
  const hasDurablePreferenceUpdate = frames.some((frame) => frame.intent === "durable_preference_update")
  const hasJobSearchRequest = frames.some((frame) => frame.intent === "job_search_request")
  const hasActiveWorkflowAnswer = frames.some((frame) => frame.intent === "active_workflow_answer")
  const hasSharedOnboardingAnswer = frames.some((frame) => frame.intent === "shared_onboarding_answer")
  const hasSharedOnboardingClarification = frames.some((frame) => frame.intent === "shared_onboarding_clarification")
  const hasSafetyControl = frames.some((frame) => frame.intent === "safety_control")

  if (hasSafetyControl) {
    return decision({
      selectedOwner: "safety_control",
      rejectedOwners,
      reason: "User issued a control/safety/privacy instruction.",
      requiredTools,
      forbiddenMutations,
      intentFrames: frames,
      orderedActions: [{ kind: "safety_control", owner: "safety_control", reason: "Control intent has highest priority." }],
    })
  }

  if (hasPrescreenOutcomeQuestion && context.prescreenEvidence) {
    return decision({
      selectedOwner: "prescreen_outcome_explainer",
      rejectedOwners,
      reason: "User asked about the prescreen/job outcome; answer that question before any workflow mutation.",
      requiredTools,
      forbiddenMutations,
      intentFrames: frames,
      orderedActions: [
        { kind: "answer_prescreen_outcome", owner: "prescreen_outcome_explainer", reason: "Explicit outcome question." },
        ...(hasDurablePreferenceUpdate
          ? [
              { kind: "extract_durable_preferences" as const, owner: "durable_preference_update" as const, reason: "Same turn contains durable preference feedback." },
              { kind: "commit_memory" as const, owner: "durable_preference_update" as const, reason: "Durable preference must be committed before later matching." },
            ]
          : []),
      ],
    })
  }

  if (hasExplicitMetaQuestion && !hasJobSearchRequest) {
    return decision({
      selectedOwner: "explicit_explanation",
      rejectedOwners,
      reason: "User asked an explicit question; answer it before applying durable preference or workflow mutations.",
      requiredTools,
      forbiddenMutations,
      intentFrames: frames,
      orderedActions: [
        { kind: "fallback_reply", owner: "explicit_explanation", reason: "Explicit question owns the visible reply." },
        ...(hasDurablePreferenceUpdate
          ? [
              { kind: "extract_durable_preferences" as const, owner: "durable_preference_update" as const, reason: "Same turn contains durable preference feedback." },
              { kind: "commit_memory" as const, owner: "durable_preference_update" as const, reason: "Durable preference should be committed without swallowing the explicit question." },
            ]
          : []),
      ],
    })
  }

  if (hasActiveWorkflowAnswer) {
    return decision({
      selectedOwner: "active_workflow",
      rejectedOwners,
      reason: "User answered the currently active workflow question.",
      requiredTools,
      forbiddenMutations,
      intentFrames: frames,
      orderedActions: [
        { kind: "route_active_workflow", owner: "active_workflow", reason: "Active workflow owns the answer." },
        ...(hasDurablePreferenceUpdate
          ? [
              { kind: "extract_durable_preferences" as const, owner: "durable_preference_update" as const, reason: "Same turn also contains durable preference signal." },
              { kind: "commit_memory" as const, owner: "durable_preference_update" as const, reason: "Durable preference should be committed after the workflow answer is preserved." },
            ]
          : []),
      ],
    })
  }

  if (hasSharedOnboardingAnswer) {
    return decision({
      selectedOwner: "shared_onboarding",
      rejectedOwners,
      reason: "User answered the active shared-onboarding slot.",
      requiredTools,
      forbiddenMutations,
      intentFrames: frames,
      orderedActions: [
        { kind: "write_shared_onboarding_answer", owner: "shared_onboarding", reason: "Active shared-onboarding slot answer." },
        ...(hasDurablePreferenceUpdate
          ? [
              { kind: "extract_durable_preferences" as const, owner: "durable_preference_update" as const, reason: "Same turn also contains durable preference signal." },
              { kind: "commit_memory" as const, owner: "durable_preference_update" as const, reason: "Durable preference should be committed after the onboarding answer is preserved." },
            ]
          : []),
      ],
    })
  }

  if (hasDurablePreferenceUpdate) {
    return decision({
      selectedOwner: "durable_preference_update",
      rejectedOwners,
      reason: "User changed durable role/matching preferences; extract semantically and commit before matching.",
      requiredTools,
      forbiddenMutations,
      intentFrames: frames,
      orderedActions: [
        { kind: "extract_durable_preferences", owner: "durable_preference_update", reason: "Durable preference signal." },
        { kind: "commit_memory", owner: "durable_preference_update", reason: "Memory write precedes any new matching." },
        ...(hasJobSearchRequest
          ? [{ kind: "run_job_search" as const, owner: "job_search" as const, reason: "Job search runs after memory commit." }]
          : []),
      ],
    })
  }

  if (hasJobSearchRequest) {
    return decision({
      selectedOwner: "job_search",
      rejectedOwners,
      reason: "User explicitly asked Claire to find or refresh roles.",
      requiredTools,
      forbiddenMutations,
      intentFrames: frames,
      orderedActions: [{ kind: "run_job_search", owner: "job_search", reason: "Explicit job-search request." }],
    })
  }

  if (hasSharedOnboardingClarification) {
    return decision({
      selectedOwner: "shared_onboarding",
      rejectedOwners,
      reason: "Active shared onboarding still owns the unclear short reply; re-ask without mutating the slot.",
      requiredTools,
      forbiddenMutations,
      intentFrames: frames,
      orderedActions: [{ kind: "clarify_shared_onboarding", owner: "shared_onboarding", reason: "Reply did not answer the active onboarding slot." }],
    })
  }

  return decision({
    selectedOwner: "fallback_claire",
    rejectedOwners,
    reason: "No higher-priority owner accepted the turn.",
    requiredTools,
    forbiddenMutations,
    intentFrames: frames.length
      ? frames
      : [{ intent: "fallback_claire", confidence: 0.55, evidenceSpan: context.inbound.text.trim().slice(0, 240), scope: "one_off" }],
    orderedActions: [{ kind: "fallback_reply", owner: "fallback_claire", reason: "Default Claire reply." }],
  })
}

export function summarizeConversationTurnTrace(
  context: TurnContext,
  ownerDecision: OwnerDecision,
  actionDecision?: ConversationActionDecision,
  evidenceWrites?: ConversationEvidenceWrite[],
): TurnTrace {
  return {
    traceVersion: 1,
    turnId: context.turnId,
    userId: context.userId,
    states: [...TRACE_STATES],
    decision: ownerDecision,
    ...(actionDecision ? { actionDecision } : {}),
    ...(evidenceWrites ? { evidenceWrites } : {}),
    inbound: {
      text: context.inbound.text,
      createdAt: context.inbound.createdAt,
      channel: context.inbound.channel,
    },
  }
}

function decision(input: Omit<OwnerDecision, "requiredTools"> & { requiredTools: Set<RequiredTool> }): OwnerDecision {
  return {
    ...input,
    requiredTools: Array.from(input.requiredTools),
  }
}

/**
 * Minimum confidence for an LLM label to be treated as PRESENT by the mapper.
 * Mirrors the skill-intent-classifier 0.6 cutoff. Below this we treat the label
 * as absent (the deterministic cascade then routes to fallback_claire, which is
 * never worse than today for an uncertain turn).
 */
const LLM_LABEL_CONFIDENCE_FLOOR = 0.6

/**
 * Resolve whether the inbound text answers the active shared-onboarding slot.
 * A8 delegation: when the call site supplied the existing
 * `judgeSharedOnboardingAnswer` result (`sharedOnboardingAnswerAccepted`), use
 * it (ONE onboarding-answer judge in the system). Otherwise fall back to the
 * regex keyword bank (today's path / non-canary / judge unavailable).
 */
function resolveSharedOnboardingSlotAnswer(
  context: TurnContext,
  questionId: string,
  text: string,
): boolean {
  if (
    context.sharedOnboardingAnswerAccepted !== undefined &&
    context.sharedOnboardingAnswerAccepted !== null
  ) {
    return context.sharedOnboardingAnswerAccepted
  }
  return isSharedOnboardingSlotAnswer(questionId, text)
}

function buildIntentFrames(context: TurnContext, text: string): IntentFrame[] {
  // LLM-primary path (canary, flag-gated upstream). When the validated LLM
  // intent is available, derive MEANING frames from its labels; STATE guards
  // stay deterministic. SAFETY/marker regexes still run inside this branch.
  if (context.llmIntent && context.llmIntent.available) {
    return framesFromLlmIntent(context, text, context.llmIntent)
  }
  return framesFromRegex(context, text)
}

/**
 * Deterministic mapper: validated LLM intent labels → the exact `IntentFrame[]`
 * shape the regex path produces. Preserves every guard that is STATE not
 * MEANING (prescreenEvidence, activeWorkflow status, sharedOnboarding active +
 * judged slot answer). SAFETY (STOP/privacy) and marker (`__..__`) are still
 * derived from the kept regexes — the LLM is told NOT to classify those.
 */
function framesFromLlmIntent(
  context: TurnContext,
  text: string,
  llm: TurnIntentResult,
): IntentFrame[] {
  const frames: IntentFrame[] = []
  const raw = context.inbound.text.trim()
  const span = raw.slice(0, 240)
  const present = (label: keyof TurnIntentResult["labels"]): boolean =>
    llm.labels[label].present && llm.labels[label].confidence >= LLM_LABEL_CONFIDENCE_FLOOR
  const confidenceOf = (label: keyof TurnIntentResult["labels"]): number =>
    llm.labels[label].confidence

  // SAFETY / marker — KEPT as deterministic regex (never LLM-judged).
  if (isControlOrPrivacyIntent(text)) {
    frames.push({ intent: "safety_control", confidence: 0.9, evidenceSpan: span, scope: "one_off" })
  }

  // meta vs prescreen-outcome. The LLM supplies both labels; the STATE guard
  // (prescreenEvidence present) decides whether the outcome frame is emitted.
  const isMeta = present("meta_question") || present("saved_preference_recall")
  const isPrescreenOutcome = present("prescreen_outcome_question")
  if (isPrescreenOutcome && context.prescreenEvidence) {
    frames.push({
      intent: "prescreen_outcome_question",
      confidence: Math.max(0.9, confidenceOf("prescreen_outcome_question")),
      evidenceSpan: span,
      scope: "one_off",
    })
  } else if (isMeta) {
    frames.push({
      intent: "explicit_meta_question",
      confidence: Math.max(0.7, confidenceOf("meta_question"), confidenceOf("saved_preference_recall")),
      evidenceSpan: span,
      scope: "one_off",
    })
  }

  if (present("durable_preference_update")) {
    frames.push({
      intent: "durable_preference_update",
      confidence: Math.max(0.7, confidenceOf("durable_preference_update")),
      evidenceSpan: span,
      scope: "durable",
    })
  }

  if (present("job_search_request")) {
    frames.push({
      intent: "job_search_request",
      confidence: Math.max(0.7, confidenceOf("job_search_request")),
      evidenceSpan: span,
      scope: "one_off",
    })
  }

  // active prescreen answer — STATE-gated. The negative guards consume the LLM
  // `meta_question` label (and SAFETY regex) instead of `isMetaQuestion(text)`.
  if (
    context.activeWorkflow?.kind === "job_prescreen" &&
    context.activeWorkflow.status === "active" &&
    !isMeta &&
    !isControlOrPrivacyIntent(text)
  ) {
    frames.push({
      intent: "active_workflow_answer",
      confidence: 0.84,
      evidenceSpan: span,
      scope: "workflow",
    })
  }

  // shared-onboarding answer — A8 delegated to judgeSharedOnboardingAnswer.
  if (
    context.sharedOnboarding?.active === true &&
    context.sharedOnboarding.currentQuestionId &&
    resolveSharedOnboardingSlotAnswer(context, context.sharedOnboarding.currentQuestionId, text)
  ) {
    frames.push({
      intent: "shared_onboarding_answer",
      confidence: 0.81,
      evidenceSpan: span,
      scope: "workflow",
    })
  }

  // shared-onboarding clarification — derives from acknowledgment/confusion
  // labels + the kept STATE/kickoff guards.
  if (llmSharedOnboardingClarificationTurn(context, text, present, isMeta)) {
    frames.push({
      intent: "shared_onboarding_clarification",
      confidence: 0.76,
      evidenceSpan: span,
      scope: "workflow",
    })
  }

  return frames
}

/**
 * Clarification gate for the LLM path: an active shared-onboarding slot still
 * owns an unclear short reply that did NOT answer the slot, is not a kickoff
 * greeting, not safety, not a meta question, not a durable pref, not a job
 * search — and reads as an acknowledgment or confusion per the LLM labels.
 */
function llmSharedOnboardingClarificationTurn(
  context: TurnContext,
  text: string,
  present: (label: keyof TurnIntentResult["labels"]) => boolean,
  isMeta: boolean,
): boolean {
  if (context.sharedOnboarding?.active !== true) return false
  const questionId = context.sharedOnboarding.currentQuestionId
  if (!questionId) return false
  if (resolveSharedOnboardingSlotAnswer(context, questionId, text)) return false
  if (isSharedOnboardingKickoffLike(text)) return false // STATE/structural — KEPT
  if (isControlOrPrivacyIntent(text)) return false // SAFETY — KEPT
  if (isMeta) return false
  if (present("durable_preference_update")) return false
  if (present("job_search_request")) return false
  return present("acknowledgment") || present("confusion")
}

function framesFromRegex(context: TurnContext, text: string): IntentFrame[] {
  const frames: IntentFrame[] = []
  const raw = context.inbound.text.trim()

  if (isControlOrPrivacyIntent(text)) {
    frames.push({
      intent: "safety_control",
      confidence: 0.9,
      evidenceSpan: raw.slice(0, 240),
      scope: "one_off",
    })
  }

  if (isPrescreenOutcomeQuestion(text) && context.prescreenEvidence) {
    frames.push({
      intent: "prescreen_outcome_question",
      confidence: 0.92,
      evidenceSpan: raw.slice(0, 240),
      scope: "one_off",
    })
  } else if (isMetaQuestion(text)) {
    frames.push({
      intent: "explicit_meta_question",
      confidence: 0.78,
      evidenceSpan: raw.slice(0, 240),
      scope: "one_off",
    })
  }

  if (isDurablePreferenceUpdate(text)) {
    frames.push({
      intent: "durable_preference_update",
      confidence: 0.86,
      evidenceSpan: raw.slice(0, 240),
      scope: "durable",
    })
  }

  if (isJobSearchRequest(text)) {
    frames.push({
      intent: "job_search_request",
      confidence: 0.82,
      evidenceSpan: raw.slice(0, 240),
      scope: "one_off",
    })
  }

  if (
    context.activeWorkflow?.kind === "job_prescreen" &&
    context.activeWorkflow.status === "active" &&
    !isMetaQuestion(text) &&
    !isControlOrPrivacyIntent(text)
  ) {
    frames.push({
      intent: "active_workflow_answer",
      confidence: 0.84,
      evidenceSpan: raw.slice(0, 240),
      scope: "workflow",
    })
  }

  if (
    context.sharedOnboarding?.active === true &&
    context.sharedOnboarding.currentQuestionId &&
    resolveSharedOnboardingSlotAnswer(context, context.sharedOnboarding.currentQuestionId, text)
  ) {
    frames.push({
      intent: "shared_onboarding_answer",
      confidence: 0.81,
      evidenceSpan: raw.slice(0, 240),
      scope: "workflow",
    })
  }

  if (isSharedOnboardingClarificationTurn(context, text)) {
    frames.push({
      intent: "shared_onboarding_clarification",
      confidence: 0.76,
      evidenceSpan: raw.slice(0, 240),
      scope: "workflow",
    })
  }

  return frames
}

function rejectedOwnersFor(context: TurnContext, text: string): RejectedOwner[] {
  const rejected: RejectedOwner[] = []
  const questionId = context.sharedOnboarding?.currentQuestionId
  if (
    context.sharedOnboarding?.active === true &&
    questionId &&
    !resolveSharedOnboardingSlotAnswer(context, questionId, text)
  ) {
    rejected.push({
      owner: "shared_onboarding",
      reason: `Active slot ${questionId} is not an answer to that slot.`,
    })
  }
  return rejected
}

function forbiddenMutationsFor(context: TurnContext, text: string): string[] {
  const forbidden: string[] = []
  const questionId = context.sharedOnboarding?.currentQuestionId
  if (
    context.sharedOnboarding?.active === true &&
    questionId &&
    !resolveSharedOnboardingSlotAnswer(context, questionId, text)
  ) {
    forbidden.push(`sharedOnboarding.answers.${questionId}`)
  }
  return forbidden
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim()
}

function isControlOrPrivacyIntent(text: string): boolean {
  if (isSystemControlString(text)) return true
  if (/\b(delete my data|privacy|export my data|erase me|unsubscribe)\b/i.test(text)) return true
  if (/^(stop|pause|cancel)\s*$/i.test(text)) return true
  return /\b(stop|pause|cancel)\b.{0,40}\b(job recommendations|messages|texts|sms|outreach|all)\b/i.test(text)
}

/**
 * System-control sentinels like __PA_RESET__ / __PA_FIND_MATCH__ are dev/test
 * trigger strings, never natural language. They must route to safety_control so
 * they are handled deterministically and never get a tapback/reaction. Matched
 * case-insensitively because the arbiter normalizes inbound text to lowercase.
 */
function isSystemControlString(text: string): boolean {
  return /^__[a-z0-9_]+__$/i.test(text.trim())
}

function isMetaQuestion(text: string): boolean {
  return (
    text.includes("?") ||
    /^(why|how|what|could you|can you|help me understand|explain|where did|what do you mean)\b/i.test(text) ||
    isSavedPreferenceSummaryQuestion(text)
  )
}

export function isSavedPreferenceSummaryQuestion(text: string): boolean {
  return (
    /\b(?:w?hat|which|show|remind|tell)\b[\s\S]{0,40}\b(?:save|saved|store|stored|remember|remembered|have|using|use|used)\b[\s\S]{0,80}\b(?:job\s+)?(?:preferences?|prefs|matching\s+profile|profile\s+notes)\b/i.test(text) ||
    /\b(?:job\s+)?(?:preferences?|prefs|matching\s+profile|profile\s+notes)\b[\s\S]{0,50}\b(?:save|saved|store|stored|remember|remembered|have|using|use|used)\b/i.test(text) ||
    /\b(?:w?hat|which|show|remind|tell)\b[\s\S]{0,50}\b(?:save|saved|store|stored|remember|remembered|have|using|use|used)\b[\s\S]{0,50}\b(?:for\s+matching|matching\b)\b/i.test(text) ||
    (
      /\b(?:preferences?|prefs|matching profile|profile notes|for matching|matching)\b/i.test(text) &&
      /\b(?:match|matching|save|saved|store|stored|remember|remembered|using|use|used)\b/i.test(text) &&
      /\b(?:w?hat|which|show|remind|reminder|tell|using|use|could you)\b/i.test(text)
    )
  )
}

function isPrescreenOutcomeQuestion(text: string): boolean {
  if (!isMetaQuestion(text)) return false
  const hasOutcomeLanguage = /\b(fit|improve|improved|pause|paused|pass|passed|fail|failed|not pass|screen|prescreen|interview|role)\b/i.test(text)
  const asksReason = /\b(why|how|what|understand|feedback|improve|improved)\b/i.test(text)
  const mentionsRole = /\b(role|job|rain|company|above)\b/i.test(text)
  return hasOutcomeLanguage && asksReason && mentionsRole
}

function isSharedOnboardingClarificationTurn(context: TurnContext, text: string): boolean {
  if (context.sharedOnboarding?.active !== true) return false
  const questionId = context.sharedOnboarding.currentQuestionId
  if (!questionId) return false
  if (isSharedOnboardingSlotAnswer(questionId, text)) return false
  if (isSharedOnboardingKickoffLike(text)) return false
  if (isControlOrPrivacyIntent(text)) return false
  if (isMetaQuestion(text)) return false
  if (isDurablePreferenceUpdate(text)) return false
  if (isJobSearchRequest(text)) return false
  return isShortLowInformationReply(text) || isAmbiguousOnboardingReply(text)
}

function isShortLowInformationReply(text: string): boolean {
  return /^(sure|ok|okay|yes|yeah|yep|sounds good|sg|cool|fine|great|got it|makes sense|👍)$/i.test(text)
}

function isAmbiguousOnboardingReply(text: string): boolean {
  return /\b(not sure|unsure|idk|i don'?t know|confused|unclear|huh|what you mean)\b/i.test(text)
}

function isSharedOnboardingKickoffLike(text: string): boolean {
  return /^hello,?\s*wekruit!?/i.test(text) || /^(hello|hi|hey|yo|sup)(\s+(wekruit|claire))?$/i.test(text)
}

function isDurablePreferenceUpdate(text: string): boolean {
  return (
    /\b(no|not|don't|do not|stop|avoid|exclude|only|prefer|preference|bias|instead|rather)\b.{0,80}\b(role|roles|developer|software|product|strategy|pm|remote|onsite|internship|co-?op|startup|company)\b/i.test(text) ||
    /\b(product|strategy|pm|founder|operator|growth)\b.{0,40}\bonly\b/i.test(text)
  )
}

function isJobSearchRequest(text: string): boolean {
  return /\b(find|show|send|refresh|recommend|match|search|look for|pull)\b.{0,50}\b(job|jobs|role|roles|opportunit|match|matches)\b/i.test(text)
}

function isSharedOnboardingSlotAnswer(questionId: string, text: string): boolean {
  if (!text || isMetaQuestion(text) || isControlOrPrivacyIntent(text)) return false
  if (/^(not sure|i'?m not sure|idk|i do not know|don't know|what do you mean|unclear)\b/i.test(text)) return false

  if (questionId === "main_goal") {
    return /\b(growth|compensation|salary|stability|mission|learning|ownership|career|work[- ]?life|impact|manager|title|software|engineering|engineer|backend|frontend|front[- ]?end|full[- ]?stack|platform|product|strategy|data|machine learning|ml|ai|infra|infrastructure|systems?)\b/i.test(text)
  }
  if (questionId === "culture_stage") {
    return /\b(startup|scale[- ]?up|larger|big company|small company|high ownership|calm|collaborative|culture|team|stage|series [abc])\b/i.test(text)
  }
  if (questionId === "industry_interest") {
    return /\b(fintech|finance|ai|machine learning|ml|crypto|web3|healthcare|developer tools|saas|software|infra|infrastructure|marketplace|consumer|enterprise|open)\b/i.test(text)
  }
  if (questionId === "location_relocation") {
    return /\b(remote|onsite|on-site|hybrid|relocat|city|nyc|new york|sf|san francisco|bay area|seattle|austin|boston|london|singapore|open to|not relocating)\b/i.test(text)
  }
  if (questionId === "special_context") {
    return /\b(none|nothing|nope|visa|sponsor|sponsorship|h[-\s]?1b|opt|cpt|constraint|dealbreaker|timing|start|notice|severance|urgent|asap|strength|strongest|context|prefer|avoid|backend|frontend|front[-\s]?end|full[-\s]?stack|platform|systems?|infrastructure|distributed|built|handled?)\b/i.test(text)
  }
  return false
}
