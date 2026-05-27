import { createHash, randomUUID } from "node:crypto"
import { FieldValue, type Firestore } from "firebase-admin/firestore"
import {
  getAgentById,
  getDefaultAgent,
  composeSystemPrompt as composeLegacyHandbookSystemPrompt,
  loadHandbook as loadLegacyHandbookSections,
} from "@pa/agent-registry"
import {
  composeSystemPrompt as composeHandbookV2SystemPrompt,
  loadHandbook as loadHandbookV2,
  DEFAULT_HANDBOOK_SLUG,
} from "./handbook/loader.js"
// Stream D — CV context injection (appendCvContextToSystemPrompt).
import { appendCvContextToSystemPrompt } from "./cv-context-injection.js"
// v1.5 / Phase 53.5 — JOB MARKET CONTEXT harness (Adam 2026-05-02 spec).
import {
  appendJobMarketKnowledgeToSystemPrompt,
  detectJobMarketRole,
} from "./voice/job-market-knowledge.js"
import {
  runAgentTurn as defaultRunAgentTurn,
  stripLeadingIsoTimestamp,
  FirestoreSession,
  deriveSessionMessageIdempotencyKey,
  type AgentsSdkSession as Session,
  type AgentTurnTool,
} from "@pa/agent-runtime"
import {
  connectorRegistry,
  resolveToolFamily,
  runConnector,
  type ConnectorName,
} from "@pa/pa-connectors"
import {
  PA_COLLECTIONS,
  createPrivacyRequestId,
  type AgentDef,
  type ChatMessage,
  type InboundEvent,
  type MemoryActionType,
  type MemoryFact,
  type OutboundMessage,
  type ProcessingStatus,
  type PrivacyRequest,
  type PrivacyRequestKind,
  type TurnStage,
} from "@pa/core-types"
import {
  afterAssistantTurn as defaultAfterAssistantTurn,
  buildPersonaCard,
  writeStylePreference,
  setVoiceStyleStore,
  createFirestoreVoiceStyleStore,
  clearUserMemory,
  createConfirmedMemoryFact,
  isResetCommand,
  summarizeClearResult,
  findMatchingFacts,
  listConfirmedMemoryFacts,
  loadPersonalizationContext as defaultLoadPersonalizationContext,
  loadRecentMessages,
  markMemoryFactsDeleted,
  parseMemoryCommand,
  recordMemoryAction as defaultRecordMemoryAction,
  resolveMem0PartitionKey,
  type AfterTurnResult,
  type LoadContextResult,
} from "@pa/memory"
import { appendAuditEvent, enqueueOutbound as enqueueBrokerOutbound } from "@pa/pa-broker"
import { getFlag, writePrivacyRequest } from "@pa/pa-persistence"
import {
  checkPromptInjection,
  checkPromptInjectionAndRecord,
  enforceRateLimit,
  // Phase 46 (v1.5 Stream-E) — safety/abuse hardening
  runSafetyCheck,
  pickLangForSafety,
  SAFETY_CANNED_REPLIES,
  type SafetyAction,
  type Severity as SafetySeverity,
} from "@pa/pa-safety"
// Phase 53 — crisis hotline guard runner (cold-start hole fix). Wraps
// `guardCrisisHotline` (Phase 51) with flag/telemetry/audit scaffolding so
// BOTH onboarding and main paths can call it identically.
import { runCrisisHotlineGuard } from "./safety/crisis-guard-runner.js"
// v1.5 §3.8 — OpenAI Moderation runner (replaces dead-code 12-pattern bank).
import { runOpenaiModeration } from "./safety/moderation-runner.js"
import {
  resolveOnboardingStep,
  applyOnboardingStep,
  composeOnboardingInput,
  shouldRunOnboardingProbe,
  parseUserAnswerForStep,
  parseTosAnswer,
  WEKRUIT_LAYOFF_SOURCE,
  type OnboardingStep,
} from "./onboarding.js"
export {
  SHARED_ONBOARDING_BOUNDARY,
  SHARED_ONBOARDING_EVENT_KIND,
  SHARED_ONBOARDING_EVENT_SOURCE,
  SHARED_ONBOARDING_WORK_SESSION_KIND,
  SHARED_ONBOARDING_QUESTIONS,
  buildSharedOnboardingStartedState,
  buildSharedOnboardingPrompt,
  buildSharedOnboardingPromptContext,
  buildSharedOnboardingReask,
  cleanSharedOnboardingPromptContext,
  currentSharedOnboardingQuestionId,
  getSharedOnboardingQuestion,
  isSharedOnboardingActiveUser,
  buildHelloWekruitOpenerBody,
  parseHelloWekruitOpener,
  HELLO_WEKRUIT_OPENER_PREFIX,
  isSharedOnboardingGreetingOrKickoff,
  isSharedOnboardingRuntimeEvent,
  judgeSharedOnboardingAnswer,
  shouldIgnoreSharedOnboardingDuplicateKickoff,
  shouldSharedOnboardingAdvanceDespiteJudge,
  loadSharedOnboardingParsedResumeForPrompt,
  projectSharedOnboardingAnswer,
  resolveNextSharedOnboardingQuestionId,
  sharedOnboardingSignupSource,
  type SharedOnboardingQuestionId,
  type SharedOnboardingPromptContext,
} from "./shared-onboarding.js"
import {
  SHARED_ONBOARDING_BOUNDARY,
  SHARED_ONBOARDING_WORK_SESSION_KIND,
  buildSharedOnboardingPrompt,
  buildSharedOnboardingPromptContext,
  cleanSharedOnboardingPromptContext,
  currentSharedOnboardingQuestionId,
  buildSharedOnboardingReask,
  getSharedOnboardingQuestion,
  isSharedOnboardingActiveUser,
  isSharedOnboardingGreetingOrKickoff,
  isSharedOnboardingRuntimeEvent,
  judgeSharedOnboardingAnswer,
  shouldIgnoreSharedOnboardingDuplicateKickoff,
  shouldSharedOnboardingAdvanceDespiteJudge,
  loadSharedOnboardingParsedResumeForPrompt,
  projectSharedOnboardingAnswer,
  resolveNextSharedOnboardingQuestionId,
  type SharedOnboardingQuestionId,
  type SharedOnboardingPromptContext,
} from "./shared-onboarding.js"
import { applyTemplateOutboundHumanize } from "./outbound-template-humanize.js"
import {
  decideConversationTurnOwner,
  summarizeConversationTurnTrace,
  type OwnerDecision,
  type PrescreenEvidence,
  type TurnContext,
} from "./conversation-turn-arbiter.js"
export {
  decideConversationTurnOwner,
  summarizeConversationTurnTrace,
  type OwnerDecision,
  type PrescreenEvidence,
  type TurnContext,
} from "./conversation-turn-arbiter.js"
import {
  buildConversationEvidenceWrites,
  decideConversationDeliveryAction,
  type ConversationActionDecision,
  type ConversationEvidenceWrite,
} from "./conversation-action-arbiter.js"
export {
  buildConversationEvidenceWrites,
  decideConversationDeliveryAction,
  summarizeWarmConciseWordingPolicy,
  type ConversationActionDecision,
  type ConversationDeliveryAction,
  type ConversationEvidenceWrite,
} from "./conversation-action-arbiter.js"
import {
  composeSharedOnboardingReply,
  deliverSharedOnboardingJobRecs,
  resolveAgentAllowedConnectors,
  buildSharedOnboardingComposeContext,
  extractRecentSlangPicks,
  persistSharedOnboardingSlangPicks,
  type SharedOnboardingOutboundStore,
} from "./shared-onboarding-outbound.js"
import { buildMatchConnectorHooks } from "./match-connector-hooks.js"
import { composeFindMatchPreCall } from "./job-match-narration.js"
import { frameConnectorResult } from "./run-connector-with-narration.js"
import { handleCollabInviteReply, runCollabMatchInviteAfterResumeIngest } from "./collab-match-invite.js"
import type { MatchConnectorHooks } from "@pa/pa-connectors"
// Single onboarding runtime entry. It owns the Q-as-class pipeline and resume
// discussion flow; legacy flag-gated fallbacks are intentionally not wired.
import { runDeterministicOnboardingTurn } from "./onboarding-deterministic.js"
// Re-export for downstream consumers (apps/functions sim, scripts).
// iter35 P7-4 — `resolveDeterministicAction` and `composeDeterministicReply`
// removed (subsumed by `pipeline.runTurn` + DiscussionPhase pattern).
export {
  runDeterministicOnboardingTurn,
  loadOnboardingConfig,
  DEFAULT_ONBOARDING_CONFIG,
} from "./onboarding-deterministic.js"
// iter33 P5 — onboarding workflow as introspectable graph data.
export {
  ONBOARDING_WORKFLOW,
  outgoingEdges,
  incomingEdges,
  topologicalStates,
  validateWorkflow,
} from "./onboarding-workflow.js"
export type {
  OnboardingWorkflow,
  WorkflowNode,
  WorkflowEdge,
  WorkflowNodeKind,
  WorkflowEdgeCondition,
} from "./onboarding-workflow.js"
// Phase 52 — F1 fix: lightweight bilingual intent detection for turn-0
// onboarding ack (no LLM, regex only). See onboarding-intent.ts for the bank.
import { detectFirstTurnIntent } from "./onboarding-intent.js"
import { LEGACY_V0_SYSTEM_PROMPT } from "./legacy-voice-prompt.js"
import { buildVoiceReminder, isVoiceV1Disabled } from "./voice-reminder.js"
import { computeMirrorForTurn, isVoiceMirrorDisabledFlag } from "./voice/mirror-injection.js"
import {
  rewriteIfOff,
  stripRepeatOpener,
  stripValidationTic,
  isHumanizeRuntimeEnabled,
} from "./voice/llm-rewriter.js"
// Phase 36 — ImperfectionInjector applied post-strip on final visible text.
import {
  detectUserLang,
  injectImperfection,
  resolveArm,
} from "./voice/imperfection-injector/index.js"
// Phase 53 — Bug 2 fix: lang-lock helper extracted to runner so both
// onboarding cold-start branch + main path share single source of truth.
// Mirrors Phase 53 Bug A pattern (`crisis-guard-runner.ts`).
import {
  buildLangLockSandwich,
  buildLangLockUserDirective,
  runLangLockGuard,
} from "./voice/lang-lock-runner.js"
// Phase 35/38 — detectors + advice tracker run UNCONDITIONALLY on the final
// visible text, regardless of whether `rewriteIfOff` short-circuited (no_change
// / rewrite_unsafe / timeout). Inner-rewriter wire-in only fires on the
// "rewrite happy path" — that's why pre-rev-00024 turns produced zero
// advice-tracker entries despite the flag being on for the user.
import {
  runAllDetectors,
  type DetectorContext,
} from "./voice/detectors/index.js"
// Adam iter 17 (2026-05-03) — F2 hard-cap enforcement. Detector was logging
// `suggested_action: "strip"` since Phase 35 but no caller acted on it. With
// 3-sentence cap actually enforced, prob-split downstream picks 1-or-2 bubbles
// from the capped reply (instead of from a 5+-sentence overflow).
import {
  stripToSentenceCap,
  stripToCharCap,
  isStructuredReply,
} from "./voice/detectors/f2-length-cap.js"
// Adam iter 19 — slang lexicon was orphaned (only consumed by disabled
// mirror). Now wired as a per-turn system-prompt directive injecting 2-3
// lang-appropriate slang terms from the curated VOICE-07 lexicon.
import { buildSlangInjection } from "./voice/slang-injector.js"
// Adam iter 19 — academic-integrity detector exists in @pa/pa-safety since
// Stream-E P0 (2026-05-02) but the orchestrator never wired it. This module
// detects leetcode-cheating asks deterministically + returns a bilingual
// LLM directive that redirects the user to study approach instead. WARN-
// only, never blocks. Wired into systemInputs alongside playbookAddendum.
import { checkAcademicIntegrity } from "@pa/pa-safety"
// Adam iter 19 — real-time tag write-back (mid-conversation profile update).
// Pure regex (sub-1ms), fire-and-forget Firestore merge-write to pa_users.
// Spec: "边聊天我们要给用户边打标，这个标记应该是实时变化的但是cost不能高"
import { applyRealtimeTagWriteback } from "./voice/realtime-tagger.js"
// 2026-05-18 — chat → tag + memory extractor (post-onboarding free-form
// preference deltas mirror into pa-users.tags + Qdrant pa_memory_entities).
// See .planning/GOAL-chat-tag-memory-extraction.md.
import { maybeRunExtractor } from "./conversation-extractor-runtime.js"
import type { ConversationExtractMessage } from "./conversation-extractor.js"
// Adam iter 20 — phrase-repeat stripper. iter-19 10-turn sim found 5
// consecutive replies opening with "要不要试" — F1 detects user-mirror
// not Claire-self-mirror; stripRepeatOpener only checks last-2 + first
// clause. This module checks last-5 + 4+ char substrings in first 30c.
import { stripPhraseRepeat } from "./voice/phrase-repeat-stripper.js"
import { trackAdvice } from "./voice/memory-policy/index.js"
import { tapCoachTokens } from "./voice/coach-token-monitor.js"
import { buildFewShotTurns, prefixFewShotToHistory } from "./voice/few-shot.js"
// v1.5 long-context humanize control (Adam 2026-05-02) — sliding-window
// truncation of the model-input history. mirror analyzer still consumes
// raw `history` (untruncated) at computeMirrorForTurn above so older
// turns can still inform style mirroring.
import {
  truncateHistoryByTokens,
  TELEMETRY_THRESHOLD_TOKENS,
} from "./voice/context-window.js"
import { normalizeForIMessage, stripABProbeFromTail } from "./output-normalizer.js"
// Phase 53 (v1.6 voice-quality closure) — conditional A/B framework strip
// + mixed-register mirror append. Distinct from stripABProbeFromTail
// (X-or-Y tail probes) — see ab-framework-detector.ts module docstring.
import { stripABFramework } from "./voice/ab-framework-detector.js"
import { applyMixedRegisterMirror } from "./voice/mixed-register-mirror.js"
// iter30 Wave 3 — am_i_ai post-gen flat-deny re-roll. V2 QA Agent-B
// observed Claire occasionally replying "嗯，我是真人朋友。" when asked
// "你是 AI 吗?" — the addendum forbids flat-deny ("deceptive"). This
// module deterministically substitutes a friend-tone deflection that
// doesn't lie. Gated by paHumanizeRuntimeEnabled umbrella + env kill
// switch PA_AM_I_AI_REROLL_DISABLED=true.
import { deflectAmIAiFlatDeny } from "./voice/am-i-ai-deflector.js"
// v1.5 humanize (Adam spec, 2026-05-03) — probabilistic 1-or-2 messages
// per turn. Replaces Bug 4 single-send invariant (commit ea59897) with a
// post-gen seeded probabilistic split. See voice/probabilistic-split.ts
// for design notes (hotline-trailer guard, sentence/transition tokenizer,
// 30%-70% position window, mulberry32 RNG keyed by turnId).
import { decideReplySplit } from "./voice/probabilistic-split.js"
// Adam 2026-05-19 voice polish §3 — unified outbound delivery plan
// (tapback / leading emoji SMS / 1-2 text bubbles) keyed off turnId. Gated
// on paBehaviorChoreographerEnabled (agentic bundle) — when OFF, we keep
// the legacy decideReplySplit-only path so this stays a pure side-effect
// upgrade. See voice/outbound-delivery-plan.ts.
import {
  planOutboundDelivery,
  type OutboundDeliveryPlan,
} from "./voice/outbound-delivery-plan.js"
import {
  isBehaviorChoreographerEnabled,
  isReactionTapbackEnabled,
} from "./shared-onboarding-outbound.js"
import { resolveProfileForUser } from "./voice/voice-profiles/index.js"
// Phase 21 Track 5 — Headhunter playbook addendum (job-search probe rotation).
import { headhunterAddendum } from "./playbooks/headhunter.js"
// Phase 32 W3 — Firestore-backed playbook cache (30s TTL). Replaces the
// inline HEADHUNTER_TRIGGER_RE constant; the regex below is kept as a
// failsafe when Firestore is empty (zero-downtime cutover).
import {
  filterTurnToolsForSkillAllowlist,
  resolvePlaybookForTurn,
  type PlaybookRoutingResult,
} from "./playbook-routing.js"
import {
  handlePostMatchRetentionReply,
  startPostMatchRetentionAfterJobRecs,
} from "./post-match-retention.js"
// iter30 WS6 — guardrail chain (Wave 2 day 3 wire-in). Shadow-mode
// telemetry by default (`PA_GUARDRAIL_CHAIN_SHADOW=true` flag); the
// scattered patches at lines 1623-1976 stay in charge of mutating the
// reply until shadow-mode parity-telemetry confirms equivalence
// (Wave 3). Once flipped, the patches are removed and the chain owns
// AB-strip + length-cap + crisis-trailer + slang-enforce + normalize.
//
// Detail-plan: .planning/iter30/ws-3-6-detail.md §5-7
// Adam-locked chain order: lengthCap → abStrip → slangEnforcer →
// adviceRepeat → crisisTrailer → mirrorScore → outputNormalizer.
import {
  INPUT_GUARDRAIL_CHAIN,
  OUTPUT_GUARDRAIL_CHAIN,
  runInputChain,
  runOutputChain,
} from "./guardrails/index.js"
import { createMockContext } from "./run-context.js"

const HEADHUNTER_PLAYBOOK_ID = "headhunter"
/**
 * Failsafe regex — only consulted when Firestore lookup returns 0 matches.
 * Once `seedDefaultPlaybooks` has run the regex set comes from the
 * dashboard-editable `pa-playbooks/headhunter.regexTriggers` array.
 */
const HEADHUNTER_TRIGGER_RE = /帮我|想换|在看工作|在面|简历|offer/i
// Phase 22 — proactive cancellation NLU (D-07, PROACTIVE-06)
import { detectProactiveCancellation } from "./cancellation-nlu.js"
// Phase 30 T2 — Downstream Eval Connector hook (P9-Connectors).
import { runDownstreamConnector, withSoftBudget } from "./downstream.js"
import { defaultNlJudge } from "./eval-nl-judge.js"
// Re-export Phase 22 proactive modules for consumers (e.g. apps/functions)
export { detectProactiveCancellation, CANCELLATION_PATTERNS } from "./cancellation-nlu.js"
export { runProactiveTurn, type ProactiveTurnStore, type ProactiveTurnResult } from "./proactive-turn.js"
export {
  runCollabMatchInviteAfterResumeIngest,
  handleCollabInviteReply,
  COLLAB_INVITE_MIN_SCORE,
  type CollabMatchInviteDeps,
  type CollabInvitePending,
} from "./collab-match-invite.js"
export { detectCollabInviteReplyIntent, buildCollabInviteIntent } from "./collab-invite-surface.js"
export { normalizeForIMessage } from "./output-normalizer.js"
// Phase 30 T2 — re-export downstream connector helpers for admin CF wiring.
export {
  runDownstreamConnector,
  withSoftBudget,
  EVAL_CONNECTORS_FLAG,
  type RunDownstreamConnectorInput,
  type RunDownstreamConnectorOptions,
  type RunDownstreamConnectorResult,
  type DownstreamFireRecord,
} from "./downstream.js"
// Phase 30 T-Wrap — re-export the production NL judge so the admin debug
// endpoint (paAdminBootstrap → evalDownstreamTriggers) can pass it in.
export { defaultNlJudge, _resetNlJudgeClient as _resetEvalNlJudgeClient } from "./eval-nl-judge.js"
// iter34 sprint A.4 — role canonical → industryEnum bucket mapper. Used by
// the job-rec query path (apps/job-rec) to compute targetRoleIndustryEnum
// from statedPreferences.targetRole. Pure / deterministic.
export {
  roleToIndustryBuckets,
  type IndustryEnumBucket,
} from "./voice/role-to-industry.js"
// iter34 sprint H.1 — unified user-tag schema + merger. Folds the 4
// disjoint candidate-signal sources (CV doc, statedPreferences, embedding,
// language lock) into one canonical `pa-users/{userId}.tags` projection.
// Pure / deterministic; H.3 worker wires call-site, H.4 worker wires
// generateJobRecs read-side.
export {
  mergeUserTags,
  UserTagsSchema,
  USER_TAGS_SCHEMA_VERSION,
  inferSkillBucket,
  canonicalizeSkillName,
  type UserTags,
  type UserTagsInput,
  type UserTagsCvInput,
  type IndustryTag as UserTagsIndustryTag,
  type TagsVisaStatus,
  type StartupPreference,
  type TagsPreferredLang,
} from "./tags/user-tags-merger.js"
import {
  applyPartialUserTags,
  type PartialUserTags,
} from "./tags/user-tags-writer.js"
import {
  mapAnswerToRoleFunction,
  mapAnswerToVisa,
  mapAnswerToLocations,
  detectLang,
  type RoleFunction,
} from "./tags/onboarding-mappers.js"
// Phase 54 — sole-writer for pa-users.tags Firestore I/O. All onboarding
// chat hooks, CV ingest, and migration scripts funnel through this module
// so the write contract has one auditable code path.
export {
  writeUserTagsFull,
  applyPartialUserTags,
  auditUsersWithoutTags,
  type PartialUserTags,
  type WriteUserTagsOpts,
} from "./tags/user-tags-writer.js"
// Phase 54 — onboarding chat-answer → canonical Phase 52 vocab mappers.
export {
  mapAnswerToRoleFunction,
  mapAnswerToVisa,
  mapAnswerToLocations,
  mapAnswerToYoeBucket,
  bucketYoe,
  detectLang,
  type YoeRange,
} from "./tags/onboarding-mappers.js"

type RunAgentTurn = typeof defaultRunAgentTurn

const INBOUND_LEASE_MS = Number(process.env.PA_INBOUND_LEASE_MS || "120000")

export type OrchestratorStore = {
  markEventRunning(eventId: string): Promise<void>
  markEventSucceeded(eventId: string): Promise<void>
  markEventFailed(eventId: string, errorCode: string, error: string): Promise<void>
  createTurn(event: InboundEvent): Promise<string>
  updateTurn(turnId: string, patch: Record<string, unknown>): Promise<void>
  appendMessage(message: Omit<ChatMessage, "id"> & { id?: string }): Promise<void>
  getAgentForUser(userId: string): Promise<AgentDef | null>
  /**
   * Phase 11.3 — return the operator-set Mem0/Qdrant partition key for
   * this user, or `undefined` when unset. Callers MUST run the result
   * through `resolveMem0PartitionKey` (or use the resolver helper) — never
   * pass the raw value directly to mem0Search/mem0Add. Returning
   * `undefined` is the legacy path; the resolver falls back to `userId`.
   */
  getMem0UserId(userId: string): Promise<string | undefined>
  loadHistory(sessionId: string, limit: number): Promise<ChatMessage[]>
  enqueueOutbound(userId: string, toE164: string, body: string, input?: Partial<OutboundMessage>): Promise<void>
  listMemoryFacts(userId: string): Promise<MemoryFact[]>
  createMemoryFact(userId: string, content: string): Promise<string>
  deleteMemoryFacts(userId: string, factIds: string[], eventId?: string): Promise<void>
  recordMemoryAction(input: {
    userId: string
    eventId?: string
    action: MemoryActionType
    status: ProcessingStatus
    content?: string
    factIds?: string[]
    reason?: string
  }): Promise<void>
  loadPersonalizationContext(
    agent: AgentDef,
    input: {
      userId: string
      /**
       * Phase 11.3 — resolved Mem0/Qdrant partition key. Caller (this
       * orchestrator) populates from `getMem0UserId` below.
       */
      mem0UserId?: string
      sessionId: string
      userMessage: string
      memoryMode: AgentDef["memoryMode"]
    },
    history: ChatMessage[]
  ): Promise<LoadContextResult>
  /**
   * Phase 10.5 T7 — build the per-turn AgentTurnTool[] for the SDK.
   * Default Firestore impl wraps `buildTurnTools` (free function) bound to
   * a Firestore handle. Tests can return [] or fake tools without touching
   * a connector registry.
   */
  buildTurnTools(
    agent: AgentDef,
    turn: { turnId: string; userId: string; sessionId: string }
  ): Promise<AgentTurnTool[]>
  /**
   * Phase 10.5 T9 — emit deferred-audit pa_tool_calls rows for hosted SDK
   * tools (e.g. web_search) that the SDK invoked internally. The synthetic
   * row preserves Phase 10's pa_tool_calls shape so the dashboard's
   * connector tab continues to render web_search hits even though the
   * runtime call did not pass through `runConnector`.
   */
  recordHostedToolCalls(input: {
    turnId: string
    userId: string
    sessionId: string
    calls: { name: string; count: number }[]
  }): Promise<void>
  /**
   * Phase 10.5 T3 — factory for the SDK Session backing this turn.
   * Default Firestore impl returns FirestoreSession bound to pa_messages.
   * Tests can return a fake. The orchestrator never sees Firestore directly
   * here, preserving the @pa/agent-runtime ↔ firebase-admin boundary at the
   * adapter level.
   */
  createSession(input: { sessionId: string; userId: string }): Session
  runAgentTurn: RunAgentTurn
  afterAssistantTurn(agent: AgentDef, input: {
    userId: string
    /** Phase 11.3 — resolved Mem0/Qdrant partition key. */
    mem0UserId?: string
    sessionId: string
    userText: string
    assistantText: string
    memoryMode: AgentDef["memoryMode"]
  }): Promise<AfterTurnResult>
  /**
   * In-band test-admin reset trigger. When `user.testMode === true` AND the
   * inbound `event.body` matches one of `RESET_PATTERNS`, the store runs
   * `clearUserMemory(userId, ...)` and returns `{ handled: true, summary }`.
   * Otherwise returns `{ handled: false }` and the orchestrator falls through
   * to normal memory-command + LLM routing.
   *
   * Production users (testMode unset/false) ALWAYS get `handled: false`,
   * even if they happen to type the magic string.
   */
  maybeHandleResetCommand(event: InboundEvent): Promise<{ handled: boolean; summary?: string }>
  nowIso(): string
  log(...args: unknown[]): void
  /**
   * v1.1 P0 — rate limit + regex injection gate before model turn.
   * Default Firestore impl uses @pa/pa-safety; tests return allow: true.
   */
  /**
   * Phase 46 — extended return: safety-check may also surface `action`
   * (respond_sanitized | silent_drop | escalate) + `severity`. Old callers
   * that return `{ allow, reason? }` continue to work because new fields are
   * optional. Default impl uses @pa/pa-safety `runSafetyCheck`.
   */
  checkInboundSafety(event: InboundEvent): Promise<{
    allow: boolean
    reason?: string
    action?: SafetyAction
    severity?: SafetySeverity
  }>
  /**
   * Phase 22 — cancel all pending proactive jobs for a user (D-07, PROACTIVE-06).
   * Returns the count of jobs cancelled.
   */
  cancelAllPendingProactiveJobs(userId: string): Promise<number>
  pauseJobRecommendationSubscription?(userId: string, input: {
    inboundEventId: string
    sessionId: string
    reason: "candidate_cancel"
    occurredAt: string
  }): Promise<{ paused: boolean }>
  resumeJobRecommendationSubscription?(userId: string, input: {
    inboundEventId: string
    sessionId: string
    reason: "candidate_restart"
    occurredAt: string
  }): Promise<{ resumed: boolean }>
  /**
   * Phase 22 — write proactive_cancel audit event (D-09).
   */
  writeProactiveCancelAudit(input: {
    userId: string
    sessionId: string
    inboundEventId: string
    cancelledCount: number
  }): Promise<void>
  /**
   * Candidate privacy intake from trusted conversation channels. Used for
   * iMessage export/delete/privacy questions after the phone has resolved to a
   * canonical `pa-users/{uid}` doc.
   */
  createPrivacyRequest?(input: {
    userId: string
    kind: PrivacyRequestKind
    detail: string
    eventId: string
    sessionId: string
  }): Promise<{ requestId: string; kind: PrivacyRequestKind; created: boolean; existingOpen: boolean }>
  getRecentLifecycleEventForReply?(userId: string): Promise<{
    eventId: string
    eventType: "laid_off_checkin" | "match_notification" | "profile_freshness_nudge" | "status_followup"
    createdAt?: string
    lastTouchAt?: string
  } | null>
  recordLifecycleReply?(input: {
    userId: string
    sessionId: string
    eventId: string
    turnId: string
    inboundEventId: string
    eventType: "laid_off_checkin" | "match_notification" | "profile_freshness_nudge" | "status_followup"
    occurredAt: string
    sourceText: string
    update: LifecycleProfileUpdate
  }): Promise<void>
  /**
   * Phase 23 — fetch minimal user fields needed for onboarding state machine.
   * Returns null when the user doc doesn't exist yet (edge case for new users).
   */
  getOnboardingUser(userId: string): Promise<{
    id: string
    phoneE164: string
    onboardingState?:
      | "pending"
      | "first_mes_sent"
      | "grounding_q1_asked"
      | "q_tos_asked"
      | "q_role_asked"
      | "q_yoe_asked"
      | "q_visa_asked"
      | "q_startup_pref_asked"
      | "q_location_asked"
      | "q_resume_asked"
      | "complete"
    /** Phase 44 — read so orchestrator can decide reusable-trigger flow. */
    statedPreferences?: import("@pa/core-types").StatedPreferences
    /** iter31 — operator-set HITL runtime mode (auto | paused). */
    runtimeMode?: "auto" | "paused"
    /** v1.6 unified tag system (D8) — canonical user tags incl. preferredLang. */
    tags?: import("./tags/user-tags-merger.js").UserTags
    firstName?: string
    displayName?: string
    source?: string
    latestResumeArtifactId?: string
    jobTitle?: string
    lastCompany?: string
    location?: string
    workSession?: Record<string, unknown> | null
    sharedOnboarding?: Record<string, unknown> | null
    candidateContext?: Record<string, unknown> | null
    layoffContext?: {
      lastCompany?: string | null
      jobTitle?: string | null
      location?: string | null
    } | Record<string, unknown> | null
  } | null>
  /**
   * Phase 23 — apply onboarding step to advance user state + promote beta participant.
   */
  applyOnboarding(
    userId: string,
    phoneE164: string,
    step: OnboardingStep,
    opts?: {
      now?: string
      /** Phase 44 — previous step asked (for parsing user reply into statedPreferences). */
      priorAskedStep?: OnboardingStep
      /** Phase 44 — user's reply to that prior step. */
      priorUserReply?: string
      /**
       * Phase 52 — F1 fix: when true AND step is `send_first_mes`, we already
       * chained `ask_q_role` inline (intent-aware first_mes), so the state
       * jumps to `q_role_asked` directly, skipping `first_mes_sent`.
       */
      intentAcked?: boolean
      /**
       * Adam iter 24 — mid-probe vent suspension. When set, the onboarding
       * state is NOT advanced; user gets the same ask_q_X next time they
       * stop venting.
       */
      suspendedForVent?: boolean
      /** iter31 — see applyOnboardingStep opts of the same name. */
      tosAcceptedVersion?: string
      tosDeclined?: boolean
      intentAckTarget?: "q_role_asked" | "q_tos_asked"
      /**
       * iter34 hotfix 2026-05-05 — canonical Judge output bypasses regex.
       * When provided, this REPLACES the regex parse of priorAskedStep+
       * priorUserReply. The Q-as-class pipeline (runtime-bridge) passes
       * Judge canonical output here for q_lang / q_role / q_yoe /
       * q_visa / q_startup_pref / q_location accepts.
       *
       * 2026-05-06 P9 fix — was DECLARED in applyOnboardingStep opts but
       * MISSING from this interface AND the production wrapper at
       * `applyOnboarding` impl below. The omission silently dropped every
       * Judge-canonical write — q_lang's accepted "en" never landed in
       * `pa-users.tags.preferredLang`, leaving the user stuck on whatever
       * language was in `tags` from a prior session. Re-add to type AND
       * to the wrapper passthrough (line 3653-ish).
       */
      parsedAnswer?: Partial<import("@pa/core-types").StatedPreferences>
    }
  ): Promise<void>

  /**
   * iter31 — Human-in-the-loop runtime mode. Returns "paused" when an
   * operator has paused the agent for this user (orchestrator skips reply
   * generation but still appends inbound to pa-messages so memory/audit
   * are preserved). Default "auto" when unset / user-not-found.
   */
  getRuntimeMode?(userId: string): Promise<"auto" | "paused">

  /**
   * iter31 — current ToS version string for acceptance writes. Reads
   * pa-remote-config/platform.tosVersion; defaults to "v1.0" when unset.
   */
  getTosVersion?(): Promise<string>

  /**
   * iter32 — has the user's CV been ingested + parsed? cv-ingest pipeline
   * writes a parsedCandidateResumes row when Sendblue delivers the
   * iMessage attachment. The deterministic onboarding's CV gate (Adam
   * directive 2026-05-04 #2 "stricter") holds at q_resume_asked until
   * this returns true.
   */
  getUserCvParsed?(userId: string): Promise<boolean>

  /**
   * iter33 P3 — produce a 1-2 sentence CV analysis blurb in the user's
   * preferred language. Reads parsedCandidateResumes for the user, calls
   * Qwen-7B via SiliconFlow (or test stub), and returns the summary.
   * Returns null when LLM is unconfigured or fails — the deterministic
   * dispatcher then falls back to a generic "thanks for sending it" line
   * so onboarding completes either way.
   */
  generateCvAnalysis?(
    userId: string,
    lang: "zh" | "en"
  ): Promise<{ summary: string } | null>

  /**
   * iter33 P4 — produce a 1-message blurb pushing 2 job recommendations
   * to the user before agent runtime activates. Implementations may:
   *  - read recently-cached matches (e.g. pa-job-profiles ledger) and
   *    format the top 2, OR
   *  - fall back to a deferred-promise line ("first batch lands tomorrow
   *    around 9am") when no live matches exist yet
   * Returns null when LLM/DB lookups fail; deterministic dispatcher then
   * emits a generic deferred-promise so onboarding always completes. `force`
   * is reserved for an explicit candidate request and bypasses daily-batch
   * cooldowns.
   */
  generateJobRecs?(
    userId: string,
    lang: "zh" | "en",
    opts?: {
      force?: boolean
      requestedCount?: number
      roleFocus?: string[]
      collabPrescreenOnly?: boolean
      excludeInternships?: boolean
    }
  ): Promise<{
    message: string
    recCount: number
    topJob?: { jobId: string; title: string; company: string; score: number }
  } | null>

  /** Collab funnel — start prescreen after candidate accepts invite. */
  startPrescreenForJob?: (input: {
    userId: string
    jobId: string
    toE164: string
  }) => Promise<{ ok: boolean; reason?: string }>

  sendReaction?: (input: {
    to: string
    messageHandle: string
    reaction: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question"
    userId?: string
  }) => Promise<void>

  /**
   * iter34 P0.2 — generic LLM-fallback intent extractor for the
   * non-email deterministic Q's (q_role / q_yoe / q_visa /
   * q_startup_pref / q_location). Adam directive 2026-05-05 ("不只是
   * email, 包括所有一开始的 deterministic 的 question 都需要加这个").
   *
   * Called when the regex/keyword parser failed AND the user msg has
   * step-relevant signal (heuristic per-step). Returns structured intent
   * so the dispatcher can advance (intent="provided"+value), retry with
   * clarification (intent="unclear"+clarifyingQuestion), or fall back
   * deterministically (null).
   *
   * `value` shape varies by step:
   *   - ask_q_role      → string (free-form role token, e.g. "swe", "pm")
   *   - ask_q_yoe       → number | "fresh" (years OR fresh-grad sentinel)
   *   - ask_q_visa      → "citizen" | "gc" | "opt" | "h1b" | "sponsorship"
   *   - ask_q_startup_pref → "startup" | "bigtech" | "either"
   *   - ask_q_location  → string (free-form location, e.g. "SF", "remote")
   *
   * Cost ~$0.0002/edge call; latency <2s p99; fail-safe (returns null
   * → caller falls back to deterministic re-ask).
   */
  extractAnswerIntent?(
    step:
      | "ask_q_role"
      | "ask_q_yoe"
      | "ask_q_visa"
      | "ask_q_startup_pref"
      | "ask_q_location",
    reply: string,
    lang: "zh" | "en"
  ): Promise<
    | { intent: "provided"; value: string | number; confidence: number }
    | { intent: "unclear"; clarifyingQuestion: string }
    | null
  >

  /**
   * Phase 24.5 — optional Firestore handle for `getFlag()` reads. Tests omit
   * `db`; production wires the live Firestore so flag-backed kill-switches
   * (e.g. `PA_VOICE_MIRROR_DISABLED`) consult `pa-feature-flags`. env vars
   * still short-circuit inside the SDK as the emergency override.
   */
  db?: Firestore
}

const HISTORY_LIMIT = Number(process.env.PA_MESSAGE_HISTORY || "40")

export function isInboundLeaseExpired(leaseUntil: string | undefined, now = new Date()): boolean {
  if (!leaseUntil) return true
  const t = Date.parse(leaseUntil)
  return !Number.isFinite(t) || t <= now.getTime()
}

function memoryReplyForList(facts: { content: string }[], lang: "zh" | "en" = "zh") {
  const unique = uniqueFactsByContent(facts)
  if (unique.length === 0) {
    return lang === "zh"
      ? "我现在还没有保存你的长期记忆。你可以说：记住 我喜欢..."
      : "I do not have saved long-term notes for you yet. You can say: remember I like..."
  }
  const heading = lang === "zh" ? "我记得这些：" : "Here is what I remember:"
  return `${heading}\n${unique.map((f, i) => `${i + 1}. ${f.content}`).join("\n")}`
}

/**
 * Phase 11.1.3 — legacy concatenated memory block.
 *
 * Surface contract:
 *  - LEGACY-FALLBACK ONLY. Consumed by the chat.completions emergency-
 *    rollback path (`PA_AGENT_RUNTIME=chat_completions`) via
 *    `runAgentTurn`'s legacy `memoryBlock` field. Keeping this helper
 *    intact keeps the kill-switch contract unchanged.
 *  - The default Agents SDK path NO LONGER calls this helper for the
 *    recall half of systemInputs. Use `buildRecallSystemInput` instead;
 *    facts now ride exclusively in the persona card (Phase 11.1.2)
 *    so the recall channel reflects only Mem0 semantic recall.
 *  - Persona card does NOT flow through this helper; persona is its own
 *    discrete `systemInputs[0]` entry built by `buildPersonaCard`.
 */
export function memoryBlockWithFacts(memoryBlock: string | null, facts: { content: string }[]) {
  const unique = uniqueFactsByContent(facts)
  const factBlock = unique.length ? unique.map((f) => `- ${f.content}`).join("\n") : null
  if (memoryBlock && factBlock) return `Confirmed user facts:\n${factBlock}\n\nRelevant memory:\n${memoryBlock}`
  if (factBlock) return `Confirmed user facts:\n${factBlock}`
  return memoryBlock
}

/**
 * Phase 11.1 cleanup D2 — recall-only system input for the default Agents
 * SDK path. Decoupled from `memoryBlockWithFacts` (which is now
 * legacy-fallback only). Persona/facts are NOT prepended here — the
 * persona card is its own discrete `systemInputs[0]` entry from 11.1.2.
 *
 * @returns The `Memory context:\n…` block alone, or `null` when there is
 *          no Mem0 recall to surface (no bare heading is ever injected).
 */
export function buildRecallSystemInput(memoryBlock: string | null): string | null {
  if (!memoryBlock) return null
  return `Memory context:\n${memoryBlock}`
}

function normalizedFactContent(content: string) {
  return content.trim().replace(/\s+/g, " ")
}

function uniqueFactsByContent<T extends { content: string }>(facts: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const fact of facts) {
    const key = normalizedFactContent(fact.content)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(fact)
  }
  return out
}

function shouldSuppressOutbound(event: InboundEvent): boolean {
  const harness = event.rawMeta?.harness
  return Boolean(
    harness &&
      typeof harness === "object" &&
      "suppressOutbound" in harness &&
      (harness as { suppressOutbound?: unknown }).suppressOutbound === true
  )
}

const CANDIDATE_LIFECYCLE_EVENT_COLLECTION = "pa-candidate-lifecycle-events"
const LIFECYCLE_REPLY_RECENCY_MS = 7 * 24 * 60 * 60 * 1000

type LifecycleEventType =
  | "laid_off_checkin"
  | "match_notification"
  | "profile_freshness_nudge"
  | "status_followup"

type LifecycleSearchStatus = "still_looking" | "interviewing" | "paused" | "not_looking"
type LifecyclePartialTags = PartialUserTags & { targetRoleFunction?: RoleFunction[] }

type LifecycleProfileUpdate = {
  summary: string
  ack: string
  memoryFact?: string
  tags: LifecyclePartialTags
  statedPreferences: Record<string, unknown>
  evidence: {
    searchStatus?: LifecycleSearchStatus
    roleFocus?: string[]
    targetRoleFunction?: string[]
    yoeRange?: [number, number]
    careerStage?: "student" | "intern" | "entry_level" | "junior" | "mid_level" | "senior"
    targetLocations?: string[]
    locationLabels?: string[]
    visaStatus?: string
    visaLabel?: string
    startupPreference?: "startup" | "bigtech" | "either"
    rawSignals: string[]
  }
}

function uniqStrings(values: Array<string | undefined | null>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : ""
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

function detectLifecycleSearchStatus(text: string): LifecycleSearchStatus | undefined {
  if (/\b(still\s+looking|looking|open\s+to|actively\s+searching|available|on\s+the\s+market)\b/i.test(text)) {
    return "still_looking"
  }
  if (/\b(interviewing|onsites?|final\s+round|offer\s+stage)\b/i.test(text)) {
    return "interviewing"
  }
  if (/\b(paused|pause|not\s+looking\s+right\s+now|taking\s+a\s+break)\b/i.test(text)) {
    return "paused"
  }
  if (/\b(not\s+looking|accepted\s+an?\s+offer|found\s+a\s+job|started\s+a\s+new\s+role)\b/i.test(text)) {
    return "not_looking"
  }
  return undefined
}

function detectLifecycleRoleFocus(text: string): string[] {
  const out: string[] = []
  if (/\b(full[-\s]?stack|fullstack)\b/i.test(text)) out.push("fullstack")
  if (/\b(front[-\s]?end|frontend|ui\s+engineer|react)\b/i.test(text)) out.push("frontend")
  if (/\b(back[-\s]?end|backend|api|server[-\s]?side)\b/i.test(text)) out.push("backend")
  if (/\b(product\s+ops|ops\s+tooling|dashboard|dashboards)\b/i.test(text)) out.push("product-ops tooling")
  return uniqStrings(out)
}

const ROLE_FUNCTION_LABELS_FOR_LIFECYCLE: Record<string, string> = {
  software_engineering: "software engineering",
  engineering_and_development: "engineering",
  data_analysis: "data analysis",
  product_management: "product management",
  business_analyst: "business analyst",
  creatives_and_design: "design",
  consultant: "consulting",
  accounting_and_finance: "accounting/finance",
  marketing: "marketing",
  management_and_executive: "management/executive",
  sales: "sales",
  human_resources: "human resources",
  legal_and_compliance: "legal/compliance",
  arts_and_entertainment: "arts/entertainment",
  education_and_training: "education/training",
  public_sector_and_government: "public sector/government",
  customer_service_and_support: "customer support",
}

function labelLifecycleRoleFunction(token: string): string {
  return ROLE_FUNCTION_LABELS_FOR_LIFECYCLE[token] ?? token.replace(/_/g, " ")
}

function lifecycleRoleLabels(targetRoleFunction: string[], roleFocus: string[]): string[] {
  return uniqStrings([
    ...roleFocus.filter((r) => r !== "product-ops tooling"),
    ...targetRoleFunction
      .filter((token) => !(token === "software_engineering" && roleFocus.length > 0))
      .map(labelLifecycleRoleFunction),
  ])
}

function detectRequestedYoeRange(text: string): {
  range: [number, number]
  careerStage: "student" | "intern" | "entry_level" | "junior" | "mid_level" | "senior"
  label: string
} | undefined {
  const body = text.trim()
  if (!body) return undefined
  const lower = body.toLowerCase()
  const hasExperienceContext =
    /\b(?:years?\s+of\s+experience|years?|yrs?|yoe|exp|experience|entry[-\s]?level|junior|new\s+grad|fresh\s+grad)\b/i.test(body) ||
    /(?:年经验|工作年限|经验|初级|应届)/.test(body)
  const ranges = [...lower.matchAll(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/g)]
    .map((match) => [Number(match[1]), Number(match[2])] as [number, number])
    .filter(([min, max]) => Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max >= min && max <= 50)
  if (ranges.length === 0 && !hasExperienceContext) return undefined

  if (ranges.length > 0 && (hasExperienceContext || /\b(?:roles?|jobs?|positions?|opportunities|openings|listings|matches)\b/i.test(body))) {
    const min = Math.min(...ranges.map(([start]) => start))
    const max = Math.max(...ranges.map(([, end]) => end))
    const careerStage =
      max <= 1 ? "entry_level" :
      max <= 3 ? "entry_level" :
      max <= 5 ? "junior" :
      max <= 8 ? "mid_level" :
      "senior"
    return { range: [min, max], careerStage, label: `${min}-${max} years experience` }
  }

  if (/\b(?:new\s+grad|fresh\s+grad|entry[-\s]?level|junior)\b/i.test(body) || /(?:应届|初级)/.test(body)) {
    return { range: [0, 3], careerStage: "entry_level", label: "0-3 years experience" }
  }
  return undefined
}

function shouldExcludeInternshipsForExplicitJobSearch(text: string): boolean {
  const yoe = detectRequestedYoeRange(text)
  if (!yoe || yoe.range[1] > 3) return false
  return !/\b(?:intern|internship|internships|co[-\s]?op|phd|doctoral)\b/i.test(text)
}

function detectStartupPreferenceForLifecycle(text: string): "startup" | "bigtech" | "either" | undefined {
  if (/\b(early[-\s]?stage|startup|startups|founding|seed|series\s+[ab]|yc)\b/i.test(text)) return "startup"
  if (/\b(big\s*tech|faang|fang|mag\s*7|large\s+company|enterprise)\b/i.test(text)) return "bigtech"
  if (/\b(open\s+to\s+either|either|both|no\s+preference)\b/i.test(text)) return "either"
  return undefined
}

function visaTagForLifecycle(text: string): { tag?: "citizen" | "gc" | "opt" | "h1b" | "sponsor_needed" | "other"; stated?: string; label?: string } {
  const mapped = mapAnswerToVisa(text)
  if (mapped === "other") return {}
  if (mapped === "permanent_resident") return { tag: "gc", stated: "gc", label: "green card / permanent resident" }
  if (mapped === "sponsor_needed") {
    const hasOpt = /\b(stem\s*)?opt\b/i.test(text)
    const hasH1b = /\bh[-\s]?1\s*b\b/i.test(text)
    const label = hasOpt && hasH1b
      ? "OPT now with future H-1B sponsorship"
      : hasOpt
        ? "OPT / sponsorship needs"
        : hasH1b
          ? "H-1B sponsorship needs"
          : "future sponsorship needs"
    return { tag: "sponsor_needed", stated: "sponsorship_needed", label }
  }
  return { tag: mapped, stated: mapped, label: mapped === "citizen" ? "US citizen" : mapped }
}

function labelLocationToken(token: string): string {
  const labels: Record<string, string> = {
    new_york_metro: "NYC",
    remote_united_states: "remote",
    remote_anywhere: "remote",
    remote_global: "remote",
    san_francisco_bay_area: "SF Bay Area",
    los_angeles_metro: "Los Angeles",
    seattle_metro: "Seattle",
  }
  return labels[token] ?? token.replace(/_/g, " ")
}

function locationTokenMentionIndex(text: string, token: string): number {
  const lower = text.toLowerCase()
  const rules: Record<string, RegExp[]> = {
    new_york_metro: [/\bnyc\b/i, /new\s*york/i, /纽约/i],
    remote_united_states: [/remote/i, /在家/i],
    remote_anywhere: [/anywhere/i, /remote/i],
    remote_global: [/remote/i],
    san_francisco_bay_area: [/\bsf\b/i, /san\s*francisco/i, /bay\s*area/i, /湾区/i],
    los_angeles_metro: [/\bla\b/i, /los\s*angeles/i, /洛杉矶/i],
    seattle_metro: [/seattle/i, /西雅图/i],
  }
  const matches = rules[token] ?? [new RegExp(token.replace(/_/g, "\\s+"), "i")]
  let best = Number.POSITIVE_INFINITY
  for (const rule of matches) {
    const hit = lower.match(rule)
    if (hit?.index !== undefined && hit.index < best) best = hit.index
  }
  return best
}

function orderLocationTokensByMention(text: string, tokens: string[]): string[] {
  return [...tokens].sort((a, b) => {
    const aIdx = locationTokenMentionIndex(text, a)
    const bIdx = locationTokenMentionIndex(text, b)
    if (aIdx !== bIdx) return aIdx - bIdx
    return 0
  })
}

function adjustLifecycleRoleFunctionsForPreferenceText(
  text: string,
  roleFunctions: RoleFunction[],
): RoleFunction[] {
  const out = new Set<RoleFunction>(roleFunctions)
  if (/\b(product\s*[/+&]?\s*strategy|product\s+strategy|strategy\s+roles?|product\s+roles?|product\s+management|product\s+manager|\bpm\b)\b/i.test(text)) {
    out.add("product_management")
  }
  if (
    /\b(no|not|don't|do not|avoid|exclude|stop|without)\b[^.!?]{0,70}\b(software|developer|engineering|engineer|swe)\b/i.test(text) ||
    /\b(software|developer|engineering|engineer|swe)\b[^.!?]{0,30}\b(no|not|off|wrong|avoid|exclude)\b/i.test(text)
  ) {
    out.delete("software_engineering")
    out.delete("engineering_and_development")
  }
  return Array.from(out)
}

function extractLifecycleProfileUpdate(text: string): LifecycleProfileUpdate | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const targetRoleFunction = adjustLifecycleRoleFunctionsForPreferenceText(
    trimmed,
    mapAnswerToRoleFunction(trimmed),
  )
  const roleFocus = detectLifecycleRoleFocus(trimmed)
  const yoe = detectRequestedYoeRange(trimmed)
  const targetLocations = orderLocationTokensByMention(trimmed, mapAnswerToLocations(trimmed))
  const locationLabels = targetLocations.map(labelLocationToken)
  const visa = visaTagForLifecycle(trimmed)
  const startupPreference = detectStartupPreferenceForLifecycle(trimmed)
  const searchStatus = detectLifecycleSearchStatus(trimmed)

  const rawSignals = uniqStrings([
    searchStatus ? `search_status:${searchStatus}` : null,
    ...roleFocus.map((r) => `role_focus:${r}`),
    ...targetRoleFunction.map((r) => `role_function:${r}`),
    yoe ? `yoe_range:${yoe.range[0]}-${yoe.range[1]}` : null,
    yoe ? `career_stage:${yoe.careerStage}` : null,
    ...targetLocations.map((l) => `location:${l}`),
    visa.tag ? `visa:${visa.tag}` : null,
    startupPreference ? `company_stage:${startupPreference}` : null,
  ])

  if (rawSignals.length === 0) return null

  const roleLabels = lifecycleRoleLabels(targetRoleFunction, roleFocus)
  const summaryParts: string[] = []
  if (searchStatus === "still_looking") summaryParts.push("still looking")
  if (searchStatus === "interviewing") summaryParts.push("currently interviewing")
  if (searchStatus === "paused") summaryParts.push("search paused")
  if (searchStatus === "not_looking") summaryParts.push("not actively looking")
  if (roleLabels.length > 0) summaryParts.push(`targeting ${roleLabels.join("/")} roles`)
  if (yoe) summaryParts.push(`targets ${yoe.label} roles`)
  if (locationLabels.length > 0) summaryParts.push(`prefers ${locationLabels.join(" or ")}`)
  if (startupPreference === "startup") summaryParts.push("prefers early-stage startups")
  if (startupPreference === "bigtech") summaryParts.push("prefers larger companies")
  if (startupPreference === "either") summaryParts.push("open on company stage")
  if (visa.label) summaryParts.push(visa.label)
  const summary = summaryParts.length > 0 ? summaryParts.join("; ") : "shared a profile update"

  const ackFocus: string[] = []
  if (roleLabels.length > 0) ackFocus.push(`${roleLabels.join("/")} roles`)
  if (yoe) ackFocus.push(`${yoe.label} roles`)
  if (locationLabels.length > 0) ackFocus.push(locationLabels.join(" or "))
  if (startupPreference === "startup") ackFocus.push("early-stage startups")
  if (startupPreference === "bigtech") ackFocus.push("larger-company roles")
  if (visa.label) ackFocus.push(visa.label)
  const ack = ackFocus.length > 0
    ? `Got it - I'll keep matches focused on ${ackFocus.join(", ")}.`
    : "Got it - I updated your profile notes for future matches."

  const tags: LifecyclePartialTags = {}
  if (targetRoleFunction.length > 0) tags.targetRoleFunction = targetRoleFunction
  if (yoe) {
    tags.yoeRange = yoe.range
    tags.careerStage = yoe.careerStage
  }
  if (targetLocations.length > 0) tags.targetLocations = targetLocations
  if (visa.tag) tags.visaStatus = visa.tag
  if (startupPreference) tags.prefersStartup = startupPreference
  if (searchStatus === "still_looking") tags.urgentlySeeking = true

  const statedPreferences: Record<string, unknown> = {}
  if (roleLabels.length > 0) statedPreferences.targetRole = roleLabels
  if (yoe) statedPreferences.yoeRange = yoe.range
  if (locationLabels.length > 0) statedPreferences.targetLocations = locationLabels
  if (visa.stated) statedPreferences.visaStatus = visa.stated
  if (startupPreference) statedPreferences.prefersStartup = startupPreference === "startup" ? true : startupPreference === "bigtech" ? false : null
  if (searchStatus === "still_looking") statedPreferences.urgentlySeeking = true

  return {
    summary,
    ack,
    memoryFact: `Candidate profile update: ${summary}.`,
    tags,
    statedPreferences,
    evidence: {
      searchStatus,
      roleFocus,
      targetRoleFunction,
      yoeRange: yoe?.range,
      careerStage: yoe?.careerStage,
      targetLocations,
      locationLabels,
      visaStatus: visa.tag,
      visaLabel: visa.label,
      startupPreference,
      rawSignals,
    },
  }
}

async function handleLifecycleProfileReply(
  event: InboundEvent,
  store: OrchestratorStore,
  turnId: string
): Promise<boolean> {
  if (isJobRecommendationExplanationRequest(event.body)) return false
  if (isExplicitJobSearchRequest(event.body)) return false
  if (!store.getRecentLifecycleEventForReply || !store.recordLifecycleReply) return false
  const lifecycle = await store.getRecentLifecycleEventForReply(event.userId)
  if (!lifecycle) return false
  if (lifecycle.eventType !== "profile_freshness_nudge" && lifecycle.eventType !== "status_followup") {
    return false
  }
  const update = extractLifecycleProfileUpdate(event.body)
  if (!update) return false

  await store.updateTurn(turnId, {
    stage: "lifecycle_reply",
    directIntent: "lifecycle_profile_update",
    lifecycleEventId: lifecycle.eventId,
    lifecycleEventType: lifecycle.eventType,
    lifecycleSignals: update.evidence.rawSignals,
    updatedAt: store.nowIso(),
  })
  await store.recordLifecycleReply({
    userId: event.userId,
    sessionId: event.sessionId,
    eventId: lifecycle.eventId,
    eventType: lifecycle.eventType,
    turnId,
    inboundEventId: event.id,
    occurredAt: store.nowIso(),
    sourceText: event.body,
    update,
  })

  if (update.memoryFact) {
    try {
      const facts = await store.listMemoryFacts(event.userId)
      const exists = facts.some((fact) => normalizedFactContent(fact.content) === normalizedFactContent(update.memoryFact!))
      if (!exists) {
        await store.createMemoryFact(event.userId, update.memoryFact)
      }
    } catch (err) {
      store.log("pa.lifecycle_reply.memory_fact_failed", {
        userId: event.userId,
        eventId: event.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  await sendMemoryReply(store, event, turnId, update.ack)
  return true
}

function detectOnboardingProcessQuestion(body: string): boolean {
  const t = body.toLowerCase()
  return /\b(legit|real|scam|who are you|what is this|how does this work|what happens next|why do you need|hiring manager|pre[-\s]?screen|prescreen)\b/.test(t)
}

function currentOnboardingAskForProcessReply(state: string | undefined): string {
  if (state === "q_role_asked") {
    return "To keep going, what kinds of roles should I focus on for you?"
  }
  if (state === "q_yoe_asked") {
    return "To keep going, roughly how many years of work experience should I put on your profile?"
  }
  if (state === "q_visa_asked") {
    return "To keep going, what should I put for your US work authorization?"
  }
  if (state === "q_startup_pref_asked") {
    return "To keep going, do you prefer startups, larger companies, or either?"
  }
  if (state === "q_location_asked") {
    return "To keep going, what country and locations or remote setup should I use for matching?"
  }
  if (state === "q_resume_asked" || state === "q_resume_processing") {
    return "To keep going, I need your resume so we can parse it and tailor the next screen."
  }
  return "To keep going, answer the last profile question in your own words."
}

function composeOnboardingProcessReply(onboardingState: string | undefined): string {
  return [
    "Yes - this is WeKruit. Claire collects the basics for your candidate profile so we can match you to roles and, for partnered roles, route the pre-screen directly to the hiring manager instead of making you start from scratch.",
    "I will keep the flow focused on recruiting and use what you share for your WeKruit profile, matching, and role screens.",
    currentOnboardingAskForProcessReply(onboardingState),
  ].join("\n\n")
}

/**
 * Phase 44 — flag check for v1.5 Stream-B onboarding probe v2.
 * Default OFF. Env override: `PA_ONBOARDING_PROBE_V2_DISABLED=true` short-circuits to false.
 */
async function isOnboardingProbeV2Enabled(
  db: Firestore | undefined,
  userId: string | undefined
): Promise<boolean> {
  if (process.env.PA_ONBOARDING_PROBE_V2_DISABLED === "true") return false
  if (!db) return false
  try {
    const v = await getFlag(db, "paOnboardingProbeV2Enabled", {
      userId,
      env: process.env,
    })
    return v === true
  } catch {
    return false
  }
}

/**
 * Phase 52 — F1 fix flag for turn-0 intent ack on cold-start onboarding.
 *
 * Default ON (fail-OPEN — flag-read errors keep the new behavior active so
 * a transient Firestore blip doesn't regress us back to the bug). Emergency
 * disable: env `PA_ONBOARDING_INTENT_ACK_DISABLED=true`.
 */
async function isOnboardingIntentAckEnabled(
  db: Firestore | undefined,
  userId: string | undefined
): Promise<boolean> {
  if (process.env.PA_ONBOARDING_INTENT_ACK_DISABLED === "true") return false
  if (!db) return true // fail-OPEN when no db handle (test mocks); flag default is ON
  try {
    const v = await getFlag(
      db,
      "paOnboardingIntentAckEnabled",
      { userId, env: process.env },
      true /* defaultValue: ON */
    )
    return v !== false
  } catch {
    // Flag-read error → keep the new behavior active (fail-OPEN). The bug we
    // are fixing is silent intent loss, not a feature-flag toggle.
    return true
  }
}

/**
 * iter31 — ToS + privacy acceptance gate. Default OFF for in-flight users.
 * Flip ON via `paOnboardingTosGateEnabled` Firestore flag for biz testers.
 */
async function isOnboardingTosGateEnabled(
  db: Firestore | undefined,
  userId: string | undefined
): Promise<boolean> {
  if (process.env.PA_ONBOARDING_TOS_GATE_DISABLED === "true") return false
  if (!db) return false
  try {
    const v = await getFlag(db, "paOnboardingTosGateEnabled", {
      userId,
      env: process.env,
    })
    return v === true
  } catch {
    return false
  }
}

/**
 * Phase 44 — given the user's onboardingState BEFORE this turn, return the
 * step that asked the question we're now receiving the reply to. Used to
 * route `event.body` into the right `parseUserAnswerForStep` parser.
 */
function priorOnboardingAskedStep(
  state: string | undefined
): OnboardingStep | undefined {
  if (state === "q_role_asked") return "ask_q_role"
  if (state === "q_yoe_asked") return "ask_q_yoe"
  if (state === "q_visa_asked") return "ask_q_visa"
  if (state === "q_startup_pref_asked") return "ask_q_startup_pref"
  if (state === "q_location_asked") return "ask_q_location"
  if (state === "q_resume_asked") return "ask_q_resume"
  // q_tos_asked maps to its corresponding ask_* step for parser lookups.
  if (state === "q_tos_asked") return "ask_q_tos"
  return undefined
}


async function requireAgentForUser(store: OrchestratorStore, userId: string): Promise<AgentDef> {
  const agent = await store.getAgentForUser(userId)
  if (!agent) throw Object.assign(new Error("No agent configured"), { code: "NO_AGENT" })
  return agent
}

function sendblueMessageHandleFromEventId(eventId: string): string | undefined {
  const prefix = "sendblue-"
  return eventId.startsWith(prefix) ? eventId.slice(prefix.length) : undefined
}

function inboundMessageHandleForReaction(event: InboundEvent): string | undefined {
  const metadata = event as InboundEvent & {
    messageHandle?: unknown
    rawPayload?: Record<string, unknown>
    rawMeta?: Record<string, unknown>
  }
  const candidates = [
    metadata.messageHandle,
    metadata.rawMeta?.messageHandle,
    metadata.rawMeta?.message_handle,
    metadata.rawPayload?.messageHandle,
    metadata.rawPayload?.message_handle,
    sendblueMessageHandleFromEventId(event.id),
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue
    const trimmed = candidate.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

/**
 * Adam 2026-05-19 voice polish §3 — build an outbound delivery plan for a
 * shared-onboarding composed reply. Returns `null` (legacy single-bubble
 * path) when the choreographer flag is OFF, the user has reply suppressed,
 * or anything goes sideways resolving the profile. Tapback ships via the
 * same planner path as general chat when `paReactionTapbackEnabled` is on
 * and Sendblue gave us a messageHandle on the inbound event.
 */
async function buildSharedOnboardingDeliveryPlan(args: {
  store: OrchestratorStore
  event: InboundEvent
  turnId: string
  reply: string
  force1?: boolean
}): Promise<OutboundDeliveryPlan | null> {
  const { store, event, turnId, reply } = args
  if (shouldSuppressOutbound(event)) return null
  try {
    const choreoOn = await isBehaviorChoreographerEnabled(store.db, event.userId)
    if (!choreoOn) return null
    const tapbackOn = await isReactionTapbackEnabled(store.db, event.userId)
    const inboundMessageHandle = inboundMessageHandleForReaction(event)
    const profile = await resolveProfileForUser(
      "friend_onboarding",
      event.userId
    )
    return planOutboundDelivery({
      reply,
      turnId,
      profile,
      inboundBody: event.body ?? null,
      force1: args.force1 ?? false,
      hasMessageHandle: Boolean(inboundMessageHandle) && tapbackOn,
    })
  } catch (err) {
    store.log("pa.outbound.delivery_plan.shared_onboarding_error", {
      severity: "WARN",
      userId: event.userId,
      turnId,
      eventId: event.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

function buildSharedOnboardingBootstrapDeliveryPlan(reply: string): OutboundDeliveryPlan | null {
  const marker = " Before I match roles,"
  const splitAt = reply.indexOf(marker)
  if (splitAt <= 0) return null

  const first = reply.slice(0, splitAt).trim()
  const second = reply.slice(splitAt + 1).trim()
  if (!first || !second) return null

  return {
    mode: "text_split_2",
    textParts: [first, second],
    reason: "shared_onboarding_bootstrap_split_2",
    smsCount: 2,
  }
}

function sharedOnboardingOutboundSlice(store: OrchestratorStore): SharedOnboardingOutboundStore {
  return {
    db: store.db,
    log: (name, payload) => store.log(name, payload ?? {}),
    runAgentTurn: store.runAgentTurn as unknown as SharedOnboardingOutboundStore["runAgentTurn"],
    createSession: (input) => store.createSession(input),
    generateJobRecs: store.generateJobRecs,
    enqueueOutbound: (userId, toE164, body, input) =>
      store.enqueueOutbound(userId, toE164, body, input),
    sendReaction: store.sendReaction
      ? async ({ toE164, messageHandle, reaction }) =>
          store.sendReaction!({ to: toE164, messageHandle, reaction })
      : undefined,
    buildTurnTools: (agent, turn) => store.buildTurnTools(agent, turn),
  }
}

async function sendMemoryReply(
  store: OrchestratorStore,
  event: InboundEvent,
  turnId: string,
  body: string,
  opts: {
    /**
     * Adam 2026-05-19 voice polish §3 — when supplied, the planner output
     * (tapback + emoji + 1-2 text bubbles) replaces the legacy single-bubble enqueue.
     */
    deliveryPlan?: OutboundDeliveryPlan
    inboundMessageHandle?: string
    transcriptIdempotencyKey?: string
    allowImperfection?: boolean
    /** Set true only when tapback was already sent earlier in the turn. */
    skipTapback?: boolean
  } = {}
) {
  const { text: safe } = await applyTemplateOutboundHumanize({
    body,
    userId: event.userId,
    turnId,
    db: store.db,
    maxLength: 600,
    allowImperfection: opts.allowImperfection,
  })
  const at = store.nowIso()
  await store.appendMessage({
    id: `out-${event.id}`,
    sessionId: event.sessionId,
    userId: event.userId,
    role: "assistant",
    body: safe,
    createdAt: at,
    idempotencyKey: opts.transcriptIdempotencyKey ?? `out-${event.id}`,
    rawMeta: { source: "pa_orchestrator", turnId: turnId, eventId: event.id },
  })
  if (shouldSuppressOutbound(event)) return
  if (opts.deliveryPlan) {
    // Repoint planner.textParts onto the post-humanize `safe` body so a
    // mid-flight humanize transform (URL strip, normalization, char-cap)
    // doesn't desync planner output from what we actually ship. Split the
    // safe body using the same fraction the planner picked (so 2-part
    // plans stay 2-part).
    const plan = opts.deliveryPlan
    const repointed: OutboundDeliveryPlan =
      plan.textParts.length === 1
        ? { ...plan, textParts: [safe], smsCount: (plan.leadingEmojiSms ? 1 : 0) + 1 }
        : plan // 2-part: trust planner's earlier split; safe ≈ visible reply
    await sendPlannedOutbound(store, event, turnId, repointed, {
      sessionId: event.sessionId,
      inboundMessageHandle: opts.inboundMessageHandle,
      skipTapback: opts.skipTapback ?? false,
    })
    return
  }
  await store.enqueueOutbound(event.userId, event.from, safe, {
    sessionId: event.sessionId,
    role: "assistant",
    idempotencyKey: `outbound-${event.id}`,
  })
}

async function recordRuntimeFailureAlert(args: {
  store: OrchestratorStore
  event: InboundEvent
  turnId: string
  errorCode: string
  error: string
}): Promise<void> {
  if (!args.store.db) return
  try {
    await args.store.db.collection("pa-runtime-alerts").doc(`turn_failed_${args.event.id}`).set(
      {
        kind: "orchestrator_turn_failed",
        severity: "ERROR",
        userId: args.event.userId,
        sessionId: args.event.sessionId,
        inboundEventId: args.event.id,
        turnId: args.turnId,
        errorCode: args.errorCode,
        error: args.error,
        candidateVisibleFallbackSent: false,
        status: "open",
        createdAt: args.store.nowIso(),
        updatedAt: args.store.nowIso(),
      },
      { merge: true },
    )
  } catch (alertErr) {
    args.store.log("pa.runtime_alert.write_failed", {
      userId: args.event.userId,
      turnId: args.turnId,
      eventId: args.event.id,
      error: alertErr instanceof Error ? alertErr.message : String(alertErr),
    })
  }
}

/**
 * Adam 2026-05-19 voice polish §3 — execute an outbound delivery plan.
 *
 * Order is fixed (planner contract):
 *   1. tapback   — fires before any SMS lands so it visually decorates the
 *                  inbound bubble. Best-effort: failure logs `tapback_failed`
 *                  and we still ship the SMS payload.
 *   2. leading 👍 SMS — short single-emoji bubble, counted toward the
 *                  ≤2-SMS-per-turn invariant.
 *   3. text parts — 1 or 2 bubbles per the plan.
 *
 * Idempotency keys preserve the historical shape: textParts[0] keeps
 * `outbound-${eventId}` so replays of single-text turns dedupe against
 * pre-split pa-outbound docs; emoji uses `outbound-${eventId}-emoji`;
 * subsequent text parts use `-p2`, `-p3`. Caller is responsible for
 * `appendMessage` (we don't want to write an assistant row per emoji).
 */
async function sendPlannedOutbound(
  store: OrchestratorStore,
  event: InboundEvent,
  turnId: string,
  plan: OutboundDeliveryPlan,
  opts: {
    sessionId?: string
    inboundMessageHandle?: string
    /** Skip the tapback step (caller already fired one inline). */
    skipTapback?: boolean
  } = {}
): Promise<void> {
  const userId = event.userId
  const sessionId = opts.sessionId ?? event.sessionId

  if (
    !opts.skipTapback &&
    plan.tapback &&
    opts.inboundMessageHandle &&
    event.from &&
    store.sendReaction
  ) {
    try {
      await store.sendReaction({
        to: event.from,
        messageHandle: opts.inboundMessageHandle,
        reaction: plan.tapback,
        userId: event.userId,
      })
      store.log("pa.outbound.delivery_plan.tapback_sent", {
        userId,
        turnId,
        eventId: event.id,
        reaction: plan.tapback,
      })
    } catch (err) {
      store.log("pa.outbound.delivery_plan.tapback_failed", {
        userId,
        turnId,
        eventId: event.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (shouldSuppressOutbound(event)) {
    store.log("pa.outbound.delivery_plan.suppressed", {
      userId,
      turnId,
      eventId: event.id,
      mode: plan.mode,
    })
    return
  }

  store.log("pa.outbound.delivery_plan", {
    userId,
    turnId,
    eventId: event.id,
    mode: plan.mode,
    smsCount: plan.smsCount,
    leadingEmoji: plan.leadingEmojiSms ?? null,
    tapback: plan.tapback ?? null,
    reason: plan.reason,
  })

  // Defensive — planner guarantees ≤2; log if a future regression breaks it.
  if (plan.smsCount < 1 || plan.smsCount > 2) {
    store.log("pa.outbound.invariant_violation", {
      severity: "ERROR",
      turnId,
      userId,
      eventId: event.id,
      partsLength: plan.smsCount,
      source: "delivery_plan",
    })
  }

  if (plan.leadingEmojiSms) {
    await store.enqueueOutbound(userId, event.from, plan.leadingEmojiSms, {
      sessionId,
      role: "assistant",
      idempotencyKey: `outbound-${event.id}-emoji`,
    })
  }

  // Adam 2026-05-19 voice polish §4 — when the planner ships a leading emoji
  // bubble (👍 or whatever profile resolved), strip the same glyph off the
  // head of the text so we never ship 👍 / 👍 .... Tested cases:
  //   "👍 got it" + leading 👍 → text becomes "got it"
  //   "👍👍 stoked"             → "stoked" (collapse all leading thumbs-ups)
  //   "we good"                 → unchanged
  // We only strip when leadingEmojiSms is set; the regex matches the exact
  // glyph plus optional VS16 + whitespace, keeping the test ASCII-safe.
  const textPartsToShip = plan.textParts.slice()
  if (plan.leadingEmojiSms && textPartsToShip.length > 0) {
    const glyph = plan.leadingEmojiSms
    const head = textPartsToShip[0] ?? ""
    const escapedGlyph = glyph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    // Strip leading runs of glyph (with optional VS16 \uFE0F and whitespace).
    const stripPattern = new RegExp(`^(?:${escapedGlyph}\\uFE0F?\\s*)+`)
    const stripped = head.replace(stripPattern, "").trim()
    if (stripped.length > 0 && stripped !== head) {
      textPartsToShip[0] = stripped
      store.log("pa.outbound.delivery_plan.stripped_leading_emoji", {
        userId,
        turnId,
        eventId: event.id,
        glyph,
      })
    }
  }

  for (let i = 0; i < textPartsToShip.length; i++) {
    const part = textPartsToShip[i]!
    const idempotencyKey =
      plan.leadingEmojiSms
        ? `outbound-${event.id}-p${i + 2}` // emoji is p1, text starts at p2
        : i === 0
          ? `outbound-${event.id}`
          : `outbound-${event.id}-p${i + 1}`
    await store.enqueueOutbound(userId, event.from, part, {
      sessionId,
      role: "assistant",
      idempotencyKey,
    })
  }
}

function isExplicitJobSearchRequest(text: string | undefined | null): boolean {
  const body = (text ?? "").trim()
  if (!body) return false
  const detected = detectFirstTurnIntent(body)
  if (detected.intent === "job_search" && detected.confidence === "high") {
    return true
  }
  const normalized = body.toLowerCase()
  if (/(?:找|推荐|匹配|看看|发)(?:一些|几个|点)?\s*(?:工作|岗位|机会|职位|内推)/.test(normalized)) {
    return true
  }
  if (/\b(?:need|want|looking\s+for|look\s+for|prefer)\b[^.!?]{0,90}\b(?:jobs?|roles?|positions?|opportunities|openings|listings|matches)\b/i.test(normalized)) {
    return true
  }
  return /\b(?:find|get|show|send|pull|recommend|match|search|look\s+for|help\s+me\s+find)\b[^.!?]{0,90}\b(?:jobs?|roles?|positions?|opportunities|openings|listings|matches|swe|software\s+engineering|software\s+engineer)\b/i.test(normalized)
}

function isMoreJobSearchFollowupRequest(text: string | undefined | null): boolean {
  const body = (text ?? "").trim().toLowerCase()
  if (!body) return false
  if (/(?:还有|更多|再来|换一批|多发)(?:一些|几个|点)?\s*(?:公司|工作|岗位|机会|职位|内推)/.test(body)) return true
  return (
    /\bdo\s+(?:u|you)\s+have\s+more\b/i.test(body) ||
    /\b(?:got|have|show|send|pull)\s+(?:me\s+)?more\b/i.test(body) ||
    /\bmore\s+(?:companies|jobs?|roles?|positions?|opportunities|openings|listings|matches)\b/i.test(body) ||
    /\banother\s+(?:batch|set|round)\b/i.test(body)
  )
}

async function hasRecentJobRecommendationContext(store: OrchestratorStore, userId: string): Promise<boolean> {
  if (!store.db) return false
  try {
    const snap = await store.db
      .collection("pa-user-job-recommendations")
      .doc(userId)
      .collection("jobs")
      .limit(20)
      .get()
    if (snap.empty) return false
    const cutoffMs = Date.now() - 14 * 24 * 60 * 60 * 1000
    return snap.docs.some((doc) => {
      const data = doc.data() as Record<string, unknown>
      const raw = data.lastRecommendedAt ?? data.updatedAt ?? data.createdAt
      if (typeof raw !== "string") return true
      const ms = Date.parse(raw)
      return Number.isFinite(ms) && ms >= cutoffMs
    })
  } catch (err) {
    store.log("pa.runtime.job_search.recent_context_lookup_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

async function persistJobSearchProfileUpdate(
  event: InboundEvent,
  store: OrchestratorStore,
  turnId: string,
  update: LifecycleProfileUpdate | null,
): Promise<boolean> {
  if (!update) return false
  const now = store.nowIso()
  if (typeof update.memoryFact === "string" && update.memoryFact.trim()) {
    await store.createMemoryFact(event.userId, update.memoryFact).catch((err) => {
      store.log("pa.runtime.job_search.profile_update_memory_failed", {
        userId: event.userId,
        turnId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }
  if (!store.db) return false
  if (Object.keys(update.tags).length > 0) {
    await applyPartialUserTags(store.db, event.userId, update.tags, {
      source: "chat",
      nowIso: now,
      log: (name, payload) => store.log(name, payload ?? {}),
    })
  }
  await store.db.collection(PA_COLLECTIONS.users).doc(event.userId).set(
    {
      ...(Object.keys(update.statedPreferences).length > 0
        ? { statedPreferences: { ...update.statedPreferences, updatedAt: now } }
        : {}),
      conversationDerivedPreferences: {
        jobSearchProfileUpdates: {
          last: {
            turnId,
            inboundEventId: event.id,
            source: "imessage_job_search_reply",
            summary: update.summary,
            evidence: update.evidence,
            updatedAt: now,
          },
        },
        updatedAt: now,
      },
      updatedAt: now,
    },
    { merge: true },
  )
  return true
}

function requestedJobRecCount(text: string | undefined | null): number | undefined {
  const body = (text ?? "").trim()
  if (!body) return undefined
  const jobNoun = String.raw`(?:jobs?|roles?|positions?|opportunities|openings|listings|matches|swe|software\s+engineering|software\s+engineer)`
  if (new RegExp(String.raw`\b(?:3|three)\b[^.!?]{0,60}\b${jobNoun}\b`, "i").test(body) || /(?:三个|三份|三条|3个|3份|3条)/.test(body)) {
    return 3
  }
  if (new RegExp(String.raw`\b(?:2|two)\b[^.!?]{0,60}\b${jobNoun}\b`, "i").test(body) || /(?:两个|两份|两条|二个|二份|二条|2个|2份|2条)/.test(body)) {
    return 2
  }
  if (new RegExp(String.raw`\b(?:1|one)\b[^.!?]{0,60}\b${jobNoun}\b`, "i").test(body) || /(?:一个|一份|一条|1个|1份|1条)/.test(body)) {
    return 1
  }
  return undefined
}

function isJobRecommendationExplanationRequest(text: string | undefined | null): boolean {
  const body = (text ?? "").trim()
  if (!body) return false
  const lower = body.toLowerCase()
  const asksQuestion =
    /[?？]/.test(body) ||
    /\b(?:why|what|which|how|can\s+you|tell\s+me|explain|answer)\b/i.test(body) ||
    /(?:为什么|为啥|哪里|哪点|怎么|解释|推荐理由|匹配原因)/.test(body)
  if (!asksQuestion) return false
  const hasJobContext =
    /\b(?:recommend(?:ed)?|matching?|matched|jobs?|roles?|positions?|opportunities|openings|internships?|co-?ops?|company|rain|constant\s+contact|fullstack)\b/i.test(body) ||
    /(?:推荐|匹配|岗位|职位|工作|机会|实习|公司)/.test(body)
  if (!hasJobContext) return false
  return (
    /\bwhich\s+(?:jobs?|roles?|positions?|opportunities|matches)\b[\s\S]{0,120}\b(?:fit|fits|match|matches|best|make\s+sense)\b/i.test(body) ||
    /\bbest\s+(?:current\s+)?(?:match|fit|role|job|opportunity)\b/i.test(body) ||
    /\bwhether\b[\s\S]{0,140}\b(?:rain|fullstack|role|job)\b[\s\S]{0,140}\b(?:still\s+)?(?:makes?\s+sense|fits?|matches?)\b/i.test(body) ||
    /\blower\s+priority\b[\s\S]{0,120}\b(?:jobs?|roles?|internships?|co-?ops?)\b/i.test(lower) ||
    /\b(?:jobs?|roles?|internships?|co-?ops?)\b[\s\S]{0,120}\blower\s+priority\b/i.test(lower) ||
    /\bwhy\s+(?:did\s+you\s+)?recommend\b/i.test(body) ||
    /\bwhat\s+part\b[\s\S]{0,120}\bmatch(?:ed|es)?\b/i.test(body) ||
    /\bwhy\s+(?:is|was|did|does)?\s*.*\bmatch(?:ed|es|ing)?\b/i.test(body) ||
    /\b(?:prefer|rather|instead\s+of)\b[\s\S]{0,120}\b(?:jobs?|roles?|internships?|co-?ops?|startups?|fullstack)\b/i.test(lower) ||
    /(?:推荐理由|匹配原因|为什么推荐|为什么匹配)/.test(body)
  )
}

async function buildJobRecommendationExplanationDirective(
  store: OrchestratorStore,
  event: InboundEvent
): Promise<string | null> {
  if (!isJobRecommendationExplanationRequest(event.body)) return null

  const lines = [
    "JOB / MATCH EXPLANATION TURN:",
    "- The user is asking why one or more jobs were recommended, what experience matched a role, or how to prioritize future matches.",
    "- Answer every distinct ask in the latest user message before adding anything else. For multi-role questions, cover each named company/role separately.",
    "- If the user asks whether internships/co-ops should be lower priority, answer directly and acknowledge the preference; use a memory/profile tool when available.",
    "- Do not send a fresh job list unless the user explicitly asks for new jobs in this same turn.",
    "- Do not only say you updated preferences. Give the concrete match reasoning.",
    "- Be honest when a role is only an adjacent/weak match.",
    "- Use plain text only: no Markdown bold/italic and no numbered list markers.",
    "- When these parts apply, use exactly these labels: Best current match:, Rain fullstack:, Internship/co-op priority:.",
    "- If the user asks for the best current match, the first line must be `Best current match: <role/title/company>, because ...`; do not start with an unlabeled rationale like `strongest evidence is`.",
  ]

  const prescreenContext = await loadRecentPrescreenExplanationContext(store, event.userId)
  if (prescreenContext) {
    lines.push("", prescreenContext)
  }
  const bestCurrentMatchHint = await loadRecentBestCurrentMatchHint(store, event.userId, event.sessionId)
  if (bestCurrentMatchHint) {
    lines.push(
      "",
      "Recent visible recommendation context:",
      `- best current match to name if asked: ${bestCurrentMatchHint}`,
      "- If the user asks for best current match, use that role/company in the first line before giving the rationale."
    )
  }

  return lines.join("\n")
}

function timestampMs(value: unknown): number {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    const date = value.toDate()
    return date instanceof Date ? date.getTime() : 0
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)[0]?.trim() ?? ""
}

function isRationaleOnlyBestMatch(value: string): boolean {
  const normalized = value.trim()
  if (!normalized) return true
  return /^(?:because|evidence|strongest\s+evidence|the\s+strongest\s+evidence|your\s+strongest\s+(?:signal|evidence)|signal|signals?|support-only|after\s+your|it\b|that\b|there\b)/i.test(normalized)
}

function extractBestCurrentMatchHintFromText(text: string | undefined | null): string | null {
  if (!text) return null
  const patterns = [
    /^\s*[·\-*]?\s*best\s+current\s+match(?:\s+for\s+you)?\s*:\s*([^\n]+)/im,
    /^\s*[·\-*]?\s*best\s+current\s*for\s+you\s*:\s*([^\n]+)/im,
    /^\s*[·\-*]?\s*(?:best\s+current\s*)?match(?:\s+for\s+you)?\s*:\s*([^\n]+)/im,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    const raw = match?.[1]?.trim()
    if (!raw) continue
    const candidate = raw
      .split(/,\s*because\b|\sbecause\b|\.\s+/i)[0]
      ?.trim()
      .replace(/\s+@\s+/g, " at ")
      .replace(/[.。,:;，；]+$/g, "")
    if (!candidate || candidate.length < 4 || candidate.length > 180) continue
    if (isRationaleOnlyBestMatch(candidate)) continue
    return candidate
  }
  return null
}

function extractBestCurrentMatchHintFromDirective(text: string | undefined | null): string | null {
  if (!text) return null
  const match = text.match(/best current match to name if asked:\s*([^\n]+)/i)
  return extractBestCurrentMatchHintFromText(`Best current match: ${match?.[1] ?? ""}`)
}

async function loadRecentBestCurrentMatchHint(
  store: OrchestratorStore,
  userId: string,
  sessionId?: string | null
): Promise<string | null> {
  if (!store.db) return null
  try {
    const queries = []
    if (sessionId) {
      queries.push(
        store.db
          .collection(PA_COLLECTIONS.messages)
          .where("userId", "==", userId)
          .where("sessionId", "==", sessionId)
      )
    }
    queries.push(store.db.collection(PA_COLLECTIONS.messages).where("userId", "==", userId))
    for (const query of queries) {
      const snap = await query.limit(500).get()
      const rows = snap.docs
        .map((doc) => {
          const data = doc.data() as Record<string, unknown>
          return {
            body: typeof data.body === "string" ? data.body : "",
            role: typeof data.role === "string" ? data.role : "",
            createdAtMs: timestampMs(data.createdAt),
          }
        })
        .filter((row) => row.role === "assistant" && row.body.trim())
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
      for (const row of rows) {
        const hint = extractBestCurrentMatchHintFromText(row.body)
        if (hint) return hint
      }
    }
  } catch (err) {
    store.log("pa.runtime.job_explanation_match_hint_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return null
}

async function loadRecentPrescreenExplanationContext(
  store: OrchestratorStore,
  userId: string
): Promise<string | null> {
  const evidence = await loadRecentPrescreenEvidenceForArbiter(store, userId)
  if (!evidence) return null
  const summary = evidence.summary?.trim() ?? ""
  const evidenceTags = evidence.evidenceTags ?? []
  const parts = [
    "Recent prescreen context to use when answering role-match questions:",
    evidence.jobId ? `- jobId: ${evidence.jobId}` : null,
    evidence.terminal ? `- outcome: ${evidence.terminal}` : null,
    summary ? `- summary: ${summary.slice(0, 900)}` : null,
    evidenceTags.length ? `- evidence tags: ${evidenceTags.slice(0, 12).join(", ")}` : null,
  ].filter((part): part is string => typeof part === "string")
  return parts.length > 1 ? parts.join("\n") : null
}

async function loadRecentPrescreenEvidenceForArbiter(
  store: OrchestratorStore,
  userId: string
): Promise<PrescreenEvidence | null> {
  if (!store.db) return null
  try {
    const userSnap = await store.db.collection(PA_COLLECTIONS.users).doc(userId).get()
    const user = userSnap.exists ? userSnap.data() : null
    const workSession = user?.workSession && typeof user.workSession === "object"
      ? user.workSession as Record<string, unknown>
      : null
    const lastMemory = user?.lastPrescreenMemoryUpdate && typeof user.lastPrescreenMemoryUpdate === "object"
      ? user.lastPrescreenMemoryUpdate as Record<string, unknown>
      : null
    const sessionId =
      typeof workSession?.sessionId === "string"
        ? workSession.sessionId
        : typeof lastMemory?.sessionId === "string"
          ? lastMemory.sessionId
          : null
    if (!sessionId) return null

    const memorySnap = await store.db
      .collection("pa-prescreen-memory-events")
      .doc(sessionId)
      .get()
    const memory = memorySnap.exists ? memorySnap.data() ?? {} : lastMemory ?? {}
    const summary = typeof memory.summary === "string" ? memory.summary.trim() : ""
    const evidenceTags = Array.isArray(memory.evidenceTags)
      ? memory.evidenceTags.filter((tag): tag is string => typeof tag === "string")
      : Array.isArray(lastMemory?.evidenceTags)
        ? lastMemory.evidenceTags.filter((tag): tag is string => typeof tag === "string")
      : []
    const jobId = typeof workSession?.jobId === "string"
      ? workSession.jobId
      : typeof memory.jobId === "string"
        ? memory.jobId
        : typeof lastMemory?.jobId === "string"
          ? lastMemory.jobId
        : ""
    const terminal = typeof workSession?.terminal === "string"
      ? workSession.terminal
      : typeof memory.terminal === "string"
        ? memory.terminal
        : typeof lastMemory?.terminal === "string"
          ? lastMemory.terminal
        : ""

    if (!summary && !jobId && !terminal && evidenceTags.length === 0) return null
    return {
      sessionId,
      ...(jobId ? { jobId } : {}),
      ...(terminal ? { terminal } : {}),
      ...(summary ? { summary } : {}),
      ...(evidenceTags.length ? { evidenceTags } : {}),
    }
  } catch (err) {
    store.log("pa.runtime.job_explanation_context_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

async function buildConversationTurnContext(
  event: InboundEvent,
  store: OrchestratorStore,
  turnId: string,
  onboardingUser: Awaited<ReturnType<OrchestratorStore["getOnboardingUser"]>>,
): Promise<TurnContext> {
  const sharedActive = Boolean(onboardingUser && isSharedOnboardingActiveUser(onboardingUser))
  const sharedQuestionId = sharedActive ? currentSharedOnboardingQuestionId(onboardingUser) : null
  const workSession = onboardingUser?.workSession && typeof onboardingUser.workSession === "object"
    ? onboardingUser.workSession as Record<string, unknown>
    : null
  const activeWorkflow =
    workSession?.kind === "job_prescreen" && workSession.status === "active"
      ? {
          kind: "job_prescreen" as const,
          status: typeof workSession.status === "string" ? workSession.status : undefined,
          currentQuestionId: typeof workSession.currentQuestionId === "string" ? workSession.currentQuestionId : null,
        }
      : sharedActive
        ? {
            kind: "shared_onboarding" as const,
            status: "active",
            currentQuestionId: sharedQuestionId,
          }
        : null
  const recentMessages = await store.loadHistory(event.sessionId, 8)
    .then((messages) => messages.map((message) => ({
      role: message.role,
      body: message.body,
      createdAt: message.createdAt,
    })))
    .catch(() => [])
  const recentOutbound = recentMessages.filter((message) => message.role === "assistant")
  return {
    turnId,
    userId: event.userId,
    inbound: {
      text: event.body,
      createdAt: event.createdAt,
      channel: event.channel,
    },
    activeWorkflow,
    recentMessages,
    recentOutbound,
    prescreenEvidence: await loadRecentPrescreenEvidenceForArbiter(store, event.userId),
    sharedOnboarding: {
      active: sharedActive,
      currentQuestionId: sharedQuestionId,
    },
    preferenceState: onboardingUser?.statedPreferences ?? null,
  }
}

async function persistConversationTurnTrace(
  store: OrchestratorStore,
  event: InboundEvent,
  context: TurnContext,
  ownerDecision: OwnerDecision,
  status: "owner_arbitrated" | "completed",
  actionDecision?: ConversationActionDecision,
  evidenceWrites: ConversationEvidenceWrite[] = [],
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    const trace = summarizeConversationTurnTrace(context, ownerDecision, actionDecision, evidenceWrites)
    const now = store.nowIso()
    await store.updateTurn(context.turnId, {
      conversationArbiterOwner: ownerDecision.selectedOwner,
      conversationArbiterReason: ownerDecision.reason,
      conversationArbiterRejectedOwners: ownerDecision.rejectedOwners,
      conversationArbiterForbiddenMutations: ownerDecision.forbiddenMutations,
      ...(actionDecision
        ? {
            conversationAction: actionDecision.selectedAction,
            conversationNoOutboundReason: actionDecision.noOutboundReason ?? null,
            conversationToolCallIds: actionDecision.toolCallIds,
          }
        : {}),
    })
    if (!store.db) return
    await store.db.collection(PA_COLLECTIONS.turnTraces).doc(context.turnId).set(
      {
        ...trace,
        eventId: event.id,
        status,
        updatedAt: now,
        ...(status === "owner_arbitrated" ? { createdAt: now } : {}),
        ...extra,
      },
      { merge: true },
    )
  } catch (err) {
    store.log("pa.conversation_arbiter.trace_failed", {
      userId: event.userId,
      turnId: context.turnId,
      eventId: event.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function commitConversationEvidenceWrites(
  store: Pick<OrchestratorStore, "db" | "nowIso" | "log">,
  event: InboundEvent,
  context: TurnContext,
  evidenceWrites: ConversationEvidenceWrite[],
): Promise<string[]> {
  if (!store.db || evidenceWrites.length === 0) return []
  const now = store.nowIso()
  const committedIds: string[] = []

  for (let index = 0; index < evidenceWrites.length; index++) {
    const write = evidenceWrites[index]!
    const evidenceId = sanitizeConversationEvidenceId(`${context.turnId}_${index}_${write.kind}`)
    const row = stripUndefinedDeep({
      id: evidenceId,
      userId: event.userId,
      eventId: event.id,
      turnId: context.turnId,
      sourceTurnId: write.sourceTurnId,
      sourceMessageId: write.sourceMessageId ?? null,
      owner: write.owner,
      action: write.action,
      kind: write.kind,
      toolCallId: write.toolCallId ?? null,
      evidenceSpan: write.evidenceSpan,
      confidence: write.confidence,
      scope: write.scope,
      operation: write.operation,
      targetPath: write.targetPath,
      value: write.value,
      status: "committed",
      committedAt: now,
      createdAt: now,
      updatedAt: now,
    }) as Record<string, unknown>

    try {
      await store.db.collection(PA_COLLECTIONS.conversationEvidence).doc(evidenceId).set(row, { merge: true })
      committedIds.push(evidenceId)

      if (write.toolCallId) {
        const link = {
          evidenceId,
          turnId: context.turnId,
          userId: event.userId,
          kind: write.kind,
          targetPath: write.targetPath,
          committedAt: now,
        }
        await store.db.collection(PA_COLLECTIONS.toolCalls).doc(write.toolCallId).set(
          stripUndefinedDeep({
            conversationEvidenceLast: link,
            conversationEvidenceIndex: {
              [evidenceId]: link,
            },
            updatedAt: now,
          }) as Record<string, unknown>,
          { merge: true },
        )
      }
    } catch (err) {
      store.log("pa.conversation_arbiter.evidence_commit_failed", {
        userId: event.userId,
        turnId: context.turnId,
        eventId: event.id,
        evidenceId,
        kind: write.kind,
        targetPath: write.targetPath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return committedIds
}

function sanitizeConversationEvidenceId(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 500)
  return sanitized || randomUUID()
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item))
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child === undefined) continue
      out[key] = stripUndefinedDeep(child)
    }
    return out
  }
  return value
}

async function handlePrescreenOutcomeExplainerTurn(
  event: InboundEvent,
  store: OrchestratorStore,
  turnId: string,
  context: TurnContext,
  ownerDecision: OwnerDecision,
  actionDecision: ConversationActionDecision,
  evidenceWrites: ConversationEvidenceWrite[],
  evidenceCommitIds: string[] = [],
): Promise<boolean> {
  const evidence = context.prescreenEvidence
  if (!evidence) return false
  const profileUpdate = extractLifecycleProfileUpdate(event.body)
  const profileUpdated = await persistJobSearchProfileUpdate(event, store, turnId, profileUpdate)
  const reply = composePrescreenOutcomeExplanationReply(event.body, evidence, profileUpdated)
  await sendMemoryReply(store, event, turnId, reply)
  await store.updateTurn(turnId, {
    status: "succeeded",
    stage: "succeeded",
    completedAt: store.nowIso(),
    directIntent: "prescreen_outcome_explainer",
    directIntentResult: "answered",
    directIntentProfileUpdated: profileUpdated,
    prescreenEvidenceSessionId: evidence.sessionId,
    prescreenEvidenceJobId: evidence.jobId ?? null,
    prescreenEvidenceTerminal: evidence.terminal ?? null,
  })
  await persistConversationTurnTrace(store, event, context, ownerDecision, "completed", actionDecision, evidenceWrites, {
    outboundSource: "prescreen_outcome_explainer",
    memoryWrites: profileUpdated ? ["durable_preference_update"] : [],
    evidenceCommitIds,
    evidenceCommitCount: evidenceCommitIds.length,
  })
  await store.markEventSucceeded(event.id)
  return true
}

async function handleConversationTapbackOnlyTurn(
  event: InboundEvent,
  store: OrchestratorStore,
  turnId: string,
  context: TurnContext,
  ownerDecision: OwnerDecision,
  actionDecision: ConversationActionDecision,
  evidenceWrites: ConversationEvidenceWrite[],
  evidenceCommitIds: string[] = [],
): Promise<boolean> {
  const reaction = actionDecision.deliveryPlan.reaction ?? "like"
  const messageHandle = inboundMessageHandleForReaction(event)
  let reactionSent = false
  let reactionSkippedReason: string | null = null

  if (!messageHandle) {
    reactionSkippedReason = "missing_message_handle"
  } else if (!event.from) {
    reactionSkippedReason = "missing_recipient"
  } else if (!store.sendReaction) {
    reactionSkippedReason = "send_reaction_unavailable"
  } else if (!(await isReactionTapbackEnabled(store.db, event.userId))) {
    reactionSkippedReason = "tapback_flag_disabled"
  } else {
    try {
      await store.sendReaction({
        to: event.from,
        messageHandle,
        reaction,
        userId: event.userId,
      })
      reactionSent = true
    } catch (err) {
      reactionSkippedReason = "send_reaction_failed"
      store.log("pa.conversation_action.tapback_failed", {
        userId: event.userId,
        turnId,
        eventId: event.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const now = store.nowIso()
  await store.updateTurn(turnId, {
    status: "succeeded",
    stage: "succeeded",
    completedAt: now,
    directIntent: ownerDecision.selectedOwner,
    conversationAction: actionDecision.selectedAction,
    conversationNoOutboundReason: actionDecision.noOutboundReason ?? "tapback_only",
    reactionAttempted: Boolean(messageHandle && event.from && store.sendReaction),
    reactionSent,
    reactionSkippedReason,
  })
  await persistConversationTurnTrace(store, event, context, ownerDecision, "completed", actionDecision, evidenceWrites, {
    outboundSource: "tapback_only",
    noOutboundReason: actionDecision.noOutboundReason ?? "tapback_only",
    reactionAttempted: Boolean(messageHandle && event.from && store.sendReaction),
    reactionSent,
    reactionSkippedReason,
    memoryWrites: evidenceWrites.map((write) => write.kind),
    evidenceCommitIds,
    evidenceCommitCount: evidenceCommitIds.length,
  })
  await store.markEventSucceeded(event.id)
  return true
}

function hasSharedOnboardingAnswerEvidence(writes: ConversationEvidenceWrite[]): boolean {
  return writes.some((write) => write.kind === "shared_onboarding_answer" && write.operation === "set")
}

async function handleSharedOnboardingClarificationTurn(
  event: InboundEvent,
  store: OrchestratorStore,
  turnId: string,
  onboardingUser: Awaited<ReturnType<OrchestratorStore["getOnboardingUser"]>>,
  context: TurnContext,
  ownerDecision: OwnerDecision,
  actionDecision: ConversationActionDecision,
  evidenceWrites: ConversationEvidenceWrite[],
  evidenceCommitIds: string[] = [],
): Promise<boolean> {
  if (!onboardingUser || !isSharedOnboardingActiveUser(onboardingUser)) return false
  if (hasSharedOnboardingAnswerEvidence(evidenceWrites)) return false
  if (!ownerDecision.orderedActions.some((action) => action.kind === "clarify_shared_onboarding")) return false

  const questionId = currentSharedOnboardingQuestionId(onboardingUser)
  if (!questionId) return false

  const promptContext = sharedPromptContextFrom(onboardingUser)
  const agent = await requireAgentForUser(store, event.userId)
  const priorSlangPicks = extractRecentSlangPicks(onboardingUser as { sharedOnboarding?: Record<string, unknown> | null } | null)
  const composed = await composeSharedOnboardingReply({
    store: sharedOnboardingOutboundSlice(store),
    userId: event.userId,
    sessionId: event.sessionId,
    turnId,
    slot: questionId,
    mode: "reask",
    promptContext,
    userMessage: event.body,
    recentMessages: context.recentMessages,
    composeContext: buildSharedOnboardingComposeContext({
      inboundKind: "user_answer",
      routerResult: "reasked_question",
      slot: questionId,
      mode: "reask",
      userMessage: event.body,
    }),
    agent,
    reaskReason: "unclear",
    forceAgentic: true,
    inboundMessageHandle: inboundMessageHandleForReaction(event),
    toE164: event.from,
    recentSlangPicks: priorSlangPicks,
  })

  await sendMemoryReply(store, event, turnId, composed.text, {
    // The agent SDK already persisted this assistant item. Use the same
    // session hash here so appendMessage merges orchestrator metadata onto
    // that row instead of creating a second transcript row for one visible SMS.
    transcriptIdempotencyKey: deriveSessionMessageIdempotencyKey(event.sessionId, "assistant", composed.text),
    allowImperfection: false,
  })
  await persistSharedOnboardingSlangPicks({
    db: store.db,
    userId: event.userId,
    priorPicks: priorSlangPicks,
    newPicks: composed.slangPicked,
    nowIso: store.nowIso(),
    log: (name, payload) => store.log(name, payload ?? {}),
  })

  const now = store.nowIso()
  await store.updateTurn(turnId, {
    status: "succeeded",
    stage: "succeeded",
    completedAt: now,
    directIntent: "shared_onboarding",
    directIntentResult: "reasked_question",
    sharedOnboardingQuestionId: questionId,
    conversationAction: actionDecision.selectedAction,
    conversationNoOutboundReason: null,
  })
  await persistConversationTurnTrace(store, event, context, ownerDecision, "completed", actionDecision, evidenceWrites, {
    outboundSource: "shared_onboarding_reask",
    memoryWrites: [],
    evidenceCommitIds,
    evidenceCommitCount: evidenceCommitIds.length,
  })
  await store.markEventSucceeded(event.id)
  return true
}

async function handleDurablePreferenceUpdateTurn(
  event: InboundEvent,
  store: OrchestratorStore,
  turnId: string,
  context: TurnContext,
  ownerDecision: OwnerDecision,
  actionDecision: ConversationActionDecision,
  evidenceWrites: ConversationEvidenceWrite[],
  evidenceCommitIds: string[] = [],
): Promise<boolean> {
  const profileUpdate = extractLifecycleProfileUpdate(event.body)
  const profileUpdated = await persistJobSearchProfileUpdate(event, store, turnId, profileUpdate)
  const shouldContinueToSearch = ownerDecision.orderedActions.some((action) => action.kind === "run_job_search")

  await persistConversationTurnTrace(store, event, context, ownerDecision, "completed", actionDecision, evidenceWrites, {
    outboundSource: shouldContinueToSearch ? "durable_preference_then_search" : "durable_preference_update",
    memoryWrites: profileUpdated ? ["durable_preference_update"] : evidenceWrites.map((write) => write.kind),
    evidenceCommitIds,
    evidenceCommitCount: evidenceCommitIds.length,
  })

  if (shouldContinueToSearch) {
    await store.updateTurn(turnId, {
      stage: "durable_preference_committed",
      directIntent: "durable_preference_update",
      directIntentProfileUpdated: profileUpdated,
      updatedAt: store.nowIso(),
    })
    return false
  }

  const reply = profileUpdate?.ack ?? "Got it - I'll keep future matches aligned with that."
  await sendMemoryReply(store, event, turnId, reply)
  await store.updateTurn(turnId, {
    status: "succeeded",
    stage: "succeeded",
    completedAt: store.nowIso(),
    directIntent: "durable_preference_update",
    directIntentResult: profileUpdated ? "profile_updated" : "evidence_recorded",
    directIntentProfileUpdated: profileUpdated,
    conversationAction: actionDecision.selectedAction,
  })
  await store.markEventSucceeded(event.id)
  return true
}

function composePrescreenOutcomeExplanationReply(
  userText: string,
  evidence: PrescreenEvidence,
  profileUpdated: boolean,
): string {
  const roleLabel = inferPrescreenRoleLabel(userText, evidence.jobId)
  const summary = evidence.summary?.replace(/\s+/g, " ").trim() ?? ""
  const gap = extractPrescreenGap(summary)
  const strength = extractPrescreenStrength(summary, gap)
  const outcome = evidence.terminal ? ` The outcome I have on file is ${evidence.terminal}.` : ""
  const lines = [
    `For ${roleLabel}, the issue was not that your background had no fit.${outcome}`,
    strength
      ? `The positive signal was: ${strength}.`
      : "The positive signal was your product and systems-adjacent ownership.",
    gap
      ? `The technical gap was: ${gap}.`
      : "The gap was concrete implementation depth: exactly what you designed, which API/DB/schema decisions you owned, what failed, and what tradeoff you chose.",
    "A stronger answer would name the system, your personal ownership, the data/API boundary, the failure mode, the retry or consistency design, and a measurable result.",
  ]
  if (profileUpdated) {
    lines.push("I also saved the role-preference correction from this turn before any future matching.")
  }
  return lines.join(" ")
}

function inferPrescreenRoleLabel(userText: string, jobId: string | undefined): string {
  const explicit = userText.match(/\bat\s+([A-Z][A-Za-z0-9&.-]{1,80})\b/)
  if (explicit?.[1]) return `${explicit[1]}`
  if (jobId) {
    const first = jobId.split("-").find((part) => part && !/^[0-9a-f]{6,}$/i.test(part))
    if (first) return `${first.charAt(0).toUpperCase()}${first.slice(1)}`
  }
  return "that role"
}

function extractPrescreenGap(summary: string): string | null {
  if (!summary) return null
  const match = summary.match(/\b(lacks?|limited|thin|weak|missing|gap(?: was| is)?)[^.;]{0,220}/i)
  return match?.[0]?.trim().replace(/[.;]+$/, "") ?? null
}

function extractPrescreenStrength(summary: string, gap: string | null): string | null {
  if (!summary) return null
  const clauses = summary
    .split(/[.;]/)
    .map((part) => part.trim())
    .filter(Boolean)
  const candidate = clauses.find((part) => !gap || !part.toLowerCase().includes(gap.toLowerCase()))
  return candidate ? candidate.slice(0, 220) : null
}

function asksBestCurrentMatch(text: string | undefined | null): boolean {
  return /\bbest\s+(?:current\s+)?(?:match|fit|role|job|opportunity)\b/i.test(text ?? "")
}

function normalizeJobExplanationVisibleReply(
  text: string,
  userText?: string | null,
  bestCurrentMatchHint?: string | null
): string {
  if (!text.trim()) return text
  let normalized = text
    .replace(
      /^\s*[·\-*]?\s*(?:best\s+current\s*)?match(?:\s+for\s+you)?\s*:/im,
      "Best current match:"
    )
    .replace(
      /^\s*[·\-*]?\s*best\s+current\s*(?:match\s*)?(?:for\s+you)?\s*:/im,
      "Best current match:"
    )
    .replace(/^\s*[·\-*]?\s*rain\s+fullstack\s*:?\s*/im, "Rain fullstack: ")
    .replace(
      /^\s*[·\-*]?\s*(?:internships?\/co-ops?|internship\/co-op|internships?|co-ops?)(?:\s+priority)?\s*:?\s*/im,
      "Internship/co-op priority: "
    )
    .replace(/(Internship\/co-op priority:\s*)priority:\s*/i, "$1")
  if (asksBestCurrentMatch(userText)) {
    const first = firstLine(normalized)
    const hasBestLabel = /^\s*Best current match:/im.test(normalized)
    const firstReason = hasBestLabel
      ? first.replace(/^\s*Best current match:\s*/i, "").trim()
      : first
    const hint = bestCurrentMatchHint?.trim()
    if (hint && isRationaleOnlyBestMatch(firstReason)) {
      const reason = firstReason.replace(/^(?:because|as|since)\s+/i, "").trim()
      const replacement = `Best current match: ${hint}${reason ? `, because ${reason}` : "."}`
      if (hasBestLabel) {
        normalized = normalized.replace(/^\s*Best current match:\s*[^\n]*/im, replacement)
      } else {
        normalized = normalized.replace(/^\s*[^\n]*/m, replacement)
      }
    } else if (!hasBestLabel) {
      normalized = normalized.replace(/^\s*/, "Best current match: ")
    }
  }
  return normalized
}

function runtimeContext(rawMeta: unknown): Record<string, unknown> {
  if (!rawMeta || typeof rawMeta !== "object") return {}
  const context = (rawMeta as Record<string, unknown>).context
  return context && typeof context === "object" ? context as Record<string, unknown> : {}
}

function trustedRuntimeOutboundBody(rawMeta: unknown): string | null {
  const context = runtimeContext(rawMeta)
  const raw = context.trustedOutboundBody
  if (typeof raw !== "string") return null
  const body = raw.trim()
  if (!body || body === "__NO_SEND__") return null
  return body.slice(0, 4_000)
}

type RuntimeRecommendationJob = {
  title: string
  companyName: string
  url: string
  requirements: string
  reason: string
}

function cleanRuntimeText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
}

function runtimeRecommendationJobs(rawMeta: unknown): RuntimeRecommendationJob[] {
  const context = runtimeContext(rawMeta)
  if (!Array.isArray(context.jobs)) return []
  return context.jobs.flatMap((item): RuntimeRecommendationJob[] => {
    if (!item || typeof item !== "object") return []
    const row = item as Record<string, unknown>
    const title = cleanRuntimeText(row.title)
    const companyName = cleanRuntimeText(row.companyName)
    const url = cleanRuntimeText(row.url)
    if (!title || !url) return []
    return [{
      title,
      companyName,
      url,
      requirements: cleanRuntimeText(row.requirements),
      reason: cleanRuntimeText(row.reason).replace(/^why\s*:\s*/i, ""),
    }]
  })
}

function buildRoleFitGate(job: RuntimeRecommendationJob): string {
  const haystack = `${job.title} ${job.requirements}`.toLowerCase()
  if (/\breact\b|\bnext\.?js\b|\btypescript\b|\bts\b/.test(haystack)) {
    return "Before I move it forward, quick fit check: have you shipped production React/Next.js with TypeScript?"
  }
  if (/\bjava\b|\bpython\b|\bjavascript\b|\bnode\.?js\b/.test(haystack)) {
    return "Before I move it forward, quick fit check: have you shipped production Java, Python, JavaScript, or Node work?"
  }
  if (/\bsql\b|\bexcel\b|\bpower\s*bi\b|\banalytics?\b|\bdata\b/.test(haystack)) {
    return "Before I move it forward, quick fit check: have you used SQL or analytics tooling on real business data?"
  }
  if (/\bhybrid\b|\bonsite\b|\boffice\b|\brelocat/.test(haystack)) {
    return "Before I move it forward, quick fit check: are you open to the work setup for this role?"
  }
  return "Before I move it forward, quick fit check: does this look worth a quick screen?"
}

function buildFocusedRuntimeRecommendationPlan(rawMeta: unknown): { body: string; plan: OutboundDeliveryPlan } | null {
  const [job] = runtimeRecommendationJobs(rawMeta)
  if (!job) return null

  const roleLine = `One role worth your time: ${job.title}${job.companyName ? ` @ ${job.companyName}` : ""}.`
  const first = [
    roleLine,
    job.url,
    job.requirements,
    job.reason ? `Why it lines up: ${job.reason}` : "",
  ].filter(Boolean).join("\n")
  const second = buildRoleFitGate(job)
  const body = `${first}\n\n${second}`
  return {
    body,
    plan: {
      mode: "text_split_2",
      textParts: [first, second],
      reason: "runtime_job_recommendation_focused_split_2",
      smsCount: 2,
    },
  }
}

function detectJobRecommendationSubscriptionCancel(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return false
  if (/^(stop|unsubscribe|unsub|cancel|pause)\s*[.!?。！]*$/.test(normalized)) return true
  return /\b(?:stop|unsubscribe|unsub|cancel|pause|turn off|no more)\b[^.!?]{0,80}\b(?:job|jobs|role|roles|match|matches|matching|recommendation|recommendations|recs|daily|texts|outreach)\b/i.test(normalized) ||
    /\b(?:job|jobs|role|roles|match|matches|matching|recommendation|recommendations|recs|daily|texts|outreach)\b[^.!?]{0,80}\b(?:stop|unsubscribe|unsub|cancel|pause|turn off|no more)\b/i.test(normalized)
}

function detectJobRecommendationSubscriptionResume(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return false
  return /\b(?:restart|resume|start|subscribe|resubscribe|unpause|turn on|turn back on)\b[^.!?]{0,80}\b(?:job|jobs|role|roles|match|matches|matching|recommendation|recommendations|recs|daily|texts|outreach)\b/i.test(normalized) ||
    /\b(?:job|jobs|role|roles|match|matches|matching|recommendation|recommendations|recs|daily|texts|outreach)\b[^.!?]{0,80}\b(?:restart|resume|start|subscribe|resubscribe|unpause|turn on|turn back on)\b/i.test(normalized)
}

function parseSharedQuestionId(value: unknown): SharedOnboardingQuestionId {
  return value === "culture_stage" ||
    value === "industry_interest" ||
    value === "location_relocation" ||
    value === "special_context"
    ? value
    : "main_goal"
}

function sharedPromptContextFrom(
  onboardingUser: Awaited<ReturnType<OrchestratorStore["getOnboardingUser"]>>,
  rawMeta?: unknown,
): SharedOnboardingPromptContext {
  const metaContext = runtimeContext(rawMeta)
  const fromRuntime = cleanSharedOnboardingPromptContext(metaContext.promptContext)
  if (Object.keys(fromRuntime).length > 0) return fromRuntime
  const shared = onboardingUser?.sharedOnboarding && typeof onboardingUser.sharedOnboarding === "object"
    ? onboardingUser.sharedOnboarding as Record<string, unknown>
    : {}
  return cleanSharedOnboardingPromptContext(shared.promptContext)
}

async function handleSharedOnboardingRuntimeEvent(
  event: InboundEvent,
  store: OrchestratorStore,
  turnId: string,
  onboardingUser: Awaited<ReturnType<OrchestratorStore["getOnboardingUser"]>>,
): Promise<boolean> {
  if (!isSharedOnboardingRuntimeEvent(event.rawMeta)) return false
  const questionId = parseSharedQuestionId(runtimeContext(event.rawMeta).questionId)
  const promptContext = sharedPromptContextFrom(onboardingUser, event.rawMeta)
  const agent = await requireAgentForUser(store, event.userId)
  const priorSlangPicks = extractRecentSlangPicks(onboardingUser as { sharedOnboarding?: Record<string, unknown> | null } | null)
  const composed = await composeSharedOnboardingReply({
    store: sharedOnboardingOutboundSlice(store),
    userId: event.userId,
    sessionId: event.sessionId,
    turnId,
    slot: questionId,
    mode: "ask",
    promptContext,
    userMessage: event.body,
    composeContext: buildSharedOnboardingComposeContext({
      inboundKind: "runtime_event",
      routerResult: "asked_question",
      slot: questionId,
      mode: "ask",
    }),
    agent,
    inboundMessageHandle: inboundMessageHandleForReaction(event),
    toE164: event.from,
    recentSlangPicks: priorSlangPicks,
  })
  const runtimePlan = await buildSharedOnboardingDeliveryPlan({
    store,
    event,
    turnId,
    reply: composed.text,
    // Runtime event = system-initiated kickoff (e.g. cv-ingest fires Q1).
    // There's no user inbound to mirror, so force a single bubble to keep
    // the kickoff feeling deliberate (matches force1 rule in plan §3).
    force1: true,
  })
  await sendMemoryReply(store, event, turnId, composed.text, {
    deliveryPlan: runtimePlan ?? undefined,
    inboundMessageHandle: inboundMessageHandleForReaction(event),
    transcriptIdempotencyKey: deriveSessionMessageIdempotencyKey(event.sessionId, "assistant", composed.text),
    allowImperfection: false,
  })
  await persistSharedOnboardingSlangPicks({
    db: store.db,
    userId: event.userId,
    priorPicks: priorSlangPicks,
    newPicks: composed.slangPicked,
    nowIso: store.nowIso(),
    log: (name, payload) => store.log(name, payload ?? {}),
  })
  await store.updateTurn(turnId, {
    status: "succeeded",
    stage: "succeeded",
    completedAt: store.nowIso(),
    directIntent: "shared_onboarding",
    directIntentResult: "asked_question",
    sharedOnboardingQuestionId: questionId,
  })
  await store.markEventSucceeded(event.id)
  return true
}

function hasObjectKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0
}

type ConversationTraceBundle = {
  context: TurnContext
  ownerDecision: OwnerDecision
  actionDecision?: ConversationActionDecision | null
  evidenceWrites: ConversationEvidenceWrite[]
  evidenceCommitIds: string[]
}

async function persistConversationTraceCompletion(
  store: OrchestratorStore,
  event: InboundEvent,
  bundle: ConversationTraceBundle | undefined,
  extra: {
    outboundSource: string
    memoryWrites?: string[]
    noOutboundReason?: string | null
    reactionAttempted?: boolean
    reactionSent?: boolean
    reactionSkippedReason?: string | null
  },
): Promise<void> {
  if (!bundle) return
  await persistConversationTurnTrace(
    store,
    event,
    bundle.context,
    bundle.ownerDecision,
    "completed",
    bundle.actionDecision ?? undefined,
    bundle.evidenceWrites,
    {
      ...extra,
      evidenceCommitIds: bundle.evidenceCommitIds,
      evidenceCommitCount: bundle.evidenceCommitIds.length,
    },
  )
}

async function writeSharedOnboardingAnswer(
  store: OrchestratorStore,
  event: InboundEvent,
  questionId: SharedOnboardingQuestionId,
  projection: ReturnType<typeof projectSharedOnboardingAnswer>,
  next: ReturnType<typeof resolveNextSharedOnboardingQuestionId>,
): Promise<void> {
  const now = store.nowIso()
  await store.createMemoryFact(event.userId, projection.memoryFact).catch((err) => {
    store.log("pa.shared_onboarding.memory_write_error", {
      userId: event.userId,
      eventId: event.id,
      error: err instanceof Error ? err.message : String(err),
    })
  })

  if (store.db && hasObjectKeys(projection.tags as Record<string, unknown>)) {
    await applyPartialUserTags(store.db, event.userId, projection.tags, {
      source: "chat",
      nowIso: now,
      log: (name, payload) => store.log(name, payload ?? {}),
    })
  }

  if (!store.db) return
  await store.db.collection(PA_COLLECTIONS.users).doc(event.userId).set(
    {
      onboardingState: next.completed ? "complete" : "pending",
      onboardingStatus: next.completed ? "complete" : "invited",
      updatedAt: now,
      ...(hasObjectKeys(projection.statedPreferences)
        ? { statedPreferences: projection.statedPreferences }
        : {}),
      sharedOnboarding: {
        status: next.completed ? "complete" : "active",
        updatedAt: now,
        currentQuestionId: next.nextQuestionId,
        completed: next.completed,
        ...(next.completed ? { completedAt: now } : {}),
        answers: {
          [questionId]: {
            answer: event.body.trim(),
            answeredAt: now,
            questionId,
            questionLabel: getSharedOnboardingQuestion(questionId).label,
            evidence: projection.evidence,
          },
        },
      },
      workSession: {
        kind: SHARED_ONBOARDING_WORK_SESSION_KIND,
        status: next.completed ? "ended" : "active",
        currentQuestionId: next.nextQuestionId,
        ...(next.completed ? { endedAt: now, boundary: "completed" } : {}),
      },
    },
    { merge: true },
  )
}

async function handleSharedOnboardingUserReply(
  event: InboundEvent,
  store: OrchestratorStore,
  turnId: string,
  onboardingUser: Awaited<ReturnType<OrchestratorStore["getOnboardingUser"]>>,
  traceBundle?: ConversationTraceBundle,
): Promise<boolean> {
  if (!onboardingUser || !isSharedOnboardingActiveUser(onboardingUser)) return false
  const questionId = currentSharedOnboardingQuestionId(onboardingUser)
  const answerJudge = await judgeSharedOnboardingAnswer({
    questionId,
    answer: event.body,
    lang: detectLang([event.body]) === "zh" ? "zh" : "en",
    userId: event.userId,
    turnId,
    log: (name, payload) => store.log(name, payload ?? {}),
  })
  if (
    !answerJudge.accept &&
    shouldIgnoreSharedOnboardingDuplicateKickoff(questionId, event.body)
  ) {
    const now = store.nowIso()
    await store.updateTurn(turnId, {
      status: "succeeded",
      stage: "succeeded",
      completedAt: now,
      directIntent: "shared_onboarding",
      directIntentResult: "ignored_non_answer",
      sharedOnboardingQuestionId: questionId,
      sharedOnboardingJudgeReason: answerJudge.reason,
    })
    await persistConversationTraceCompletion(store, event, traceBundle, {
      outboundSource: "shared_onboarding_ignored_non_answer",
      memoryWrites: [],
      noOutboundReason: "ignored_non_answer",
    })
    await store.markEventSucceeded(event.id)
    return true
  }
  const advancedDespiteJudge =
    !answerJudge.accept && shouldSharedOnboardingAdvanceDespiteJudge(questionId, event.body)
  if (advancedDespiteJudge) {
    store.log("pa.shared_onboarding.fail_forward", {
      userId: event.userId,
      turnId,
      eventId: event.id,
      questionId,
      judgeReason: answerJudge.reason,
      answerLen: event.body.trim().length,
    })
  }
  const projection = projectSharedOnboardingAnswer(questionId, event.body)
  const next = resolveNextSharedOnboardingQuestionId(questionId)
  await writeSharedOnboardingAnswer(store, event, questionId, projection, next)

  if (!next.completed && next.nextQuestionId) {
    const promptContext = sharedPromptContextFrom(onboardingUser)
    const agent = await requireAgentForUser(store, event.userId)
    // The doc we cached at the top of handleSharedOnboardingUserReply pre-dates
    // writeSharedOnboardingAnswer, but recentSlangPicks lives on a separate
    // sharedOnboarding.voice sub-tree we never touch from writeSharedOnboardingAnswer,
    // so reusing onboardingUser is safe here.
    const priorSlangPicks = extractRecentSlangPicks(onboardingUser as { sharedOnboarding?: Record<string, unknown> | null } | null)
    const recentMessagesForCompose = await store.loadHistory(event.sessionId, 8).catch(() => [])
    const composed = await composeSharedOnboardingReply({
      store: sharedOnboardingOutboundSlice(store),
      userId: event.userId,
      sessionId: event.sessionId,
      turnId,
      slot: next.nextQuestionId,
      mode: "ask",
      promptContext,
      userMessage: event.body,
      recentMessages: recentMessagesForCompose,
      composeContext: buildSharedOnboardingComposeContext({
        inboundKind: "user_answer",
        routerResult: advancedDespiteJudge ? "advanced_despite_judge" : "asked_question",
        slot: next.nextQuestionId,
        mode: "ask",
        userMessage: event.body,
      }),
      agent,
      inboundMessageHandle: inboundMessageHandleForReaction(event),
      toE164: event.from,
      recentSlangPicks: priorSlangPicks,
    })
    const nextAskPlan = await buildSharedOnboardingDeliveryPlan({
      store,
      event,
      turnId,
      reply: composed.text,
    })
    await sendMemoryReply(store, event, turnId, composed.text, {
      deliveryPlan: nextAskPlan ?? undefined,
      inboundMessageHandle: inboundMessageHandleForReaction(event),
      transcriptIdempotencyKey: deriveSessionMessageIdempotencyKey(event.sessionId, "assistant", composed.text),
      allowImperfection: false,
    })
    await persistSharedOnboardingSlangPicks({
      db: store.db,
      userId: event.userId,
      priorPicks: priorSlangPicks,
      newPicks: composed.slangPicked,
      nowIso: store.nowIso(),
      log: (name, payload) => store.log(name, payload ?? {}),
    })
    await store.updateTurn(turnId, {
      status: "succeeded",
      stage: "succeeded",
      completedAt: store.nowIso(),
      directIntent: "shared_onboarding",
      directIntentResult: advancedDespiteJudge ? "advanced_despite_judge" : "asked_question",
      sharedOnboardingAnsweredQuestionId: questionId,
      sharedOnboardingQuestionId: next.nextQuestionId,
      ...(advancedDespiteJudge
        ? {
            sharedOnboardingFailForward: true,
            sharedOnboardingJudgeReason: answerJudge.reason,
          }
        : {}),
    })
    await persistConversationTraceCompletion(store, event, traceBundle, {
      outboundSource: "shared_onboarding_next_ask",
      memoryWrites: traceBundle?.evidenceWrites.map((write) => write.kind) ?? [],
    })
    await store.markEventSucceeded(event.id)
    return true
  }

  const agent = await requireAgentForUser(store, event.userId)
  const db = store.db
  const delivered =
    db != null
      ? await deliverSharedOnboardingJobRecs({
          store: sharedOnboardingOutboundSlice(store),
          db,
          event,
          turnId,
          agent,
          userMessage: event.body,
        })
      : {
          recCount: 0,
          reply:
            "Got it. I saved that context and will send two concrete roles once I pull a fresh batch.",
        }
  const deliveredPlan = await buildSharedOnboardingDeliveryPlan({
    store,
    event,
    turnId,
    reply: delivered.reply,
    // Job-rec explanation reply per plan §3 force-1 rule (kickoff / job-rec).
    force1: true,
  })
  await sendMemoryReply(store, event, turnId, delivered.reply, {
    deliveryPlan: deliveredPlan ?? undefined,
    inboundMessageHandle: inboundMessageHandleForReaction(event),
  })
  await store.updateTurn(turnId, {
    status: "succeeded",
    stage: "succeeded",
    completedAt: store.nowIso(),
    directIntent: "shared_onboarding",
    directIntentResult: delivered.recCount > 0 ? "sent_recs" : "saved_without_recs",
    sharedOnboardingAnsweredQuestionId: questionId,
    sharedOnboardingCompleted: true,
    directIntentRecCount: delivered.recCount,
    ...(advancedDespiteJudge
      ? {
          sharedOnboardingFailForward: true,
          sharedOnboardingJudgeReason: answerJudge.reason,
        }
      : {}),
  })
  await persistConversationTraceCompletion(store, event, traceBundle, {
    outboundSource: delivered.recCount > 0 ? "shared_onboarding_job_recs" : "shared_onboarding_saved_without_recs",
    memoryWrites: traceBundle?.evidenceWrites.map((write) => write.kind) ?? [],
  })
  await store.markEventSucceeded(event.id)
  return true
}

function isSmsLikeChannel(event: InboundEvent): boolean {
  return event.channel === "imessage" || event.channel === "sms"
}

async function handleSharedOnboardingBootstrap(
  event: InboundEvent,
  store: OrchestratorStore,
  turnId: string,
  onboardingUser: Awaited<ReturnType<OrchestratorStore["getOnboardingUser"]>>,
  sharedRuntimeSession: boolean,
): Promise<boolean> {
  // 2026-05-19 — replaced the legacy URL-redirect fallback. When a known
  // candidate (registered pa-users row with phone + source) texts SMS but
  // their shared_onboarding session isn't active, inline-bootstrap the
  // session here so Claire asks Q1 directly instead of bouncing them back
  // to the website. The website still owns the registration flow; this
  // path covers the case where the runtime kickoff event never fired or
  // the user replied before the kickoff landed.
  if (!onboardingUser) return false
  if (!isSmsLikeChannel(event)) return false
  if (onboardingUser.onboardingState === "complete") return false
  if (sharedRuntimeSession) return false
  if (!onboardingUser.phoneE164) return false

  const crisisGuard = await runCrisisHotlineGuard({
    store,
    event,
    turnId,
    userInput: event.body,
    reply:
      pickLangForSafety(event.body) === "zh"
        ? "先保证你现在是安全的。如果你可能会伤害自己，请立刻联系当地紧急服务或身边可信的人。"
        : "First, are you safe right now? If you might hurt yourself, contact local emergency services or someone you trust right now.",
    callSite: "onboarding",
  })
  if (crisisGuard.detected) {
    await sendMemoryReply(store, event, turnId, crisisGuard.reply)
    await store.updateTurn(turnId, {
      status: "succeeded",
      stage: "succeeded",
      completedAt: store.nowIso(),
      directIntent: "crisis_hotline_guard",
      directIntentResult: "crisis_reply_sent",
    })
    await store.markEventSucceeded(event.id)
    return true
  }

  const now = store.nowIso()
  const parsedResume = store.db
    ? await loadSharedOnboardingParsedResumeForPrompt(
        store.db,
        event.userId,
        onboardingUser as unknown as Record<string, unknown>,
        (name, payload) => store.log(`pa.${name}`, payload ?? {}),
      )
    : null
  const promptContext = buildSharedOnboardingPromptContext({
    user: onboardingUser as unknown as Record<string, unknown>,
    parsedResume,
  })
  const q1: SharedOnboardingQuestionId = "main_goal"

  if (store.db) {
    try {
      await store.db.collection(PA_COLLECTIONS.users).doc(event.userId).set(
        {
          onboardingState: "pending",
          onboardingStatus: "invited",
          updatedAt: now,
          sharedOnboarding: {
            status: "active",
            startedAt: now,
            updatedAt: now,
            currentQuestionId: q1,
            completed: false,
            answers: {},
            ...(Object.keys(promptContext).length > 0 ? { promptContext } : {}),
          },
          workSession: {
            kind: SHARED_ONBOARDING_WORK_SESSION_KIND,
            status: "active",
            startedAt: now,
            boundary: SHARED_ONBOARDING_BOUNDARY,
            currentQuestionId: q1,
          },
        },
        { merge: true },
      )
    } catch (err) {
      // Fail-open: never block Q1 delivery on a state-write hiccup. The next
      // inbound turn re-evaluates and will write again if state is still
      // missing. handleSharedOnboardingUserReply only requires sharedOnboarding
      // to be present at answer time, not bootstrap time.
      store.log("pa.shared_onboarding.bootstrap_state_write_failed", {
        userId: event.userId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // event.body is the coalesced accumulatedBody when paMessageCoalesceEnabled
  // stamped the inbound row — bootstrap sees one turn per burst, not per fragment.
  const agent = await requireAgentForUser(store, event.userId)
  const priorSlangPicks = extractRecentSlangPicks(onboardingUser as { sharedOnboarding?: Record<string, unknown> | null } | null)
  const bootstrapComposed = await composeSharedOnboardingReply({
    store: sharedOnboardingOutboundSlice(store),
    userId: event.userId,
    sessionId: event.sessionId,
    turnId,
    slot: q1,
    mode: "ask",
    promptContext,
    userMessage: event.body,
    composeContext: buildSharedOnboardingComposeContext({
      inboundKind: "greeting_kickoff",
      routerResult: "bootstrapped_q1_inline",
      slot: q1,
      mode: "ask",
    }),
    agent,
    inboundMessageHandle: inboundMessageHandleForReaction(event),
    toE164: event.from,
    recentSlangPicks: priorSlangPicks,
  })
  const bootstrapPlan = buildSharedOnboardingBootstrapDeliveryPlan(bootstrapComposed.text)
  await sendMemoryReply(store, event, turnId, bootstrapComposed.text, {
    deliveryPlan: bootstrapPlan ?? undefined,
    inboundMessageHandle: inboundMessageHandleForReaction(event),
    transcriptIdempotencyKey: deriveSessionMessageIdempotencyKey(event.sessionId, "assistant", bootstrapComposed.text),
    allowImperfection: false,
  })
  await persistSharedOnboardingSlangPicks({
    db: store.db,
    userId: event.userId,
    priorPicks: priorSlangPicks,
    newPicks: bootstrapComposed.slangPicked,
    nowIso: store.nowIso(),
    log: (name, payload) => store.log(name, payload ?? {}),
  })
  await store.updateTurn(turnId, {
    status: "succeeded",
    stage: "succeeded",
    completedAt: now,
    directIntent: "shared_onboarding",
    directIntentResult: "bootstrapped_q1_inline",
    sharedOnboardingQuestionId: q1,
  })
  await store.markEventSucceeded(event.id)
  return true
}

async function sendFindMatchPreCallBubble(
  store: OrchestratorStore,
  event: InboundEvent,
  turnId: string,
  lang: "en" | "zh",
): Promise<void> {
  const pre = composeFindMatchPreCall(lang, `${event.userId}:${event.id}`)
  const at = store.nowIso()
  await store.appendMessage({
    id: `out-precall-${event.id}`,
    sessionId: event.sessionId,
    userId: event.userId,
    role: "assistant",
    body: pre,
    createdAt: at,
    idempotencyKey: `out-precall-${event.id}`,
    rawMeta: {
      source: "pa_orchestrator",
      turnId,
      eventId: event.id,
      kind: "find_match_pre_call",
    },
  })
  if (shouldSuppressOutbound(event)) return
  await store.enqueueOutbound(event.userId, event.from, pre, {
    sessionId: event.sessionId,
    role: "assistant",
    idempotencyKey: `outbound-precall-${event.id}`,
  })
  store.log("pa.runtime.job_search.pre_call_sent", {
    userId: event.userId,
    turnId,
    lang,
  })
}

async function handleCompletedUserJobSearchRequest(
  event: InboundEvent,
  store: OrchestratorStore,
  turnId: string,
  onboardingUser: Awaited<ReturnType<OrchestratorStore["getOnboardingUser"]>>
): Promise<boolean> {
  if (!store.generateJobRecs) return false
  if (isJobRecommendationExplanationRequest(event.body)) return false
  const explicitJobSearch = isExplicitJobSearchRequest(event.body)
  const moreFollowup = isMoreJobSearchFollowupRequest(event.body)
  const profileUpdate = extractLifecycleProfileUpdate(event.body)
  const onboardingComplete = onboardingUser?.onboardingState === "complete"
  if (!onboardingComplete && onboardingUser?.source === WEKRUIT_LAYOFF_SOURCE) return false
  const recentRecommendationContext = onboardingComplete && !explicitJobSearch
    ? await hasRecentJobRecommendationContext(store, event.userId)
    : false
  if (!explicitJobSearch && !(recentRecommendationContext && (moreFollowup || profileUpdate))) return false

  const lang: "en" | "zh" = detectLang([event.body]) === "zh" ? "zh" : "en"
  const requestedCount = requestedJobRecCount(event.body)
  const roleFocus = detectLifecycleRoleFocus(event.body)
  const excludeInternships = shouldExcludeInternshipsForExplicitJobSearch(event.body)
  const profileUpdated = await persistJobSearchProfileUpdate(event, store, turnId, profileUpdate)
  store.log("pa.runtime.job_search.direct_request", {
    userId: event.userId,
    turnId,
    lang,
    roleFocus,
    excludeInternships,
    explicitJobSearch,
    moreFollowup,
    profileUpdated,
  })
  await sendFindMatchPreCallBubble(store, event, turnId, lang)
  const recs = await store.generateJobRecs(event.userId, lang, {
    force: true,
    ...(requestedCount ? { requestedCount } : {}),
    ...(roleFocus.length > 0 ? { roleFocus } : {}),
    ...(excludeInternships ? { excludeInternships: true } : {}),
  })
  const recCount = recs?.recCount ?? 0
  const body =
    recCount > 0
      ? recs!.message
      : lang === "zh"
        ? "这次没捞到特别合适的，我记下了，晚点再帮你扫一轮。"
        : "I could not pull fresh roles right now. I saved the request and will try again shortly."
  const frame = frameConnectorResult("find-match", lang, recCount)
  const reply = frame ? [frame, body].filter(Boolean).join("\n") : body
  await sendMemoryReply(store, event, turnId, reply)
  if (recs && recs.recCount > 0 && store.db) {
    await startPostMatchRetentionAfterJobRecs({
      db: store.db,
      userId: event.userId,
      recCount: recs.recCount,
      sessionId: event.sessionId,
      toE164: event.from,
      lang,
      enqueueOutbound: store.enqueueOutbound,
    })
  }
  await store.updateTurn(turnId, {
    status: "succeeded",
    stage: "succeeded",
    completedAt: store.nowIso(),
    directIntent: "job_search",
    directIntentResult: recs && recs.recCount > 0 ? "sent_recs" : "no_recs",
    directIntentRecCount: recs?.recCount ?? 0,
    directIntentProfileUpdated: profileUpdated,
    directIntentFollowup: !explicitJobSearch,
  })
  await store.markEventSucceeded(event.id)
  return true
}

type PrivacyIntent =
  | { kind: "summary"; includeMemory: boolean }
  | { kind: "request"; requestKind: PrivacyRequestKind }

function detectPrivacyIntent(text: string | undefined | null): PrivacyIntent | null {
  const body = (text ?? "").trim()
  if (!body) return null
  const lower = body.toLowerCase()
  const asksMemory =
    /\b(?:what\s+do\s+you\s+remember|what\s+you\s+remember|see\s+what\s+you\s+remember|show\s+me\s+(?:my\s+)?memory|my\s+memory)\b/i.test(body) ||
    /(?:你记得我|我的记忆|你保存了什么|你存了什么)/.test(body)
  const asksData =
    /\b(?:what\s+data|which\s+data|what\s+info|what\s+information|data\s+do\s+you\s+store|store\s+about\s+me|saved\s+about\s+me)\b/i.test(body) ||
    /(?:什么数据|哪些数据|保存.*我|存.*我)/.test(body)
  if (
    /\b(?:delete|erase|remove)\s+(?:all\s+)?(?:my\s+)?(?:data|profile|information|account)\b/i.test(body) ||
    /(?:删除|清除|抹掉).*(?:数据|资料|档案|账号|账户)/.test(body)
  ) {
    return { kind: "request", requestKind: "delete" }
  }
  if (
    /\b(?:export|download|send|give)\s+(?:me\s+)?(?:a\s+copy\s+of\s+)?(?:my\s+)?(?:data|profile|information)\b/i.test(body) ||
    /(?:导出|下载|发给我).*(?:数据|资料|档案)/.test(body)
  ) {
    return { kind: "request", requestKind: "export" }
  }
  if (
    /\b(?:stop|pause)\s+(?:texting|outreach|messages|reaching\s+out)\b/i.test(body) ||
    /(?:停止|暂停).*(?:短信|联系|触达|外呼)/.test(body)
  ) {
    return { kind: "request", requestKind: "stop_outreach" }
  }
  if (asksData || asksMemory || lower.includes("privacy")) {
    return { kind: "summary", includeMemory: asksMemory }
  }
  return null
}

async function handlePrivacyIntent(
  event: InboundEvent,
  store: OrchestratorStore,
  turnId: string,
  intent: PrivacyIntent
): Promise<boolean> {
  const lang = detectUserLang(event.body) === "zh" ? "zh" : "en"
  await store.updateTurn(turnId, { stage: "privacy_intent", updatedAt: store.nowIso() })

  if (intent.kind === "summary") {
    const lines =
      lang === "zh"
        ? [
            "我会保存几类和求职有关的信息：你的简历解析结果、联系方式、工作偏好、签证/授权、地点/薪资偏好、对话里你确认过的经历，以及每次岗位 screen 的结果。",
            "你可以回 “我的记忆” 看我保存的长期记忆；要导出或删除资料，直接回 “export my data” 或 “delete my data”。",
          ]
        : [
            "I store job-search info you have shared with WeKruit: parsed resume details, contact info, work preferences, visa/work authorization, location and comp preferences, confirmed experience notes, and role-screen outcomes.",
            "Reply “my memory” to see saved long-term notes. Reply “export my data” or “delete my data” and I will file that privacy request for review.",
          ]
    if (intent.includeMemory) {
      const facts = await store.listMemoryFacts(event.userId)
      lines.push(memoryReplyForList(facts, lang))
      await store.recordMemoryAction({ userId: event.userId, eventId: event.id, action: "list", status: "succeeded" })
    }
    await sendMemoryReply(store, event, turnId, lines.join("\n\n"))
    return true
  }

  if (!store.createPrivacyRequest) {
    await sendMemoryReply(
      store,
      event,
      turnId,
      lang === "zh"
        ? "我知道了。现在短信里不能直接提交这个隐私请求，请从你的 WeKruit 个人资料页提交，我会避免继续展开敏感信息。"
        : "Got it. I cannot submit that privacy request from this channel right now, so please use your WeKruit profile page. I will avoid expanding sensitive details here."
    )
    return true
  }
  const result = await store.createPrivacyRequest({
    userId: event.userId,
    kind: intent.requestKind,
    detail: event.body ?? "",
    eventId: event.id,
    sessionId: event.sessionId,
  })
  const kindCopy: Record<PrivacyRequestKind, string> = {
    export: "data export",
    delete: "data deletion",
    stop_outreach: "outreach stop",
    privacy_question: "privacy",
  }
  const reply =
    lang === "zh"
      ? `收到，我已经提交了${kindCopy[result.kind]}请求。${result.existingOpen ? "你已经有一个同类型请求在处理中，我不会重复创建。" : "我们会从后台处理并保留审计记录。"}`
      : `Got it. I submitted a ${kindCopy[result.kind]} request.${result.existingOpen ? " You already had one open, so I did not create a duplicate." : " We will review it from the privacy queue and keep an audit trail."}`
  await sendMemoryReply(store, event, turnId, reply)
  return true
}

async function handleMemoryCommand(
  event: InboundEvent,
  store: OrchestratorStore,
  turnId: string,
  command: NonNullable<ReturnType<typeof parseMemoryCommand>>
): Promise<boolean> {
  await store.updateTurn(turnId, { stage: "memory_command", updatedAt: store.nowIso() })
  const lang = detectUserLang(event.body) === "zh" ? "zh" : "en"
  if (command.kind === "list") {
    const facts = await store.listMemoryFacts(event.userId)
    await store.recordMemoryAction({ userId: event.userId, eventId: event.id, action: "list", status: "succeeded" })
    await sendMemoryReply(store, event, turnId, memoryReplyForList(facts, lang))
    return true
  }

  if (command.kind === "forget") {
    const facts = await store.listMemoryFacts(event.userId)
    const matches = findMatchingFacts(facts, command.query)
    if (matches.length === 0) {
      await sendMemoryReply(store, event, turnId, "我没有找到匹配的长期记忆。你可以说：我的记忆。")
      return true
    }
    if (matches.length > 1) {
      const prefix = lang === "zh"
        ? "我找到多条匹配记忆，请说得更具体："
        : "I found multiple matching memories. Be more specific:"
      await sendMemoryReply(store, event, turnId, `${prefix}\n${memoryReplyForList(matches, lang)}`)
      return true
    }
    await store.deleteMemoryFacts(event.userId, [matches[0]!.id], event.id)
    await store.recordMemoryAction({
      userId: event.userId,
      eventId: event.id,
      action: "forget",
      status: "succeeded",
      content: command.query,
      factIds: [matches[0]!.id],
    })
    await sendMemoryReply(store, event, turnId, `已忘记：${matches[0]!.content}`)
    return true
  }

  if (command.kind === "clear_request") {
    await store.recordMemoryAction({ userId: event.userId, eventId: event.id, action: "clear_request", status: "succeeded" })
    await sendMemoryReply(store, event, turnId, "这会删除我保存的所有长期记忆。请回复：确认清空记忆")
    return true
  }

  if (command.kind === "clear_confirm") {
    const facts = await store.listMemoryFacts(event.userId)
    await store.deleteMemoryFacts(event.userId, facts.map((f) => f.id), event.id)
    await store.recordMemoryAction({
      userId: event.userId,
      eventId: event.id,
      action: "clear_confirm",
      status: "succeeded",
      factIds: facts.map((f) => f.id),
    })
    await sendMemoryReply(store, event, turnId, `已清空 ${facts.length} 条长期记忆。`)
    return true
  }

  return false
}


/**
 * Phase 10.5 T7 — bridge `agent.allowedConnectors` → SDK `tool()` instances.
 *
 * Each entry in the returned array goes through `runConnector` so audit +
 * safety policy fire identically to the legacy regex paths. The shared
 * `counter` closure carries the per-turn `usedThisTurn` count so the
 * connector policy budget is enforced even when the SDK invokes multiple
 * tools concurrently.
 *
 * **Counter under SDK parallel tool execution.** The SDK's
 * `runner/toolExecution` uses `Promise.all` to dispatch function tool
 * calls within a turn, so two tool execute closures CAN start before
 * either resolves. JS is single-threaded, so the read+increment of a
 * primitive `counter.value` within a synchronous block is atomic — there
 * is no preemption mid-statement. The bridge captures the snapshot
 * BEFORE incrementing and BEFORE awaiting `runConnector`, so:
 *
 *   - n parallel calls each see a unique snapshot in [0..n-1].
 *   - canUseConnector denies once snapshot >= toolBudgetPerTurn.
 *
 * Mutex is unnecessary; if the SDK ever introduces a non-Node async
 * scheduler (workers), this comment is the canary — revisit and add a
 * proper atomic.
 *
 * `current-info` is intentionally hosted by T4 as the SDK's
 * `webSearchTool` (not a custom function tool). After Phase 10.5 cleanup
 * C6, no `current-info` registry entry exists; the allowlist string
 * "current-info" is still meaningful as the gate name read by
 * `buildHostedToolsForDefault`. The deferred audit row for hosted
 * web_search is emitted by T9 after the turn completes via
 * `recordHostedToolCalls`.
 */
export function buildTurnTools(
  db: Firestore,
  agent: AgentDef,
  turn: { turnId: string; userId: string; sessionId: string },
  hooks?: MatchConnectorHooks
): AgentTurnTool[] {
  if (agent.toolPolicy === "none") return []
  const allowed = agent.allowedConnectors ?? []
  if (allowed.length === 0) return []
  const counter = { value: 0 }
  const tools: AgentTurnTool[] = []
  for (const name of allowed) {
    // Phase 10.5 cleanup C6: the `current-info` connector registry entry
    // was removed; the SDK-hosted webSearchTool replaces it on the default
    // path. The string `"current-info"` remains valid in
    // `agent.allowedConnectors` as the gate name for buildHostedToolsForDefault,
    // but it is no longer a custom function tool — `name in connectorRegistry`
    // returns false and we skip below.
    if (!(name in connectorRegistry)) continue
    const def = connectorRegistry[name as ConnectorName]
    tools.push({
      name,
      description: def.description,
      // Each connector's zod input schema reaches the SDK directly.
      // pa-connectors uses zod ^3.24, agent-runtime types use zod^4 —
      // runtime shape is identical for object schemas. Cast through
      // unknown so the @pa boundary stays clean.
      parameters: def.inputSchema as unknown as AgentTurnTool["parameters"],
      execute: async (args: unknown) => {
        // Pre-increment: snapshot the current count, then bump. Both
        // operations are synchronous (no await between read and write),
        // so under JS's single-threaded model this gives each parallel
        // tool call a unique monotonically-increasing snapshot.
        const snapshot = counter.value
        counter.value = snapshot + 1
        try {
          const result = await runConnector(name as ConnectorName, args, {
            db,
            agent,
            turnId: turn.turnId,
            userId: turn.userId,
            sessionId: turn.sessionId,
            usedThisTurn: snapshot,
            hooks,
          })
          return JSON.stringify(result).slice(0, 1024)
        } catch (e) {
          // Surface to the SDK so the LLM can apologize. Do NOT swallow.
          throw e
        }
      },
    })
  }
  return tools
}

export async function processInboundEvent(event: InboundEvent, store: OrchestratorStore): Promise<void> {
  // Bug 5 invariant — Adam iMessage 2026-05-03 01:05+01:22 production crash:
  //   `[orchestrator] turn failed … errorCode: 'TURN_FAILED', error:
  //    'Cannot use "undefined" as a Firestore value (found in field "body")'`
  // RCA: the coalescer's synthesized inbound doc used to omit a top-level
  // `body` (only `userId`/`sessionId` were stamped — see the Bug 1 analog in
  // apps/functions/src/coalesce/paMessageCoalescer.ts processCoalescedTurn).
  // `event.body` arrived `undefined`, the appendMessage write below received
  // `body: undefined`, and Firestore rejected. The proper fix lives in the
  // coalescer stamp; this is defense-in-depth at the orchestrator boundary so
  // any future synthesis path that forgets `body` fails LOUD with a clear
  // engineering message instead of an opaque Firestore validation crash.
  // Same pattern as packages/pa-broker/src/turns.ts createAgentTurn's
  // sessionId/userId invariants.
  if (event.body === undefined || event.body === null) {
    throw new Error(
      `processInboundEvent: event.body is required (received ${event.body === undefined ? "undefined" : "null"}) — eventId=${event.id}, userId=${event.userId ?? "<missing>"}. Fix the upstream synthesizer (likely paMessageCoalescer.processCoalescedTurn).`
    )
  }
  await store.markEventRunning(event.id)
  const turnId = await store.createTurn(event)
  const at = store.nowIso()
  try {
    const runtimeEvent = event.rawMeta?.runtimeEvent === true
    const userAuthoredEvent = !runtimeEvent
    const runtimeNoSendToken =
      typeof event.rawMeta?.runtimeNoSendToken === "string"
        ? event.rawMeta.runtimeNoSendToken.trim()
        : "__NO_SEND__"
    await store.appendMessage({
      sessionId: event.sessionId,
      userId: event.userId,
      role: runtimeEvent ? "system" : "user",
      body: event.body,
      createdAt: event.createdAt,
      // Use the same hash FirestoreSession derives so the SDK\u2019s addItems()
      // short-circuits on this row instead of double-writing the user turn.
      // Original inbound idempotencyKey is preserved in rawMeta for audit.
      idempotencyKey: deriveSessionMessageIdempotencyKey(
        event.sessionId,
        runtimeEvent ? "system" : "user",
        event.body
      ),
      rawMeta: {
        ...event.rawMeta,
        source: "pa-inbound-event",
        eventId: event.id,
        turnId,
        inboundIdempotencyKey: event.idempotencyKey,
      },
    })

    // iter31 — Human-in-the-loop pause gate. Adam directive 2026-05-04
    // ("on pause agent won't process any response but will process memory,
    // on resume it won't say anything until next texts"). When operator has
    // flipped user.runtimeMode = "paused", we keep the inbound write to
    // pa-messages above (so memory + audit are preserved for the operator
    // to read) but skip ALL of safety / onboarding / LLM / outbound. Reset
    // commands ARE honored even under pause so testers can scrub state. On
    // resume: no auto-reply is generated; the next inbound flows through
    // the normal path. Self-gating: when getRuntimeMode is unimplemented
    // (older test harnesses) or returns "auto", behavior is unchanged.
    if (store.getRuntimeMode) {
      const mode = await store.getRuntimeMode(event.userId)
      if (mode === "paused") {
        store.log("pa.hitl.paused.inbound_skip", {
          userId: event.userId,
          turnId,
          eventId: event.id,
          inboundLen: (event.body ?? "").length,
        })
        await store.updateTurn(turnId, {
          status: "succeeded",
          stage: "hitl_paused",
          completedAt: store.nowIso(),
        })
        await store.markEventSucceeded(event.id)
        return
      }
    }

    const focusedRuntimeRecommendation = runtimeEvent
      ? buildFocusedRuntimeRecommendationPlan(event.rawMeta)
      : null
    const trustedRuntimeBody = runtimeEvent ? trustedRuntimeOutboundBody(event.rawMeta) : null
    if (focusedRuntimeRecommendation || trustedRuntimeBody) {
      const body = focusedRuntimeRecommendation?.body ?? trustedRuntimeBody!
      await sendMemoryReply(store, event, turnId, body, {
        deliveryPlan: focusedRuntimeRecommendation?.plan,
      })
      await store.updateTurn(turnId, {
        status: "succeeded",
        stage: "succeeded",
        runtimeTrustedOutbound: true,
        runtimeFocusedRecommendation: Boolean(focusedRuntimeRecommendation),
        runtimeEventSource: event.rawMeta?.runtimeEventSource ?? null,
        runtimeEventKind: event.rawMeta?.runtimeEventKind ?? null,
        completedAt: store.nowIso(),
      })
      await store.markEventSucceeded(event.id)
      return
    }

    // Test-admin magic string. Must run BEFORE parseMemoryCommand so it
    // doesn't get swallowed by an unrelated memory grammar rule.
    if (userAuthoredEvent) {
      const reset = await store.maybeHandleResetCommand(event)
      if (reset.handled) {
        await sendMemoryReply(store, event, turnId, reset.summary ?? "✓ Test memory cleared.")
        await store.updateTurn(turnId, { status: "succeeded", stage: "succeeded", completedAt: store.nowIso() })
        await store.markEventSucceeded(event.id)
        return
      }
    }

    // iter30 WS6 — shadow-mode INPUT guardrail chain. Telemetry-only;
    // does NOT gate the request. Runs the locked 4-stage input chain
    // (crisisDetector → promptInjectionDetector → piiScanner →
    // lengthInputCheck) parallel to the legacy `checkInboundSafety`
    // path so we can compare decisions before WS6 cutover. PII
    // enforcement (SSN/CC/passport/idcard/bankcard) is the load-bearing
    // gap legacy doesn't cover. Disabled by default — env flag
    // `PA_GUARDRAIL_INPUT_CHAIN_SHADOW=true` turns it on.
    if (userAuthoredEvent && process.env.PA_GUARDRAIL_INPUT_CHAIN_SHADOW === "true") {
      const shadowT0 = Date.now()
      try {
        const shadowLang = pickLangForSafety(event.body)
        const shadowCtx = createMockContext({
          userId: event.userId ?? "unknown",
          conversationId: event.sessionId ?? "unknown",
          turnId,
          eventId: event.id ?? "unknown",
          locale: shadowLang === "zh" ? "zh-CN" : "en-US",
          log: (evt, payload) =>
            store.log(evt, { ...(payload ?? {}), shadow: true }),
        })
        const shadowResult = await runInputChain({
          guardrails: INPUT_GUARDRAIL_CHAIN,
          input: event.body ?? "",
          ctx: shadowCtx,
        })
        store.log("pa.guardrails.input.shadow.result", {
          userId: event.userId,
          turnId,
          eventId: event.id,
          allowed: shadowResult.allowed,
          trippedBy: shadowResult.trippedBy,
          latencyMs: Date.now() - shadowT0,
          inputLen: (event.body ?? "").length,
          hits: shadowCtx.guardrailHits.map((h) => ({
            name: h.name,
            tripped: h.tripped,
            latencyMs: h.latencyMs,
            metadata: h.metadata,
          })),
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        store.log("pa.guardrails.input.shadow.error", {
          userId: event.userId,
          turnId,
          eventId: event.id,
          latencyMs: Date.now() - shadowT0,
          error: msg,
        })
      }
    }

    if (userAuthoredEvent) {
      const safety = await store.checkInboundSafety(event)
      if (!safety.allow) {
        // Phase 46 (v1.5 Stream-E) — action-aware safety branch with bilingual canned replies.
        // Backward-compat: if `action` is undefined (legacy callers / test mocks), fall
        // through to the legacy reason-based message selection.
        const lang = pickLangForSafety(event.body)
        let msg: string | null
        if (safety.action === "silent_drop") {
          msg = null // no reply at all (cooldown)
        } else if (safety.action === "respond_sanitized") {
          msg = SAFETY_CANNED_REPLIES.respond_sanitized[lang]
        } else if (safety.action === "escalate") {
          msg = SAFETY_CANNED_REPLIES.escalate[lang]
        } else {
          // Legacy path (Phase 23 reason-only). Keep wording bytewise identical for
          // zero-regression on flag-off + legacy mock callers.
          msg =
            safety.reason === "rate_limited"
              ? "You’re sending a bit too fast. Give it a few seconds and try again."
              : "I can’t work with that message. Try rephrasing."
        }
        if (msg !== null) {
          await sendMemoryReply(store, event, turnId, msg)
        }
        await store.updateTurn(turnId, {
          status: "succeeded",
          stage: "succeeded",
          completedAt: store.nowIso(),
          errorCode: safety.reason,
          error: "inbound_safety_block",
        })
        await store.markEventSucceeded(event.id)
        return
      }
    }

    if (userAuthoredEvent && detectJobRecommendationSubscriptionResume(event.body)) {
      const resumeResult = await store.resumeJobRecommendationSubscription?.(event.userId, {
        inboundEventId: event.id,
        sessionId: event.sessionId,
        reason: "candidate_restart",
        occurredAt: store.nowIso(),
      }) ?? { resumed: false }
      const reply = resumeResult.resumed
        ? "Got it — job recommendations are back on."
        : "Got it — I can send job recommendations when you ask."
      await sendMemoryReply(store, event, turnId, reply)
      await store.updateTurn(turnId, {
        status: "succeeded",
        stage: "succeeded",
        directIntent: "job_rec_subscription_resume",
        directIntentResult: resumeResult.resumed ? "resumed" : "no_subscription_record",
        completedAt: store.nowIso(),
      })
      await store.markEventSucceeded(event.id)
      return
    }

    if (userAuthoredEvent && detectJobRecommendationSubscriptionCancel(event.body)) {
      const pauseResult = await store.pauseJobRecommendationSubscription?.(event.userId, {
        inboundEventId: event.id,
        sessionId: event.sessionId,
        reason: "candidate_cancel",
        occurredAt: store.nowIso(),
      }) ?? { paused: false }
      const cancelledCount = await store.cancelAllPendingProactiveJobs(event.userId)
      if (cancelledCount > 0) {
        await store.writeProactiveCancelAudit({
          userId: event.userId,
          sessionId: event.sessionId,
          inboundEventId: event.id,
          cancelledCount,
        })
      }
      const reply = pauseResult.paused || cancelledCount > 0
        ? "Got it — I paused job recommendations. You can ask me to restart anytime."
        : "Got it — I won't send job recommendations unless you ask me to restart."
      await sendMemoryReply(store, event, turnId, reply)
      await store.updateTurn(turnId, {
        status: "succeeded",
        stage: "succeeded",
        directIntent: "job_rec_subscription_cancel",
        directIntentResult: pauseResult.paused ? "paused" : "no_active_subscription",
        proactiveCancelledCount: cancelledCount,
        completedAt: store.nowIso(),
      })
      await store.markEventSucceeded(event.id)
      return
    }

    // Phase 22 — proactive cancellation NLU pre-LLM hook (D-07, PROACTIVE-06).
    // Must run before memory commands so "停止提醒" short-circuits cleanly.
    if (userAuthoredEvent && detectProactiveCancellation(event.body)) {
      const cancelledCount = await store.cancelAllPendingProactiveJobs(event.userId)
      await store.writeProactiveCancelAudit({
        userId: event.userId,
        sessionId: event.sessionId,
        inboundEventId: event.id,
        cancelledCount,
      })
      // Voice v1-toned confirmation reply — concise, natural (D-07)
      const cancelReply = cancelledCount > 0 ? "好的，全停了 ✋" : "没有待发送的提醒了哦。"
      await sendMemoryReply(store, event, turnId, cancelReply)
      await store.updateTurn(turnId, { status: "succeeded", stage: "succeeded", completedAt: store.nowIso() })
      await store.markEventSucceeded(event.id)
      return
    }

    // Phase 10.5 T5: regex pre-routers for "remember" writes are gone — the
    // LLM owns memory writes via the `remember-fact` connector tool. We still
    // handle list/forget/clear at the orchestrator (those are admin commands,
    // not tools the LLM should own).
    const command = userAuthoredEvent ? parseMemoryCommand(event.body) : null
    if (command && command.kind !== "remember" && await handleMemoryCommand(event, store, turnId, command)) {
      await store.updateTurn(turnId, { status: "succeeded", stage: "succeeded", completedAt: store.nowIso() })
      await store.markEventSucceeded(event.id)
      return
    }

    const privacyIntent = userAuthoredEvent ? detectPrivacyIntent(event.body) : null
    if (privacyIntent && await handlePrivacyIntent(event, store, turnId, privacyIntent)) {
      await store.updateTurn(turnId, { status: "succeeded", stage: "succeeded", completedAt: store.nowIso() })
      await store.markEventSucceeded(event.id)
      return
    }

    if (userAuthoredEvent && (await handleCollabInviteReply(event, store, turnId))) {
      return
    }

    const onboardingUser = await store.getOnboardingUser(event.userId)
    if (await handleSharedOnboardingRuntimeEvent(event, store, turnId, onboardingUser)) {
      return
    }

    const conversationTurnContext = userAuthoredEvent
      ? await buildConversationTurnContext(event, store, turnId, onboardingUser)
      : null
    const conversationOwnerDecision = conversationTurnContext
      ? decideConversationTurnOwner(conversationTurnContext)
      : null
    const conversationActionDecision = conversationTurnContext && conversationOwnerDecision
      ? decideConversationDeliveryAction(conversationTurnContext, conversationOwnerDecision)
      : null
    const conversationEvidenceWrites = conversationTurnContext && conversationOwnerDecision && conversationActionDecision
      ? buildConversationEvidenceWrites(conversationTurnContext, conversationOwnerDecision, conversationActionDecision)
      : []
    const conversationEvidenceCommitIds = conversationTurnContext
      ? await commitConversationEvidenceWrites(store, event, conversationTurnContext, conversationEvidenceWrites)
      : []
    if (conversationTurnContext && conversationOwnerDecision) {
      await persistConversationTurnTrace(
        store,
        event,
        conversationTurnContext,
        conversationOwnerDecision,
        "owner_arbitrated",
        conversationActionDecision ?? undefined,
        conversationEvidenceWrites,
        {
          evidenceCommitIds: conversationEvidenceCommitIds,
          evidenceCommitCount: conversationEvidenceCommitIds.length,
        },
      )
      if (
        conversationActionDecision?.selectedAction === "tapback_only" &&
        await handleConversationTapbackOnlyTurn(
          event,
          store,
          turnId,
          conversationTurnContext,
          conversationOwnerDecision,
          conversationActionDecision,
          conversationEvidenceWrites,
          conversationEvidenceCommitIds,
        )
      ) {
        return
      }
      if (
        conversationOwnerDecision.selectedOwner === "prescreen_outcome_explainer" &&
        conversationActionDecision &&
        await handlePrescreenOutcomeExplainerTurn(
          event,
          store,
          turnId,
          conversationTurnContext,
          conversationOwnerDecision,
          conversationActionDecision,
          conversationEvidenceWrites,
          conversationEvidenceCommitIds,
        )
      ) {
        return
      }
      if (
        conversationOwnerDecision.selectedOwner === "shared_onboarding" &&
        conversationActionDecision &&
        await handleSharedOnboardingClarificationTurn(
          event,
          store,
          turnId,
          onboardingUser,
          conversationTurnContext,
          conversationOwnerDecision,
          conversationActionDecision,
          conversationEvidenceWrites,
          conversationEvidenceCommitIds,
        )
      ) {
        return
      }
      if (
        conversationOwnerDecision.selectedOwner === "durable_preference_update" &&
        conversationActionDecision &&
        await handleDurablePreferenceUpdateTurn(
          event,
          store,
          turnId,
          conversationTurnContext,
          conversationOwnerDecision,
          conversationActionDecision,
          conversationEvidenceWrites,
          conversationEvidenceCommitIds,
        )
      ) {
        return
      }
      if (
        conversationOwnerDecision.selectedOwner === "explicit_explanation" &&
        conversationOwnerDecision.orderedActions.some((action) => action.kind === "commit_memory")
      ) {
        const profileUpdate = extractLifecycleProfileUpdate(event.body)
        const profileUpdated = await persistJobSearchProfileUpdate(event, store, turnId, profileUpdate)
        await store.updateTurn(turnId, {
          stage: "explicit_explanation_preference_committed",
          directIntent: "explicit_explanation",
          directIntentProfileUpdated: profileUpdated,
          updatedAt: store.nowIso(),
        })
      }
    }

    if (userAuthoredEvent && await handleCompletedUserJobSearchRequest(event, store, turnId, onboardingUser)) {
      return
    }

    // Website-started candidate and layoff onboarding use one runtime-led
    // intake. Do not force the generic deterministic pipeline.
    const sharedRuntimeSession = isSharedOnboardingActiveUser(onboardingUser)
    const sharedQuestionId = sharedRuntimeSession ? currentSharedOnboardingQuestionId(onboardingUser) : null
    const onboardingIncomplete = Boolean(
      userAuthoredEvent &&
      onboardingUser &&
      onboardingUser.onboardingState !== "complete" &&
      !sharedRuntimeSession
    )
    const allowSharedOnboardingUserReply =
      !conversationOwnerDecision ||
      conversationOwnerDecision.selectedOwner === "shared_onboarding" ||
      Boolean(
        sharedRuntimeSession &&
        sharedQuestionId &&
        shouldIgnoreSharedOnboardingDuplicateKickoff(sharedQuestionId, event.body),
      )
    if (
      userAuthoredEvent &&
      allowSharedOnboardingUserReply &&
      await handleSharedOnboardingUserReply(
        event,
        store,
        turnId,
        onboardingUser,
        conversationTurnContext && conversationOwnerDecision
          ? {
              context: conversationTurnContext,
              ownerDecision: conversationOwnerDecision,
              actionDecision: conversationActionDecision,
              evidenceWrites: conversationEvidenceWrites,
              evidenceCommitIds: conversationEvidenceCommitIds,
            }
          : undefined,
      )
    ) {
      return
    }
    if (
      userAuthoredEvent &&
      await handleSharedOnboardingBootstrap(
        event,
        store,
        turnId,
        onboardingUser,
        sharedRuntimeSession,
      )
    ) {
      return
    }
    if (userAuthoredEvent && !onboardingIncomplete && await handleLifecycleProfileReply(event, store, turnId)) {
      await store.updateTurn(turnId, { status: "succeeded", stage: "succeeded", completedAt: store.nowIso() })
      await store.markEventSucceeded(event.id)
      return
    }

    if (userAuthoredEvent && (await handlePostMatchRetentionReply(event, store, turnId))) {
      return
    }

    const agent = await store.getAgentForUser(event.userId)
    if (!agent) throw Object.assign(new Error("No agent configured"), { code: "NO_AGENT" })

    if (onboardingIncomplete && detectOnboardingProcessQuestion(event.body)) {
      await sendMemoryReply(
        store,
        event,
        turnId,
        composeOnboardingProcessReply(onboardingUser?.onboardingState)
      )
      await store.updateTurn(turnId, {
        status: "succeeded",
        stage: "succeeded",
        directIntent: "onboarding_process_question",
        completedAt: store.nowIso(),
      })
      await store.markEventSucceeded(event.id)
      return
    }

    // Phase 23 — Onboarding state machine (D-03, D-04, D-08).
    // Run before normal LLM dispatch. For invited/new users, route through
    // onboarding steps using Voice v1 system prompt (D-04: no separate utility
    // prompt). On "complete", auto-promotes beta participant status.
    // ════════════════════════════════════════════════════════════════
    // iter32 — Deterministic onboarding dispatcher. Adam directive
    // 2026-05-04 ("we should have resume parsed before we start agent
    // runtime"): pre-runtime onboarding turns dispatch a configured
    // phrase verbatim via sendMemoryReply. NO LLM, NO Voice v1, NO
    // langlock. Same friend-tone surface, zero drift, ~7 LLM calls
    // saved per new user.
    //
    // Strict gate sequence:
    //   1. Onboarding state must be `complete`.
    //   2. parsedCandidateResumes row must exist when the legacy resume gate is active.
    // Until the active gates pass, agent runtime does NOT activate. The
    // dispatcher emits a deterministic re-prompt at whichever gate
    // hasn't cleared yet.
    //
    // The onboarding dispatcher is now the only onboarding route. Legacy
    // LLM-compose and flag/allowlist fallbacks are intentionally not wired:
    // an incomplete onboarding turn must either be handled here or fail
    // loudly instead of drifting into a parallel message producer.
    // ════════════════════════════════════════════════════════════════
    if (userAuthoredEvent && onboardingUser && !sharedRuntimeSession) {
      const cvParsedInbound = (event.body ?? "").trim().startsWith("[cv-parsed]")
      const cvParsed = store.getUserCvParsed
        ? await store.getUserCvParsed(event.userId)
        : false
      if (onboardingUser.onboardingState !== "complete" || cvParsedInbound) {
        const result = await runDeterministicOnboardingTurn({
          event,
          store,
          turnId,
          onboardingUser,
          cvParsed,
          agent,
          suppressOutbound: shouldSuppressOutbound(event),
        })
        if (result.handled) {
          await store.updateTurn(turnId, {
            status: "succeeded",
            stage: "succeeded",
            completedAt: store.nowIso(),
            onboardingDeterministicAction: result.action.kind,
          })
          await store.markEventSucceeded(event.id)
          return
        }
        throw Object.assign(new Error("onboarding_runtime_unhandled"), {
          code: "ONBOARDING_RUNTIME_UNHANDLED",
        })
      }

      store.log("pa.onboarding.deterministic.handoff_to_agent_runtime", {
        userId: event.userId,
        turnId,
        eventId: event.id,
        fromState: onboardingUser.onboardingState,
        gates: {
          cvParsed,
        },
        runtime: "openai-agents-sdk",
      })
    }

    await store.updateTurn(turnId, {
      agentId: agent.id,
      memoryMode: agent.memoryMode,
      stage: "memory_load" satisfies TurnStage,
      updatedAt: store.nowIso(),
    })
    const history = await store.loadHistory(event.sessionId, HISTORY_LIMIT)
    const facts = await store.listMemoryFacts(event.userId)
    // Phase 11.3 — load the Mem0 partition key once per turn and thread it
    // through both memory call sites. `stacked.ts` only honors this when
    // `PA_MEM0_USE_PARTITION_KEY=true`; passing it always is forward-safe
    // (worker path already does this), and means flipping the kill switch
    // is a pure env-var change with no orchestrator redeploy.
    const mem0UserIdForTurn = await store.getMem0UserId(event.userId)
    // Phase 11.3 / memory-opt — canonical resolver, never raw read.
    const mem0PartitionKey = resolveMem0PartitionKey({
      id: event.userId,
      mem0UserId: mem0UserIdForTurn,
    })
    const mem = await store.loadPersonalizationContext(
      agent,
      {
        userId: event.userId,
        mem0UserId: mem0PartitionKey,
        sessionId: event.sessionId,
        userMessage: event.body,
        memoryMode: agent.memoryMode,
      },
      history
    )
    await store.updateTurn(turnId, {
      mem0Degraded: mem.mem0Degraded,
      mem0DegradedReason: mem.mem0DegradedReason ?? null,
      mem0SearchResultCount: mem.mem0SearchResultCount,
      stage: "llm" satisfies TurnStage,
      updatedAt: store.nowIso(),
    })

    // Legacy `memoryBlock` field — consumed ONLY by the chat.completions
    // emergency-rollback path (PA_AGENT_RUNTIME=chat_completions). Shape
    // unchanged from pre-D2: `Confirmed user facts:\n…\n\nRelevant memory:\n…`
    // (facts + Mem0 concatenated). Kill-switch contract preserved.
    const memoryBlock = memoryBlockWithFacts(mem.memoryBlock, facts)
    const session = store.createSession({ sessionId: event.sessionId, userId: event.userId })
    // Phase 11.1.2 — persona card is a deterministic system input prepended
    // BEFORE the Mem0 recall block. Source is Firestore confirmed facts
    // only (never Mem0/Qdrant). `PA_PERSONA_CARD_DISABLED=true` is the
    // 1-line rollback flag (Phase 11.1 PLAN §5). Empty card → null →
    // omitted; no bare heading is ever injected.
    const personaCard =
      process.env.PA_PERSONA_CARD_DISABLED === "true"
        ? null
        : buildPersonaCard(facts)
    // Phase 11.1 cleanup D2 — default-path recall is Mem0-only. Facts are
    // already surfaced via persona card; do NOT double-write them into
    // the recall channel.
    const recallEntry = buildRecallSystemInput(mem.memoryBlock)
    const voiceReminder = buildVoiceReminder()
    // Phase 19 ADAPT-02 — adaptive mirror snippet. Per D-04 the snippet is
    // appended AFTER the Phase 18 voice reminder so it sits immediately
    // before the user turn. Per D-07 setting PA_VOICE_MIRROR_DISABLED=true
    // returns nulls (skips analyzer + injection) — `mirror.snippet` is
    // null and the filter below drops it. Same env flag also gates the
    // mem0 style-preference write in afterAssistantTurn (D-07: rollback
    // bleeds nothing).
    // Phase 24.5 — flag-backed kill switch. When store.db is present we
    // consult pa_feature_flags (env=true still short-circuits inside SDK).
    // Test path with no db falls through to the existing env-only check
    // inside computeMirrorForTurn. Pure wrapper — no logic change to the
    // existing snippet computation.
    const mirrorDisabledByFlag =
      store.db != null
        ? await isVoiceMirrorDisabledFlag(store.db, process.env)
        : false
    const mirror = mirrorDisabledByFlag
      ? { snapshot: null, snippet: null, audit: null }
      : computeMirrorForTurn(history, event.body)
    if (mirror.audit) {
      store.log("pa.voice.mirror.injected", {
        userId: event.userId,
        ...mirror.audit,
      })
    }
    // Phase 21 Track 5 → Phase 32 W3 — playbook activation now sources its
    // regex triggers + addendum bodies from `pa-playbooks/{playbookKey}` via
    // a 30s in-memory cache. Backward-compat: if Firestore returns no
    // matches (or the load fails), we fall back to the inline
    // HEADHUNTER_TRIGGER_RE + addendum so a first-deploy race or empty
    // collection never breaks the running playbook. Sits AFTER the
    // Phase 18 voice reminder and BEFORE the Phase 19 mirror snippet
    // (D-04 ordering intact).
    let playbookAddendum: string | null = null
    let headhunterActive = false
    let playbookRouting: PlaybookRoutingResult = {
      addendum: "",
      allowedTools: [],
      activeSkillKeys: [],
      source: "v1_cache",
    }
    if (store.db != null) {
      playbookRouting = await resolvePlaybookForTurn({
        db: store.db,
        userId: event.userId,
        messageBody: event.body,
        log: (evt, payload) => store.log(evt, payload ?? {}),
      })
      if (playbookRouting.addendum.length > 0) {
        playbookAddendum = playbookRouting.addendum
        headhunterActive =
          playbookRouting.activeSkillKeys.includes(HEADHUNTER_PLAYBOOK_ID) ||
          (event as { playbook?: string }).playbook === HEADHUNTER_PLAYBOOK_ID
      }
    }
    if (!playbookAddendum) {
      // Failsafe path — Firestore empty or load failed. Mirrors the
      // pre-Wave-3 behavior so the headhunter playbook still activates.
      const fallbackActive =
        (event as { playbook?: string }).playbook === HEADHUNTER_PLAYBOOK_ID ||
        HEADHUNTER_TRIGGER_RE.test(event.body)
      if (fallbackActive) {
        const fallbackEntry = headhunterAddendum({ active: true })
        if (fallbackEntry) {
          playbookAddendum = fallbackEntry
          headhunterActive = true
        }
      }
    } else if (
      // If Firestore matched but headhunter is hinted via ctx, ensure ctx
      // tag stays sticky for downstream consumers (probe rotation hint).
      (event as { playbook?: string }).playbook === HEADHUNTER_PLAYBOOK_ID
    ) {
      headhunterActive = true
    }
    // Suppress unused-warning when the failsafe path is dead (env-disabled).
    void headhunterActive
    // -------------------------------------------------------------------
    // Adam iter 19 — slang directive injection. Re-uses the Phase-18
    // VOICE-07 slang lexicon (orphaned since mirror disable per Bug 11)
    // as a per-turn system-prompt hint. Pure text, sub-1ms, lang-aware
    // (zh/en/mixed), seeded by turnId for replay determinism.
    //
    // Wired into systemInputs alongside playbookAddendum so the LLM sees
    // a fresh "FRIEND SLANG" directive each turn. Rollback via
    // PA_SLANG_INJECTOR_DISABLED=true.
    // -------------------------------------------------------------------
    let slangDirective: string | null = null
    {
      try {
        const slangDecision = buildSlangInjection({
          userMessage: event.body,
          seed: turnId,
        })
        slangDirective = slangDecision.directive
        if (slangDirective) {
          store.log("pa.voice.slang_injector.applied", {
            userId: event.userId,
            turnId,
            picked: slangDecision.picked,
            lang: slangDecision.lang,
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        store.log("pa.voice.slang_injector.error", {
          userId: event.userId,
          turnId,
          error: msg,
        })
      }
    }
    // -------------------------------------------------------------------
    // Adam iter 19 — academic-integrity directive injection. Stream-E P0
    // (2026-05-02) shipped detection bank but never wired the directive
    // into the orchestrator. WARN-only — when a leetcode-cheating probe
    // hits, we append a bilingual directive that asks Claire to redirect
    // to study approach. Never blocks the LLM call.
    //
    // Telemetry: pa.voice.academic_integrity.matched. signals[] carry
    // pattern ids (NEVER raw user text — privacy contract).
    // -------------------------------------------------------------------
    let academicIntegrityDirective: string | null = null
    {
      try {
        const aiResult = checkAcademicIntegrity(event.body)
        if (aiResult.matched) {
          academicIntegrityDirective = aiResult.suggestedDirective || null
          store.log("pa.voice.academic_integrity.matched", {
            userId: event.userId,
            turnId,
            verdict: aiResult.verdict,
            signals: aiResult.signals,
            language: aiResult.language,
            inputHash: aiResult.inputHash,
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        store.log("pa.voice.academic_integrity.error", {
          userId: event.userId,
          turnId,
          error: msg,
        })
      }
    }
    // iter34 hotfix 2026-05-05 — Adam directive: "匹配挂了" hallucination
    // bug. LLM saw context where matching pipeline returned no recs and
    // narrated "我这边刚才拉匹配挂了". Forbidden: NEVER expose internal
    // system failures. Friend-tone alternative: "让我再帮你找找看" /
    // "still pulling fresh matches".
    const matchingPrivacyDirective =
      "[NEVER expose internal system status to the user] " +
      "Never tell the user that matching/job-rec/pipeline/system/database/API " +
      "failed, errored, broke, crashed, was down, hung, or '挂了/坏了/出错了/失败了'. " +
      "If matches aren't ready or recs are empty, say something natural like " +
      "'让我再帮你找找看' / '我多看几条更准的再发你' / 'still pulling fresher matches' / " +
      "'lemme dig up a couple more before sending'. Apologize like a friend would " +
      "('稍等下哈'), never like a system status page."
    const jobRecommendationExplanationDirective =
      await buildJobRecommendationExplanationDirective(store, event)
    const systemInputs: string[] = [
      personaCard,
      recallEntry,
      voiceReminder,
      playbookAddendum,
      slangDirective,
      academicIntegrityDirective,
      matchingPrivacyDirective,
      jobRecommendationExplanationDirective,
      mirror.snippet,
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    // Phase 10.5 T7 — bridge agent.allowedConnectors → SDK tools. When the
    // default agent's toolPolicy is still "none" (pre-T8), this returns []
    // and the SDK gets no custom tools, matching legacy behavior.
    let turnTools = await store.buildTurnTools(agent, { turnId, userId: event.userId, sessionId: event.sessionId })
    turnTools = filterTurnToolsForSkillAllowlist(turnTools, playbookRouting)
    // Phase 29 T4 — Bible-as-data v2 (pa-handbooks/{slug} + immutable
    // versions/{v}). When the orchestrator was wired with a Firestore
    // handle, resolve the handbook slug from agent.handbookSlug (default
    // "claire") and compose the runtime systemPrompt. Falls back through
    // a 3-tier chain so live traffic NEVER goes promptless during cutover:
    //   1. pa-handbooks/{slug} v2 schema (this phase)        ← preferred
    //   2. legacy pa-handbook-sections (handbookEnabled=true) ← prior iter
    //   3. agent.systemPrompt inline string                   ← original
    // Empty composed output OR load error logs once + falls through. The
    // failsafe inline systemPrompt is retained for one phase per PLAN T4
    // DON'T; cleanup phase removes it after migration confidence builds.
    let composedSystemPrompt: string | null = null
    if (store.db != null) {
      const slug = (agent as { handbookSlug?: string }).handbookSlug ?? DEFAULT_HANDBOOK_SLUG
      try {
        const handbook = await loadHandbookV2(store.db, slug)
        if (handbook) {
          const composed = composeHandbookV2SystemPrompt(handbook).trim()
          if (composed.length > 0) {
            composedSystemPrompt = composed
          } else {
            store.log("pa.handbook.v2_empty_fallback", {
              agentId: agent.id,
              slug,
              version: handbook.version,
            })
          }
        } else {
          store.log("pa.handbook.v2_missing_fallback", {
            agentId: agent.id,
            slug,
          })
        }
      } catch (e) {
        store.log("pa.handbook.v2_load_failed_fallback", {
          agentId: agent.id,
          slug,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    // Tier 2 fallback — legacy flat-section schema (only when v2 didn't
    // resolve AND legacy is explicitly enabled on the agent doc).
    if (
      composedSystemPrompt === null &&
      (agent as { handbookEnabled?: boolean }).handbookEnabled === true &&
      store.db != null
    ) {
      try {
        const sections = await loadLegacyHandbookSections(store.db)
        const composed = composeLegacyHandbookSystemPrompt(sections).trim()
        if (composed.length > 0) {
          composedSystemPrompt = composed
        } else {
          store.log("pa.handbook.legacy_empty_fallback_inline", { agentId: agent.id })
        }
      } catch (e) {
        store.log("pa.handbook.legacy_load_failed_fallback_inline", {
          agentId: agent.id,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    // Stream D — append User CV Profile block when this user has a parsed
    // resume on file. Best-effort: errors degrade silently and leave the
    // composed prompt unchanged. The V0 emergency rollback path
    // (isVoiceV1Disabled) intentionally bypasses CV injection — it is a
    // pre-handbook static string and CV grounding belongs to the live voice.
    if (composedSystemPrompt !== null && store.db != null) {
      composedSystemPrompt = await appendCvContextToSystemPrompt(
        store.db,
        event.userId,
        composedSystemPrompt,
        (evt, payload) => store.log(evt, payload as Record<string, unknown>)
      )
    }
    // v1.5 / Phase 53.5 — JOB MARKET CONTEXT harness prompt (Adam 2026-05-02
    // spec: harness Claire on the actual 2026 keyword set for AI agent / PM /
    // SWE so she stops confirming "single Python = match"). Pure / synchronous;
    // fires only when the current user message explicitly names a target role.
    // No-op for casual chat — system prompt unchanged. NEVER throws (defensive).
    if (composedSystemPrompt !== null) {
      try {
        const harnessLang: "zh" | "en" = detectUserLang(event.body) === "en" ? "en" : "zh"
        const detectedRole = detectJobMarketRole(event.body)
        const before = composedSystemPrompt
        composedSystemPrompt = appendJobMarketKnowledgeToSystemPrompt(
          composedSystemPrompt,
          { userMessage: event.body, lang: harnessLang }
        )
        if (composedSystemPrompt !== before) {
          store.log("pa.job_market_knowledge.applied", {
            userId: event.userId,
            turnId,
            role: detectedRole,
            lang: harnessLang,
          })
        }
      } catch (err) {
        store.log("pa.job_market_knowledge.failed", {
          userId: event.userId,
          turnId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // v1.5 hotfix — pre-generation language lock. Detect user input language
    // (zh|en) from event.body and SANDWICH the directive (top + bottom of
    // system prompt) so Qwen-7B's weak instruction-following can't lose it
    // in the ~10k-char Bible/handbook tail. v1 single-prepend + Qwen-7B was
    // observed Turn-1 EN→ZH leaking on en_grad sim (2026-05-02). Recency
    // bias from the trailing copy is what actually clamps the model.
    //
    // Phase 53 Bug 2 + Adam 2026-05-03 01:22 amendment: detectUserLang now
    // returns 3 classes (zh/en/mixed). buildLangLockSandwich and
    // buildLangLockUserDirective return empty strings for "mixed", and
    // runLangLockGuard short-circuits — letting the reply mirror the user's
    // zh-frame + en-token register naturally instead of hard-locking single
    // language. Pure-zh / pure-en still get the lock as before.
    // 2026-05-07 Bug B fix v2 — Adam: "应该用统一的语音". Per CLAUDE.md D8
    // tags is the single canonical source. Read tags.preferredLang FIRST
    // (set by writeOnboardingTags after q_lang answered + by cv-ingest after
    // mergeUserTags), statedPreferences.preferredLang SECOND (legacy mirror,
    // also written by applyOnboardingStep). detectUserLang(event.body) is
    // ONLY used as last-resort when user hasn't declared preference yet —
    // never as the override path. This also unifies with onboarding-
    // deterministic.langFor() which already prioritizes prefLang.
    // `getOnboardingUser` may legitimately return null (tests + rare store
    // seams). Optional-chain — do not dereference `null` (throws before LLM).
    const tagsPref = onboardingUser?.tags?.preferredLang
    const onboardingPref = onboardingUser?.statedPreferences?.preferredLang
    const declaredPref = tagsPref || onboardingPref
    let userLang: "zh" | "en" | "mixed"
    if (declaredPref === "en" || declaredPref === "zh" || declaredPref === "mixed") {
      userLang = declaredPref
    } else {
      userLang = detectUserLang(event.body)
    }
    const { open: langLockOpen, close: langLockClose } = buildLangLockSandwich(userLang)
    const baseSystemPrompt = isVoiceV1Disabled()
      ? LEGACY_V0_SYSTEM_PROMPT
      : composedSystemPrompt ?? agent.systemPrompt
    const systemPrompt = `${langLockOpen}\n\n${baseSystemPrompt}${langLockClose}`
    // Phase 24 T1B — few-shot relocation. Prepend 12 mes_examples as
    // messages-array alternating turns (~3x style transfer vs system-block).
    // Synthetic fs_* ids MUST be filtered before any Firestore write
    // (see persistence-layer filter; Pitfall 4 in 24-RESEARCH.md).
    // historyForModel is MODEL INPUT ONLY — `history` remains the
    // source-of-truth for persistence paths (no fs_* rows in pa_messages).
    // v1.5 long-context humanize control (Adam 2026-05-02 spec) — sliding
    // window truncation BEFORE few-shot prefixing. Qwen-7B advertises 32k
    // context but effective attention degrades past ~6k input tokens; long
    // sessions caused repeated tokens, hallucinated literal-prompt copies,
    // and Bible v7.5 NEVER-rule drift as the system prompt was pushed out of
    // the attention window. We cap model-input history at ~1500 estimated
    // tokens, always preserving the last 8 turns (most recent context the
    // user is replying to). The raw `history` variable is unchanged so
    // mirror analyzer + persistence still see full context.
    const historyTrunc = truncateHistoryByTokens(history)
    const truncatedHistory = historyTrunc.kept
    if (historyTrunc.truncated || historyTrunc.originalTokens >= TELEMETRY_THRESHOLD_TOKENS) {
      store.log("pa.voice.context_window_truncated", {
        userId: event.userId,
        turnId,
        originalTurns: history.length,
        keptTurns: truncatedHistory.length,
        droppedTurns: historyTrunc.droppedCount,
        originalTokenEst: historyTrunc.originalTokens,
        keptTokenEst: historyTrunc.keptTokens,
        warningOverThreshold: historyTrunc.originalTokens >= TELEMETRY_THRESHOLD_TOKENS,
      })
    }
    const fewShotTurns = buildFewShotTurns(agent)
    const historyForModel = fewShotTurns.length > 0
      ? prefixFewShotToHistory(fewShotTurns, truncatedHistory)
      : truncatedHistory
    // v1.5 hotfix v3 — append lang-lock directive to user message itself.
    // System-prompt sandwich (v2) was insufficient because few-shot examples
    // in agent doc are ZH-heavy and bias turn-1 generation. Injecting at the
    // end of userMessage means the LLM reads the directive immediately
    // before generating its reply — strongest possible recency.
    const userMessageWithLangLock = `${event.body}${buildLangLockUserDirective(userLang)}`
    const { text, usage } = await store.runAgentTurn({
      agent,
      systemPrompt,
      // Default Agents SDK path consumes \`session\` + \`systemInputs\` +
      // \`tools\`. The legacy \`history\` + \`memoryBlock\` fields are only
      // consumed by the chat.completions emergency rollback
      // (PA_AGENT_RUNTIME=chat_completions); pass them through so that path
      // keeps working.
      memoryBlock,
      history: historyForModel,
      userMessage: userMessageWithLangLock,
      session,
      systemInputs,
      tools: turnTools,
    })
    // Defense-in-depth: even if the model echoes a [ISO] prefix, strip it
    // before persisting + sending. Root cause is upstream in
    // `toOpenAIMessages` (was prefixing history bodies); this catches stragglers.
    let reply = stripLeadingIsoTimestamp(text.trim()) || "我暂时没有生成有效回复，请稍后再试。"
    // v1.5 hotfix v4 — post-gen language correction. Pre-gen directives (v1
    // prepend, v2 sandwich, v3 user-message inject) all leaked: agent's
    // systemPrompt has heavy ZH examples in NEVER rules that prime Qwen-7B
    // toward Chinese even when user wrote English. If reply language
    // mismatches user input language, run a fast Qwen translate. Fail-open
    // on timeout/error — original reply still ships.
    //
    // Phase 53 Bug 2 fix: extracted to runLangLockGuard helper so the
    // onboarding cold-start branch can share the same scaffold. callSite
    // tags telemetry for cold-start vs main-path dashboarding.
    {
      const guarded = await runLangLockGuard({
        store,
        userId: event.userId,
        turnId,
        userLang,
        reply,
        callSite: "main",
      })
      reply = guarded.reply
    }
    // Phase 24 T1D — telemetry-only coach-token monitor. Pure observation.
    // Hits feed Phase 25 self-evolve dataset. NO transform on `reply`.
    tapCoachTokens(
      reply,
      { turnId, userId: event.userId, replyLength: reply.length },
      (evt, payload) => store.log(evt as string, payload as Record<string, unknown>)
    )
    // Phase 21 Track 4 — small-LLM normalizer. Catches off-voice patterns
    // (A/B framework, pop-therapy, invented categories, productivity probes)
    // that slipped past Bible v5 + few-shot. Fail-open; rollback via
    // PA_LLM_REWRITE_DISABLED=true. Telemetry sinks into pa_turns.usage
    // alongside token counts (rewriteApplied + rewriteReason).
    // Phase 33 — pass last 2 assistant replies as context so rewriter can
    // detect + fix opener repetition (嗯/哎/草) across turns.
    const priorAssistantReplies = (history ?? [])
      .filter((m) => m.role === "assistant")
      .slice(-2)
      .reverse()
      .map((m) => m.body)
    // Phase 35-40 wire-in — wider Claire history (last 5) for F1/F4 detectors
    // + Firestore handle + ids for umbrella-flag-gated module activations.
    // All optional in RewriteContext; modules skip silently when missing.
    const claireHistoryForDetectors = (history ?? [])
      .filter((m) => m.role === "assistant")
      .slice(-5)
      .reverse()
      .map((m) => m.body)
    const rewritten = await rewriteIfOff(
      reply,
      {},
      {
        priorAssistantReplies,
        db: store.db,
        userId: event.userId,
        turnId,
        claireHistoryForDetectors,
        lastUserMessage: event.body,
      }
    )
    // Phase 33 — unconditional telemetry. Without this we can't tell if the
    // rewriter is firing as no_change, timing out, or blocked by diff-guard.
    store.log("pa.voice.llm_rewriter.result", {
      userId: event.userId,
      turnId,
      applied: rewritten.rewriteApplied,
      reason: rewritten.reason,
      circuitOpen: rewritten.circuitOpen ?? false,
      beforeLen: reply.length,
      afterLen: rewritten.text.length,
    })
    // Phase 33b — deterministic opener strip, applied unconditionally so that
    // rewrite_unsafe / circuit_open / timeout fallbacks still get de-tic'd.
    // Phase 33e — also strip 我懂/我懂那种 validation tic (Qwen ignores DROP rule).
    const afterOpenerStrip =
      priorAssistantReplies.length > 0
        ? stripRepeatOpener(rewritten.text, priorAssistantReplies)
        : rewritten.text
    let stripped = stripValidationTic(afterOpenerStrip)
    // -------------------------------------------------------------------
    // Adam iter 20 — phrase-repeat stripper (Claire self-mirror).
    //
    // iter-19 10-turn anxious_grad sim showed 5 consecutive replies
    // opening with "要不要试 / 要不要试试". stripRepeatOpener catches
    // identical first-clause-before-terminator only and only checks
    // last-2; F1 verb-mirror checks user→Claire not Claire→Claire.
    //
    // This module fills the gap: 4+ char substring match in first 30
    // chars of current vs anywhere in last-5 prior Claire replies.
    // Bilingual, sub-1ms, deterministic.
    //
    // Wider window (last-5) than stripRepeatOpener intentionally — the
    // failure mode is a tic that persists across MANY turns, not just
    // back-to-back.
    // -------------------------------------------------------------------
    {
      const widerPriors = (history ?? [])
        .filter((m) => m.role === "assistant")
        .slice(-5)
        .reverse()
        .map((m) => m.body)
      const phraseStrip = stripPhraseRepeat(stripped, widerPriors)
      if (phraseStrip.stripped) {
        store.log("pa.voice.phrase_repeat_strip.applied", {
          userId: event.userId,
          turnId,
          matched_phrase: phraseStrip.matched_phrase,
          matched_in_priors: phraseStrip.matched_in_priors,
          beforeLen: stripped.length,
          afterLen: phraseStrip.text.length,
        })
        stripped = phraseStrip.text
      }
    }
    // Stream H5 — runtime A/B probe tail strip (Bible v7.5 NEVER PROBE rule
    // mirrored from voice-axes.mjs checkABFramework). Gated by the same
    // paHumanizeRuntimeEnabled umbrella as the imperfection injector below
    // so non-allowlist users see no behavior change. Strips ONLY the trailing
    // clause that contains an A/B probe; preserves earlier clauses verbatim.
    try {
      const humanizeOnAB = await isHumanizeRuntimeEnabled(store.db, event.userId)
      if (humanizeOnAB && process.env.PA_AB_PROBE_STRIP_ENABLED !== "false") {
        const abResult = stripABProbeFromTail(stripped)
        if (abResult.hits.length > 0) {
          // V2 QA Agent-B 2026-05-04 P0-3: when the entire reply IS the
          // AB span (no clean stem-terminator before the AB framework),
          // stripABProbeFromTail returns stripped="" — replacing Claire's
          // whole reply with empty string. Fall back to a friend-tone
          // holding ack so the user sees a non-empty response, and the
          // next turn lets the LLM produce a non-AB reply.
          const MIN_KEEP = 4
          const trimmed = abResult.stripped.trim()
          // pick lang via input message's CJK majority — same heuristic
          // as onboarding pickLang. Inline simple check to avoid coupling.
          const isZh = /[一-鿿]/.test(event.body ?? "")
          const fallback = isZh ? "嗯，我在听。" : "yeah, i'm here."
          const safeStripped = trimmed.length >= MIN_KEEP ? abResult.stripped : fallback
          store.log("pa.voice.ab_probe_strip.applied", {
            userId: event.userId,
            turnId,
            patterns: abResult.hits,
            beforeLen: stripped.length,
            afterLen: safeStripped.length,
            usedFallback: safeStripped !== abResult.stripped,
          })
          stripped = safeStripped
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      store.log("pa.voice.ab_probe_strip.error", {
        userId: event.userId,
        turnId,
        error: msg,
      })
    }
    // Phase 53 (v1.6 voice-quality closure) — conditional A/B framework
    // head strip ("如果你想 X，那可以 Y" / "If you want X, you could Y").
    // Distinct from the X-or-Y tail probe stripped above. Conservative:
    // only removes the if-clause head, preserves the then-clause verbatim.
    // Gated by paHumanizeRuntimeEnabled umbrella + paABFrameworkStrippingEnabled.
    // Defaults ON; env disable via PA_AB_FRAMEWORK_STRIP_DISABLED=true.
    try {
      const humanizeOnAB2 = await isHumanizeRuntimeEnabled(store.db, event.userId)
      const flagEnabled = process.env.PA_AB_FRAMEWORK_STRIP_DISABLED !== "true"
      if (humanizeOnAB2 && flagEnabled) {
        const abFwResult = stripABFramework(stripped)
        if (abFwResult.applied) {
          store.log("pa.voice.ab_framework_strip.applied", {
            userId: event.userId,
            turnId,
            pattern: abFwResult.pattern ?? null,
            beforeLen: stripped.length,
            afterLen: abFwResult.text.length,
          })
          stripped = abFwResult.text
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      store.log("pa.voice.ab_framework_strip.error", {
        userId: event.userId,
        turnId,
        error: msg,
      })
    }
    // iter30 Wave 3 — am_i_ai flat-deny post-gen re-roll. Runs BEFORE
    // imperfection injector so any injected typos go on top of the
    // deflection text (not the lie). Gated by paHumanizeRuntimeEnabled
    // umbrella + env kill switch PA_AM_I_AI_REROLL_DISABLED=true.
    // Idempotent (substitute strings don't match deny patterns).
    try {
      const humanizeOnAmIAi = await isHumanizeRuntimeEnabled(store.db, event.userId)
      if (humanizeOnAmIAi && process.env.PA_AM_I_AI_REROLL_DISABLED !== "true") {
        const deflected = deflectAmIAiFlatDeny(stripped)
        if (deflected.applied) {
          store.log("pa.voice.am_i_ai_deflect.applied", {
            userId: event.userId,
            turnId,
            matched_pattern: deflected.matched_pattern,
            lang: deflected.lang,
            beforeLen: stripped.length,
            afterLen: deflected.text.length,
          })
          stripped = deflected.text
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      store.log("pa.voice.am_i_ai_deflect.error", {
        userId: event.userId,
        turnId,
        error: msg,
      })
    }
    // Phase 36 wire-in — ImperfectionInjector applied to FINAL visible text
    // post-strip. Gated by paHumanizeRuntimeEnabled umbrella + arm-resolver
    // (PA_IMPERFECTION_ARM env or userId-hash bucket). Default arm = "off"
    // → no-op. Sub-flag PA_IMPERFECTION_INJECTOR_ENABLED=false bypasses
    // entirely. < 5ms p95 latency.
    let replyAfterRewrite = stripped
    let injectorAppliedFlag = false
    let injectorArm: "off" | "low" | "high" = "off"
    try {
      const humanizeOn = await isHumanizeRuntimeEnabled(store.db, event.userId)
      if (humanizeOn && process.env.PA_IMPERFECTION_INJECTOR_ENABLED !== "false") {
        injectorArm = resolveArm(event.userId ?? "")
        if (injectorArm !== "off") {
          const injResult = injectImperfection({
            text: stripped,
            arm: injectorArm,
            userId: event.userId,
            prevAssistantReply: priorAssistantReplies[0],
          })
          replyAfterRewrite = injResult.injected
          injectorAppliedFlag = injResult.applied
          if (injResult.applied) {
            store.log("pa.voice.imperfection_injector.applied", {
              userId: event.userId,
              turnId,
              arm: injResult.arm,
              type: injResult.injection_type,
              position: injResult.position,
              beforeLen: stripped.length,
              afterLen: injResult.injected.length,
            })
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      store.log("pa.voice.imperfection_injector.error", {
        userId: event.userId,
        turnId,
        error: msg,
      })
      replyAfterRewrite = stripped
    }
    void injectorAppliedFlag
    void injectorArm
    // Phase 53 (v1.6 voice-quality closure) — mixed-register mirror append.
    // ITER 16 DISABLED BY DEFAULT: Adam feedback "(re: swe)" appendix feels
    // artificial. We rely on lang-mixed bypass + LLM having seen user input
    // for natural mirror. Re-enable via env if A/B test shows value:
    // PA_MIXED_REGISTER_MIRROR_FORCE=true.
    try {
      const humanizeOnMix = await isHumanizeRuntimeEnabled(store.db, event.userId)
      const mixFlagEnabled = process.env.PA_MIXED_REGISTER_MIRROR_FORCE === "true"
      if (humanizeOnMix && mixFlagEnabled) {
        const mixResult = applyMixedRegisterMirror(event.body ?? "", replyAfterRewrite)
        if (mixResult.applied) {
          store.log("pa.voice.mixed_register_mirror.applied", {
            userId: event.userId,
            turnId,
            appended: mixResult.appended ?? null,
            beforeLen: replyAfterRewrite.length,
            afterLen: mixResult.text.length,
          })
          replyAfterRewrite = mixResult.text
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      store.log("pa.voice.mixed_register_mirror.error", {
        userId: event.userId,
        turnId,
        error: msg,
      })
    }
    // Phase 35/38 wire-in (LIFTED) — detectors + trackAdvice run on the FINAL
    // visible text regardless of `rewriteIfOff` outcome. Previously these
    // were gated behind the rewriter happy-path inside `rewriteIfOff` and
    // never fired on no_change / rewrite_unsafe / timeout exits, which is
    // why pa-advice-tracker stayed empty post-deploy-00023 even with the
    // umbrella flag ON for allowlisted users.
    try {
      const humanizeOnPost = await isHumanizeRuntimeEnabled(store.db, event.userId)
      if (humanizeOnPost) {
        if (process.env.PA_DETECTORS_ENABLED !== "false") {
          try {
            const detectorCtx: DetectorContext = {
              turn: { user: event.body, assistant: replyAfterRewrite },
              history: { claireReplies: claireHistoryForDetectors },
            }
            const detectorResults = await runAllDetectors(detectorCtx)
            const triggered = detectorResults.filter((r) => r.triggered)
            if (triggered.length > 0) {
              store.log("pa.voice.detectors.triggered", {
                userId: event.userId,
                turnId,
                detectors: triggered.map((r) => ({
                  id: r.id,
                  action: r.suggested_action ?? null,
                })),
              })
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            store.log("pa.voice.detectors.error", { userId: event.userId, turnId, error: msg })
          }
        }
        if (
          process.env.PA_MEMORY_POLICY_ENABLED !== "false" &&
          store.db &&
          event.userId &&
          turnId
        ) {
          void trackAdvice(
            event.userId,
            replyAfterRewrite,
            turnId,
            { db: store.db }
          ).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err)
            store.log("pa.voice.advice_tracker.error", { userId: event.userId, turnId, error: msg })
          })
        }
        // ---------------------------------------------------------------
        // Adam iter 19 — real-time tag write-back. Fire-and-forget on the
        // user message (NOT the reply) so pa_users.statedPreferences stays
        // current. Match pipeline reads statedPreferences on next 09:00 PT
        // batch; up-to-date tags = better job recs.
        //
        // Pure regex, sub-1ms; never blocks the user-facing reply path.
        // Rollback: PA_REALTIME_TAGGER_DISABLED=true.
        // ---------------------------------------------------------------
        if (store.db && event.userId) {
          void applyRealtimeTagWriteback(
            store.db,
            event.userId,
            event.body,
            (evt, payload) => store.log(evt, payload)
          ).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err)
            store.log("pa.realtime_tagger.error", {
              userId: event.userId,
              turnId,
              error: msg,
            })
          })
        }

        // ---------------------------------------------------------------
        // 2026-05-18 — chat → tag + memory extractor. Fire-and-forget on
        // post-turn so chat-volunteered preferences (e.g. "I want fintech",
        // "I'm flexible on LA") mirror into pa-users.tags + Qdrant
        // pa_memory_entities. Match engine reads tags; extractor closes
        // the post-onboarding feedback gap audited 2026-05-18.
        //
        // Skip when onboardingState !== "complete" (deterministic q_*
        // path owns those answers) OR active prescreen (Claire is screening,
        // not chatting).
        //
        // Feature flag: PA_CHAT_EXTRACTOR_ENABLED=true. Default off; the
        // trigger evaluator still logs decisions but the LLM call is
        // short-circuited until the rollout is opt-in.
        // ---------------------------------------------------------------
        {
          const extractorDb = store.db
          if (extractorDb && event.userId && onboardingUser?.onboardingState === "complete") {
            void (async () => {
              try {
                const existingTags =
                  (onboardingUser as unknown as { tags?: Record<string, unknown> }).tags ?? {}
                const recentMessages: ConversationExtractMessage[] = [
                  ...claireHistoryForDetectors.slice(-9).map(
                    (text): ConversationExtractMessage => ({
                      role: "assistant",
                      body: text,
                      createdAt: store.nowIso(),
                    }),
                  ),
                  {
                    role: "user",
                    body: event.body,
                    createdAt: event.createdAt ?? store.nowIso(),
                  },
                ]
                await maybeRunExtractor({
                  db: extractorDb,
                  userId: event.userId,
                  recentMessages,
                  existingTags,
                  onboardingState: onboardingUser.onboardingState ?? null,
                  activePrescreenSessionId: null,
                  userMsgsThisBatch: 1,
                  log: (evt, payload) => store.log(evt, payload),
                })
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                store.log("pa.conversation_extractor.dispatch_error", {
                  userId: event.userId,
                  turnId,
                  error: msg,
                })
              }
            })()
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      store.log("pa.voice.wire_in_post_hooks.error", {
        userId: event.userId,
        turnId,
        error: msg,
      })
    }
    if (rewritten.rewriteApplied) {
      store.log("pa.voice.llm_rewriter.applied", {
        userId: event.userId,
        turnId,
        reason: rewritten.reason,
        beforeLen: reply.length,
        afterLen: replyAfterRewrite.length,
      })
    }
    // -------------------------------------------------------------------
    // Bug 7 fix (2026-05-03) — POST-REWRITE lang-lock translate guard.
    //
    // RCA: production log evidence (SYNTHETIC_SIM_en_grad turn b56746f2,
    // 2026-05-03T05:40:21Z) — `pa.voice.detectors.triggered` fired with
    // `f3_lang_lock action=regenerate` BUT no `lang_translate.applied`
    // event for the same turn. The first lang-lock guard at ~line 1271
    // ran BEFORE `rewriteIfOff` (~line 1308); the rewriter, whose system
    // prompt contains ZH-heavy FAILURE EXAMPLEs (see llm-rewriter.ts
    // REWRITER_V2_SYSTEM_PROMPT), then rewrote the EN draft into ZH and
    // shipped it. The pure-EN user got a ZH reply.
    //
    // The Adam 02:00 zh-direction path (en draft → zh translate, ZH user)
    // works via the first guard because the LLM's raw output is EN-leaked
    // and gets translated to ZH before rewriter runs. The reverse path
    // (rewriter introduces ZH for EN user) needed a SECOND guard AFTER
    // rewriter + injector + mixed-mirror.
    //
    // Defense-in-depth: this is a no-op when reply lang already matches
    // userLang ("already_correct_lang"). For mixed-register users
    // (`detectUserLang === "mixed"`), guard short-circuits via
    // `mixed_register_bypass` so the model's natural code-switched reply
    // ships verbatim. Fail-open on Qwen translate timeout / error /
    // missing API key — the (possibly wrong-lang) reply still ships.
    //
    // Placement: AFTER `rewriteIfOff` + opener-strip + injector +
    // ab-probe-strip + mixed-register-mirror; BEFORE crisis-hotline guard
    // so the hotline trailer (lang-aware via `guardCrisisHotline`) sees
    // the corrected reply lang and appends the matching trailer.
    // -------------------------------------------------------------------
    {
      const postRewriteGuarded = await runLangLockGuard({
        store,
        userId: event.userId,
        turnId,
        userLang,
        reply: replyAfterRewrite,
        callSite: "post_rewrite",
      })
      replyAfterRewrite = postRewriteGuarded.reply
    }
    // -------------------------------------------------------------------
    // Phase 51 (v1.5 §3.1) — Crisis-ideation deterministic hotline guard.
    // Phase 53 — extracted to `runCrisisHotlineGuard` helper so the
    // onboarding cold-start branch can call it too (Bug A fix).
    // -------------------------------------------------------------------
    // Bible v7.5 system-prompt directive is the PRIMARY path; this is the
    // deterministic SECOND layer. callSite="main" tags telemetry so we can
    // dashboard cold-start vs main-path injection rates separately.
    let crisisInjected = false
    {
      const guarded = await runCrisisHotlineGuard({
        store,
        event,
        turnId,
        userInput: event.body,
        reply: replyAfterRewrite,
        callSite: "main",
      })
      replyAfterRewrite = guarded.reply
      crisisInjected = guarded.injected === true
    }
    // -------------------------------------------------------------------
    // Adam iter 17 (2026-05-03) — F2 hard-cap enforcement.
    //
    // Spec: "需要缩短一下reply，如果一个reply太长我们可以分好几句话说"
    //
    // Detector at line ~1486 already flags `suggested_action: "strip"` when
    // count > 3 sentences (Bible v7.5 directive), but no caller ever acted
    // on it — replies could overflow indefinitely and just get split into
    // ≤2 bubbles regardless of content size. Adam's iter-17 iMessage tests
    // surfaced this: 4-5 sentence replies stuffed into 2 bubbles.
    //
    // Placement: AFTER all rewrites/strips/guards/injections, BEFORE
    // `normalizeForIMessage` (which produces `visibleReply` consumed by
    // `decideReplySplit`). Cap is read from PA_F2_SENTENCE_CAP env (default
    // 3, matches Bible v7.5). Skipped when the mem0Degraded marker would be
    // appended (the marker is its own forced-single-bubble path).
    //
    // Telemetry: `pa.voice.f2_cap.enforced` for dashboards. Pure text op,
    // <10ms, fail-open (returns input unchanged on empty/short reply).
    // -------------------------------------------------------------------
    // iter23 — bypass both caps when (a) reply is structured (CV plan,
    // multi-step roadmap, numbered list) or (b) crisis trailer was injected
    // (988/741741 must NEVER be stripped). Strip would destroy explicit
    // user-asked or P0-safety content; let prob-split + normalizer multi-
    // bubble handle delivery.
    const replyIsStructured = isStructuredReply(replyAfterRewrite)
    const skipF2Caps =
      replyIsStructured || crisisInjected || jobRecommendationExplanationDirective != null
    if (skipF2Caps) {
      store.log("pa.voice.f2_cap.bypassed", {
        userId: event.userId,
        turnId,
        len: replyAfterRewrite.length,
        reason: crisisInjected
          ? "crisis_injected"
          : jobRecommendationExplanationDirective != null
            ? "job_explanation"
            : "structured_reply",
      })
    }
    if (!skipF2Caps) {
      const cap = stripToSentenceCap(replyAfterRewrite)
      if (cap.stripped) {
        store.log("pa.voice.f2_cap.enforced", {
          userId: event.userId,
          turnId,
          beforeLen: replyAfterRewrite.length,
          afterLen: cap.text.length,
          droppedSentences: cap.dropped ?? 0,
        })
        replyAfterRewrite = cap.text
      }
    }
    // -------------------------------------------------------------------
    // Adam iter 19 — F2 char-cap (run-on monsters).
    //
    // Sentence-cap above caps count, not length. anxious_grad sim showed
    // 130-char single-sentence run-ons slipping through (1 sentence < 3
    // cap, but the sentence itself is a wall). char-cap truncates at the
    // last sentence boundary that still fits PA_F2_CHAR_CAP (default 180).
    // Telemetry: pa.voice.f2_char_cap.enforced for dashboards.
    // -------------------------------------------------------------------
    if (!skipF2Caps) {
      const charCap = stripToCharCap(replyAfterRewrite)
      if (charCap.stripped) {
        store.log("pa.voice.f2_char_cap.enforced", {
          userId: event.userId,
          turnId,
          beforeLen: replyAfterRewrite.length,
          afterLen: charCap.text.length,
          droppedChars: charCap.droppedChars ?? 0,
        })
        replyAfterRewrite = charCap.text
      }
    }
    const rawVisible =
      mem.mem0Degraded && agent.memoryMode !== "firestore_only"
        ? `${replyAfterRewrite}\n\n（长期语义记忆暂时不可用；我仍使用已确认事实和最近对话。）`
        : replyAfterRewrite
    // iter30 WS6 — shadow-mode guardrail chain. We feed `rawVisible` (the
    // post-strip / post-rewrite / post-trailer text) through the locked
    // 7-stage output chain and emit telemetry without mutating the live
    // reply. Live cutover (delete the inline patches at 1623-1976) lands
    // in Wave 3 once shadow-mode parity is confirmed in production
    // telemetry. Disabled by default — env flag `PA_GUARDRAIL_CHAIN_SHADOW=true`
    // turns it on.
    if (process.env.PA_GUARDRAIL_CHAIN_SHADOW === "true") {
      try {
        const shadowCtx = createMockContext({
          userId: event.userId ?? "unknown",
          conversationId: event.sessionId ?? "unknown",
          turnId,
          eventId: event.id ?? "unknown",
          locale: userLang === "zh" ? "zh-CN" : userLang === "en" ? "en-US" : "mixed",
          crisisTripped: crisisInjected, // mirror today's input-detection state
          log: (evt, payload) =>
            store.log(evt, { ...(payload ?? {}), shadow: true }),
        })
        const shadowResult = await runOutputChain({
          guardrails: OUTPUT_GUARDRAIL_CHAIN,
          agentOutput: rawVisible,
          userInput: event.body ?? "",
          ctx: shadowCtx,
        })
        store.log("pa.guardrails.shadow.result", {
          userId: event.userId,
          turnId,
          transformed: shadowResult.transformed,
          beforeLen: rawVisible.length,
          afterLen: shadowResult.text.length,
          delta: rawVisible === shadowResult.text ? "match" : "differ",
          hits: shadowCtx.guardrailHits.map((h) => ({
            name: h.name,
            tripped: h.tripped,
            latencyMs: h.latencyMs,
          })),
          suggestedActions: shadowResult.suggestedActions,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        store.log("pa.guardrails.shadow.error", {
          userId: event.userId,
          turnId,
          error: msg,
        })
      }
    }
    const norm = normalizeForIMessage(rawVisible, { maxLength: 600 })
    let visibleReply = norm.text
    if (jobRecommendationExplanationDirective) {
      visibleReply = normalizeJobExplanationVisibleReply(
        visibleReply,
        event.body,
        extractBestCurrentMatchHintFromDirective(jobRecommendationExplanationDirective)
      )
    }
    if (runtimeEvent && visibleReply.trim() === runtimeNoSendToken) {
      store.log("pa.runtime_event.no_send", {
        userId: event.userId,
        turnId,
        eventId: event.id,
        runtimeEventSource: event.rawMeta?.runtimeEventSource,
        runtimeEventKind: event.rawMeta?.runtimeEventKind,
      })
      await store.updateTurn(turnId, {
        status: "succeeded",
        stage: "succeeded",
        runtimeNoSend: true,
        completedAt: store.nowIso(),
      })
      await store.markEventSucceeded(event.id)
      return
    }
    // Bug 4 (2026-05-03 commit ea59897) shipped a single-send-per-turn
    // invariant after Adam observed 4 inbound msgs → 6 outbound bubbles
    // (norm.chunks length-based splitting). We keep that fix in spirit:
    // norm.chunks remains a TELEMETRY-ONLY signal (`outputChunks` rawMeta
    // surfaces over-length LLM output for dashboards) and is no longer
    // wired to the outbound-parts pipeline.
    // 2026-05-03 humanize spec relaxes that to "≤2 sends per turn":
    // decideReplySplit picks 1 or 2 outbound bubbles per a seeded
    // weighted_random (turnId is the seed → replay-deterministic). Short
    // replies, single-sentence replies, crisis-hotline trailers and
    // mem0Degraded notices all force count=1. See probabilistic-split.ts.
    const splitDecision = jobRecommendationExplanationDirective
      ? {
          count: 1 as const,
          parts: [visibleReply],
          reason: "job_explanation_force_1" as const,
        }
      : decideReplySplit(visibleReply, { seed: turnId })
    const outboundParts = splitDecision.parts
    store.log("pa.voice.reply_split.decided", {
      userId: event.userId,
      turnId,
      eventId: event.id,
      count: splitDecision.count,
      reason: splitDecision.reason,
      replyLen: visibleReply.length,
      ...(splitDecision.splitAtIndex != null
        ? { splitAtIndex: splitDecision.splitAtIndex }
        : {}),
    })
    const llmWasOverLength =
      norm.chunks != null && norm.chunks.length > 1

    await store.appendMessage({
      id: `out-${event.id}`,
      sessionId: event.sessionId,
      userId: event.userId,
      role: "assistant",
      body: visibleReply,
      createdAt: store.nowIso(),
      // Use the SDK-compatible hash on the raw model reply so
      // FirestoreSession.addItems() short-circuits this assistant row on
      // the default path (no double-write). Doc id stays \`out-${event.id}\`
      // for dashboard transcript continuity.
      idempotencyKey: deriveSessionMessageIdempotencyKey(event.sessionId, "assistant", reply),
      rawMeta: {
        source: "pa_orchestrator",
        turnId,
        eventId: event.id,
        outboundIdempotencyKey: `out-${event.id}`,
        ...(llmWasOverLength ? { outputChunks: norm.chunks } : {}),
        ...(norm.droppedTracking.length > 0 ? { droppedUrlParams: norm.droppedTracking } : {}),
      },
    })
    const after = await store.afterAssistantTurn(agent, {
      userId: event.userId,
      mem0UserId: mem0PartitionKey,
      sessionId: event.sessionId,
      userText: event.body,
      assistantText: reply,
      memoryMode: agent.memoryMode,
    })
    // Phase 19 ADAPT-03 — long-term style preference write. Per D-07 the
    // kill switch must ALSO disable mem0/style writes (otherwise rollback
    // bleeds state across sessions). We piggyback on mirror.snapshot:
    // when the kill switch is on, computeMirrorForTurn returns nulls so
    // this block is a no-op. Per-turn drift gate (in writeStylePreference)
    // collapses churn — chosen over a true session-end hook because
    // iMessage has no explicit session boundary, and drift-gating gives
    // the same end-state with simpler wiring (CONTEXT.md "Claude's
    // Discretion" §debounce).
    if (mirror.snapshot) {
      try {
        await writeStylePreference(
          mem0PartitionKey,
          mirror.snapshot,
          store.nowIso()
        )
      } catch (e) {
        store.log("[orchestrator] writeStylePreference failed", {
          turnId,
          userId: event.userId,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    if (!shouldSuppressOutbound(event)) {
      // Adam 2026-05-19 voice polish §3 — unified outbound delivery plan.
      // When `paBehaviorChoreographerEnabled` is ON, run the seeded
      // planner (tapback / leading 👍 SMS / 1-2 text bubbles). When OFF,
      // fall back to the legacy `decideReplySplit`-only loop verbatim.
      // Either path must respect the ≤2-SMS-per-turn invariant.
      const choreoOn = await isBehaviorChoreographerEnabled(store.db, event.userId)
      const tapbackOn = await isReactionTapbackEnabled(store.db, event.userId)
      const inboundMessageHandle = inboundMessageHandleForReaction(event)
      let deliveredViaPlan = false
      if (choreoOn && !runtimeEvent) {
        try {
          const profile = await resolveProfileForUser(
            "friend_general_chat",
            event.userId
          )
          const plan = planOutboundDelivery({
            reply: visibleReply,
            turnId,
            profile,
            inboundBody: event.body ?? null,
            force1: jobRecommendationExplanationDirective != null || crisisInjected,
            hasMessageHandle: Boolean(inboundMessageHandle) && tapbackOn,
          })
          await sendPlannedOutbound(store, event, turnId, plan, {
            sessionId: event.sessionId,
            inboundMessageHandle,
            skipTapback: !tapbackOn,
          })
          deliveredViaPlan = true
        } catch (err) {
          store.log("pa.outbound.delivery_plan.error", {
            severity: "WARN",
            userId: event.userId,
            turnId,
            eventId: event.id,
            error: err instanceof Error ? err.message : String(err),
          })
          // fall through to legacy path below
        }
      }
      if (!deliveredViaPlan) {
        // Legacy decideReplySplit path. ≤2-sends-per-turn invariant —
        // relaxes Bug 4's strict single-send (see decideReplySplit comment
        // block above). Out-of-bounds counts (0, or ≥3) still log an ERROR;
        // the splitter contract guarantees count ∈ {1,2}.
        if (outboundParts.length < 1 || outboundParts.length > 2) {
          store.log("pa.outbound.invariant_violation", {
            severity: "ERROR",
            turnId,
            userId: event.userId,
            eventId: event.id,
            partsLength: outboundParts.length,
          })
        }
        // Per-part idempotency keys: index 0 keeps the historical key
        // shape (`outbound-${event.id}`) so replays of single-part turns
        // dedupe against pre-split pa-outbound docs. Subsequent parts get
        // a `-pN` suffix so each (eventId, partIndex) pair is its own row.
        for (let i = 0; i < outboundParts.length; i++) {
          const part = outboundParts[i]!
          const idempotencyKey =
            i === 0 ? `outbound-${event.id}` : `outbound-${event.id}-p${i + 1}`
          await store.enqueueOutbound(event.userId, event.from, part, {
            sessionId: event.sessionId,
            role: "assistant",
            idempotencyKey,
            ...(runtimeEvent
              ? {
                  rawMeta: {
                    runtimeEvent: true,
                    runtimeEventSource: event.rawMeta?.runtimeEventSource,
                    runtimeEventKind: event.rawMeta?.runtimeEventKind,
                    runtimeEventContext: event.rawMeta?.context ?? {},
                  },
                }
              : {}),
          })
        }
      }
    }
    // Phase 30 T2 — Downstream Eval Connector hook (P9-Connectors).
    // Fire-and-forget: we await with a soft 2s budget so the chat path is
    // never blocked, but the underlying work continues in background. Any
    // failure inside the connector is swallowed (logged in `downstream.ts`).
    // Test paths that omit `store.db` skip the connector entirely.
    if (store.db != null) {
      const work = runDownstreamConnector(
        store.db,
        {
          userId: event.userId,
          conversationId: event.sessionId,
          lastUserTurn: event.body,
          lastAssistantTurn: visibleReply,
        },
        {
          log: (msg, fields) => store.log(`[downstream] ${msg}`, { turnId, ...(fields ?? {}) }),
          // Phase 30 — wire the production nano judge so kind=llm-judge
          // triggers actually evaluate at runtime. Without this, those
          // triggers silently no-op (evaluateTriggers returns no match
          // when llmJudge is undefined). 0 net new LLM calls when
          // `evalConnectorsEnabled=false` (master kill switch short-circuits
          // before any judge runs).
          llmJudge: defaultNlJudge,
        }
      ).catch((e) => {
        store.log("[downstream] runDownstreamConnector threw (should never happen)", {
          turnId,
          error: e instanceof Error ? e.message : String(e),
        })
      })
      await withSoftBudget(work, 2000, undefined)
    }
    // Phase 26 T3 — emit structured cost log (P9-Prod-Ops). Cloud Logging
    // aggregates this via the user-defined metric `pa.spend.daily`
    // (definition: infra/cloud-logging/README.md). The matching emitter
    // helper for non-orchestrator call sites is
    // `apps/functions/src/instrumentation/cost-logger.ts`.
    if (usage) {
      const u = usage as Record<string, unknown>
      store.log("pa.spend.daily", { "pa.metric": "pa.spend.daily", model: String((agent as { modelId?: string }).modelId ?? "unknown"), inputTokens: Number(u.inputTokens ?? 0), outputTokens: Number(u.outputTokens ?? 0), turnId, userId: event.userId })
    }
    // Phase 10.5 T9 — persist token usage on the turn doc. Filter undefined
    // fields (Phase 10 bug #2 pattern) so Firestore never sees a literal
    // undefined value. Synthetic pa_tool_calls rows for hosted web_search
    // calls (deferred audit owed by T7) are emitted via store.recordHostedToolCalls
    // when usage.hostedToolCalls is populated.
    if (usage) {
      const usagePatch: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(usage)) {
        if (v !== undefined) usagePatch[k] = v
      }
      // Phase 21 Track 4 — telemetry for the LLM rewriter pass. Always
      // logged (even when not applied) so we can compute rewrite-rate
      // offline. `rewriteReason` distinguishes timeout/error/no-change/
      // rewritten/disabled — see voice/llm-rewriter.ts RewriteReason.
      usagePatch.rewriteApplied = rewritten.rewriteApplied
      usagePatch.rewriteReason = rewritten.reason
      if (Object.keys(usagePatch).length > 0) {
        await store.updateTurn(turnId, { usage: usagePatch, updatedAt: store.nowIso() })
      }
      if (usage.hostedToolCalls && usage.hostedToolCalls.length > 0) {
        await store.recordHostedToolCalls({
          turnId,
          userId: event.userId,
          sessionId: event.sessionId,
          calls: usage.hostedToolCalls,
        })
      }
    }
    await store.updateTurn(turnId, {
      status: "succeeded",
      stage: "succeeded",
      completedAt: store.nowIso(),
      mem0WritebackRan: after.writebackRan,
      mem0WritebackSkipReason: after.writebackSkipReason,
    })
    await store.markEventSucceeded(event.id)
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    const errorCode = typeof e === "object" && e && "code" in e ? String((e as { code: unknown }).code) : "TURN_FAILED"
    store.log("[orchestrator] turn failed", { turnId, eventId: event.id, userId: event.userId, errorCode, error })
    await store.updateTurn(turnId, {
      status: "failed",
      stage: "failed",
      errorCode,
      error,
      completedAt: store.nowIso(),
    })
    await store.markEventFailed(event.id, errorCode, error)
    await recordRuntimeFailureAlert({ store, event, turnId, errorCode, error })
  }
}

/** Optional injection points for createFirestoreOrchestratorStore. */
export type OrchestratorStoreDeps = {
  /**
   * iter33 P3 — produce a 1-2 sentence CV analysis blurb in the user's
   * preferred language. Wired from apps/functions where SiliconFlow API
   * key + Qwen-7B model handle live. Tests pass a stub (or omit entirely
   * — onboarding still completes via fallback line in dispatcher).
   */
  generateCvAnalysis?: NonNullable<OrchestratorStore["generateCvAnalysis"]>
  /**
   * iter33 P4 — produce a 2-job-rec push message before complete. Wired
   * from apps/functions where the matching pipeline + pa-job-profiles
   * ledger handles live. Tests pass a stub.
   */
  generateJobRecs?: NonNullable<OrchestratorStore["generateJobRecs"]>
  /**
   * iter34 P0.2 — generic LLM-fallback for q_role / q_yoe / q_visa /
   * q_startup_pref / q_location. Wired from apps/functions.
   */
  extractAnswerIntent?: NonNullable<OrchestratorStore["extractAnswerIntent"]>
  /**
   * 2026-05-07 Bug D — was declared in OrchestratorStore but not
   * forwarded through OrchestratorStoreDeps. apps/functions wired the
   * callback locally, but the deps type didn't accept it → TS rejected
   * the field at the function-side return site. Add it here so the deps
   * factory can pass through to createFirestoreOrchestratorStore.
   * Without this, cvParsed always defaulted to false, onboarding stuck
   * at q_resume_asked even after parsedCandidateResumes existed.
   */
  getUserCvParsed?: NonNullable<OrchestratorStore["getUserCvParsed"]>
  startPrescreenForJob?: NonNullable<OrchestratorStore["startPrescreenForJob"]>
  sendReaction?: NonNullable<OrchestratorStore["sendReaction"]>
}

export function createFirestoreOrchestratorStore(
  db: Firestore,
  deps: OrchestratorStoreDeps = {}
): OrchestratorStore {
  // Phase 19 ADAPT-03 — provision the Firestore-backed voice style store
  // at orchestrator boot. Tests that build their own store should call
  // setVoiceStyleStore(createInMemoryVoiceStyleStore()) BEFORE invoking
  // processInboundEvent (or skip mirror-write entirely via the kill switch).
  setVoiceStyleStore(createFirestoreVoiceStyleStore(db))
  const nowIso = () => new Date().toISOString()
  return {
    async markEventRunning(eventId) {
      const now = new Date()
      await db.collection(PA_COLLECTIONS.inboundEvents).doc(eventId).set(
        {
          status: "running",
          startedAt: now.toISOString(),
          updatedAt: now.toISOString(),
          claimedAt: now.toISOString(),
          leaseUntil: new Date(now.getTime() + INBOUND_LEASE_MS).toISOString(),
        },
        { merge: true }
      )
    },
    async markEventSucceeded(eventId) {
      await db.collection(PA_COLLECTIONS.inboundEvents).doc(eventId).set(
        {
          status: "succeeded",
          completedAt: nowIso(),
          updatedAt: nowIso(),
          errorCode: FieldValue.delete(),
          error: FieldValue.delete(),
        },
        { merge: true }
      )
    },
    async markEventFailed(eventId, errorCode, error) {
      await db.collection(PA_COLLECTIONS.inboundEvents).doc(eventId).set(
        { status: "failed", errorCode, error, completedAt: nowIso(), updatedAt: nowIso() },
        { merge: true }
      )
    },
    async createTurn(event) {
      const id = randomUUID()
      await db.collection(PA_COLLECTIONS.turns).doc(id).set({
        id,
        eventId: event.id,
        userId: event.userId,
        sessionId: event.sessionId,
        status: "running",
        stage: "received",
        createdAt: nowIso(),
      })
      return id
    },
    async updateTurn(turnId, patch) {
      await db.collection(PA_COLLECTIONS.turns).doc(turnId).set({ ...patch, updatedAt: nowIso() }, { merge: true })
    },
    async appendMessage(message) {
      const id = message.id ?? randomUUID()
      const idempotencyKey = message.idempotencyKey
      if (idempotencyKey) {
        const existing = await db
          .collection(PA_COLLECTIONS.messages)
          .where("idempotencyKey", "==", idempotencyKey)
          .limit(1)
          .get()
        if (!existing.empty) {
          // Phase 10.5: SDK FirestoreSession.addItems may have already
          // written this row before the orchestrator's appendMessage call
          // (same hash idempotencyKey). Merge orchestrator-owned metadata
          // (rawMeta, idempotencyKey) into the existing row so dashboard /
          // harness consumers can still find it via rawMeta.eventId.
          // Phase 33c: also overwrite body — SDK stored the raw model reply,
          // orchestrator has the Qwen-rewritten body. History reads must see
          // the rewritten text so opener-rotation detection works correctly.
          const docRef = existing.docs[0]!.ref
          const existingBody = existing.docs[0]!.data().body
          const patch: Record<string, unknown> = {}
          if (message.rawMeta !== undefined) patch.rawMeta = message.rawMeta
          if (message.idempotencyKey !== undefined) patch.idempotencyKey = message.idempotencyKey
          if (message.body !== undefined && message.body !== existingBody) patch.body = message.body
          if (Object.keys(patch).length > 0) {
            await docRef.set(patch, { merge: true })
          }
          return
        }
      }
      await db.collection(PA_COLLECTIONS.messages).doc(id).set({ id, ...message })
      await db.collection(PA_COLLECTIONS.sessions).doc(message.sessionId).set(
        { lastMessageAt: message.createdAt },
        { merge: true }
      )
    },
    async getAgentForUser(userId) {
      const u = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
      const activeAgentId = (u.data() as { activeAgentId?: string } | undefined)?.activeAgentId
      return (activeAgentId && (await getAgentById(db, activeAgentId))) || (await getDefaultAgent(db))
    },
    async getMem0UserId(userId) {
      const u = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
      const raw = (u.data() as { mem0UserId?: string | null } | undefined)?.mem0UserId
      if (typeof raw === "string" && raw.trim().length > 0) return raw.trim()
      return undefined
    },
    async loadHistory(sessionId, limit) {
      // Fetch extra to allow dedup — SDK may write a second doc for the same
      // turn (same idempotencyKey, base model body). Prefer pa_orchestrator
      // source (rewritten body) so opener-rotation detection sees correct text.
      const msgs = await loadRecentMessages(db, sessionId, limit * 3)
      const seen = new Map<string, (typeof msgs)[0]>()
      for (const msg of msgs) {
        const key = (msg as Record<string, unknown>).idempotencyKey as string | undefined ?? msg.id
        const existing = seen.get(key)
        if (!existing) {
          seen.set(key, msg)
        } else {
          const isOrch = ((msg as Record<string, unknown>).rawMeta as Record<string, unknown> | undefined)?.source === "pa_orchestrator"
          if (isOrch) seen.set(key, msg)
        }
      }
      return Array.from(seen.values())
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-limit)
    },
    async enqueueOutbound(userId, toE164, body, input) {
      const {
        id: _ignoredId,
        userId: _ignoredUserId,
        toE164: _ignoredToE164,
        body: _ignoredBody,
        status: _ignoredStatus,
        createdAt: _ignoredCreatedAt,
        attempts: _ignoredAttempts,
        runtimeApproved: _ignoredRuntimeApproved,
        runtimeSource: _ignoredRuntimeSource,
        source: _ignoredSource,
        idempotencyKey: requestedIdempotencyKey,
        ...auditableInput
      } = input ?? {}
      const idempotencyKey =
        typeof requestedIdempotencyKey === "string" && requestedIdempotencyKey.trim()
          ? requestedIdempotencyKey.trim()
          : `pa_orchestrator:${userId}:${createHash("sha256").update(`${toE164}|${body}`).digest("hex").slice(0, 32)}`
      const result = await enqueueBrokerOutbound(db, {
        userId,
        toE164,
        body,
        runtimeApproved: true,
        runtimeSource: "pa_orchestrator",
        idempotencyKey,
      })
      if (Object.keys(auditableInput).length > 0) {
        await db.collection(PA_COLLECTIONS.outbound).doc(result.id).set(
          {
            ...auditableInput,
            updatedAt: nowIso(),
          },
          { merge: true },
        )
      }
    },
    async listMemoryFacts(userId) {
      return listConfirmedMemoryFacts(db, userId)
    },
    async createMemoryFact(userId, content) {
      return createConfirmedMemoryFact(db, userId, content, "explicit_user")
    },
    async deleteMemoryFacts(userId, factIds, eventId) {
      await markMemoryFactsDeleted(db, userId, factIds, eventId)
    },
    async recordMemoryAction(input) {
      await defaultRecordMemoryAction(db, input)
    },
    async loadPersonalizationContext(_agent, input, history) {
      return defaultLoadPersonalizationContext(db, input, history)
    },
    async buildTurnTools(agent, turn) {
      const hooks = deps.generateJobRecs
        ? buildMatchConnectorHooks({ db, generateJobRecs: deps.generateJobRecs })
        : undefined
      const allowedConnectors = await resolveAgentAllowedConnectors(
        db,
        turn.userId,
        agent.allowedConnectors
      )
      const agentFiltered = { ...agent, allowedConnectors }
      return buildTurnTools(db, agentFiltered, turn, hooks)
    },
    async recordHostedToolCalls({ turnId, userId, sessionId, calls }) {
      // One synthetic pa_tool_calls row per hosted invocation, mirroring
      // Phase 10's shape: connectorName: "current-info" (the policy
      // identity), connectorVersion: "sdk-hosted" (so the dashboard can
      // distinguish runtime origin), policyDecision: "allow",
      // status: "completed". We filter undefined fields before .set()
      // (Phase 10 bug #2). userId/sessionId are kept on argsRedacted only
      // — pa_tool_calls today does not carry them top-level.
      const at = nowIso()
      for (const call of calls) {
        for (let i = 0; i < call.count; i += 1) {
          const id = randomUUID()
          const connectorName = call.name === "web_search" ? "current-info" : call.name
          const row: Record<string, unknown> = {
            id,
            turnId,
            connectorName,
            toolFamily: resolveToolFamily(connectorName),
            connectorVersion: "sdk-hosted",
            status: "completed",
            argsDigest: "sdk-hosted",
            argsRedacted: { source: "agents_sdk_web_search", userId, sessionId, hostedTool: call.name },
            policyDecision: "allow",
            startedAt: at,
            completedAt: at,
          }
          // Defensive: filter undefined.
          for (const [k, v] of Object.entries(row)) {
            if (v === undefined) delete row[k]
          }
          await db.collection(PA_COLLECTIONS.toolCalls).doc(id).set(row)
        }
      }
    },
    createSession({ sessionId, userId }) {
      return new FirestoreSession({ db, sessionId, userId })
    },
    runAgentTurn: defaultRunAgentTurn,
    async afterAssistantTurn(agent, input) {
      return defaultAfterAssistantTurn(db, agent, input)
    },
    async maybeHandleResetCommand(event) {
      if (!isResetCommand(event.body)) return { handled: false }
      // Two-gate authorization, EITHER passes:
      //   (a) per-user opt-in: pa_users/{id}.testMode === true
      //   (b) deploy-time admin allowlist: PA_ADMIN_USER_IDS env (CSV of UUIDs)
      // Production users never get the magic string — testMode is unset and
      // their UUID is not in the env allowlist.
      const adminUserIds = (process.env.PA_ADMIN_USER_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      const isAdminAllowlisted = adminUserIds.includes(event.userId)
      let isTestUser = false
      if (!isAdminAllowlisted) {
        const userSnap = await db.collection(PA_COLLECTIONS.users).doc(event.userId).get()
        const user = userSnap.exists ? (userSnap.data() as { testMode?: boolean }) : null
        isTestUser = user?.testMode === true
      }
      if (!isAdminAllowlisted && !isTestUser) return { handled: false }

      const qdrantUrl = process.env.QDRANT_URL
      const qdrantApiKey = process.env.QDRANT_API_KEY
      if (!qdrantUrl || !qdrantApiKey) {
        return {
          handled: true,
          summary: "✗ Test memory clear failed: QDRANT_URL/QDRANT_API_KEY not configured",
        }
      }
      try {
        // Auto-promote allowlisted admin to testMode so subsequent runs go
        // through the cheaper testMode branch (skips the env var lookup
        // dependency for ops who later remove the allowlist).
        if (isAdminAllowlisted) {
          await db.collection(PA_COLLECTIONS.users).doc(event.userId).set(
            { testMode: true, updatedAt: nowIso() },
            { merge: true }
          )
        }
        const result = await clearUserMemory(
          event.userId,
          { db, qdrantUrl, qdrantApiKey, qdrantCollection: process.env.QDRANT_COLLECTION },
          { keepMessages: false, dryRun: false }
        )
        return { handled: true, summary: summarizeClearResult(result) }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { handled: true, summary: `✗ Test memory clear failed: ${msg}` }
      }
    },
    async checkInboundSafety(event) {
      // Phase 46 (v1.5 Stream-E) — master flag. When OFF, fall through to the
      // pre-Phase-46 path bytewise (Phase 23 1-min rate-limit + legacy injection)
      // for zero regression. When ON, run the layered runSafetyCheck (which uses
      // the v2 pattern bank + illegal-content + 24h rate-abuse, gated per-layer).
      const masterOn = await getFlag(db, "paSafetyCheckEnabled", { userId: event.userId }, true)

      // Phase 23 1-minute rate-limit ALWAYS runs. Pre-existing protection;
      // Phase 46 only adds the 24h abuse counter on top, never replaces.
      const rl = await enforceRateLimit(db, { userId: event.userId, channel: event.channel })
      if (!rl.allow) {
        await appendAuditEvent(db, {
          kind: "rate_limit",
          message: "Inbound blocked: rate limit",
          userId: event.userId,
          sessionId: event.sessionId,
          inboundEventId: event.id,
          actor: "orchestrator",
        })
        return { allow: false, reason: rl.reason }
      }

      if (masterOn === false) {
        // Master kill-switch: revert to pre-Phase-46 behavior (Phase 23 path).
        const inj = await checkPromptInjectionAndRecord(db, {
          userId: event.userId,
          channel: event.channel,
          text: event.body,
        })
        if (!inj.allow) return { allow: false, reason: inj.reason }
        return { allow: true }
      }

      // Phase 46 layered check. Per-layer canary flags:
      //   - prompt-injection: ON by default (established protection layer)
      //   - illegal-content : OFF by default (canary)
      //   - rate-abuse-24h  : OFF by default (canary)
      const [illegalOn, rate24hOn] = await Promise.all([
        getFlag(db, "paSafetyIllegalContentEnabled", { userId: event.userId }, false),
        getFlag(db, "paSafetyRateAbuse24hEnabled", { userId: event.userId }, false),
      ])
      const verdict = await runSafetyCheck(
        db,
        { userId: event.userId, channel: event.channel, text: event.body },
        {
          promptInjection: true,
          illegalContent: illegalOn === true,
          rateAbuse24h: rate24hOn === true,
        }
      )
      if (verdict.verdict === "pass") {
        // v1.5 §3.8 — OpenAI Moderation runs AFTER the regex layers pass.
        // Severity hierarchy: ESCALATE_NCMEC (critical CSAM) > BLOCK > pass.
        // Fail-open: any moderation runner error short-circuits to allow=true.
        const mod = await runOpenaiModeration({
          store: { db, log: (...args) => console.log(new Date().toISOString(), ...args) },
          event: { userId: event.userId, channel: event.channel, body: event.body, id: event.id },
        })
        if (mod.allow) return { allow: true }
        // BLOCK → escalate canned reply; ESCALATE_NCMEC → silent_drop (no tip-off).
        const isCsam = mod.routedAction === "ESCALATE_NCMEC"
        return {
          allow: false,
          reason: mod.reason ?? (isCsam ? "csam_detected" : "moderation_block"),
          action: isCsam ? "silent_drop" : "escalate",
          severity: "critical",
        }
      }
      return {
        allow: false,
        reason: verdict.layer ?? verdict.reasons[0] ?? "safety_block",
        action: verdict.action,
        severity: verdict.severity,
      }
    },
    nowIso,
    log: (...args) => console.log(new Date().toISOString(), ...args),
    // Phase 24.5 — Firestore handle threaded into store so flag-backed
    // kill-switches (e.g. PA_VOICE_MIRROR_DISABLED) consult pa_feature_flags.
    db,
    // Phase 22 — proactive cancellation (D-07, PROACTIVE-06)
    async cancelAllPendingProactiveJobs(userId) {
      const snap = await db
        .collection(PA_COLLECTIONS.scheduledJobs)
        .where("userId", "==", userId)
        .where("status", "==", "pending")
        .get()
      if (snap.empty) return 0
      const batch = db.batch()
      for (const doc of snap.docs) {
        batch.update(doc.ref, {
          status: "cancelled_by_user",
          updatedAt: nowIso(),
        })
      }
      await batch.commit()
      return snap.size
    },
    async writeProactiveCancelAudit({ userId, sessionId, inboundEventId, cancelledCount }) {
      await appendAuditEvent(db, {
        kind: "proactive_cancel",
        message: `Cancelled ${cancelledCount} pending proactive job(s) via NLU`,
        userId,
        sessionId,
        inboundEventId,
        actor: "orchestrator",
        meta: { cancelledCount },
      })
    },
    async createPrivacyRequest({ userId, kind, detail, eventId, sessionId }) {
      const createdAt = nowIso()
      const request: PrivacyRequest = {
        requestId: createPrivacyRequestId({
          candidateId: userId,
          kind,
          createdAt,
        }),
        kind,
        status: "submitted",
        candidateId: userId,
        sourceSurface: "imessage",
        requestedBy: "candidate",
        detailRedacted: {
          requestKind: kind,
          sourceSurface: "imessage",
          channel: "imessage",
        },
        evidence: [
          {
            source: "conversation",
            summary: `Candidate submitted ${kind} privacy request via iMessage`,
            refId: eventId,
          },
        ],
        createdAt,
      }
      const result = await writePrivacyRequest(db, request)
      await appendAuditEvent(db, {
        kind: "privacy_request",
        message: `Candidate privacy request submitted via iMessage: ${kind}`,
        userId,
        sessionId,
        inboundEventId: eventId,
        actor: "orchestrator",
        meta: {
          requestId: result.request.requestId,
          kind,
          created: result.created,
          existingOpen: result.existingOpen,
        },
      })
      return {
        requestId: result.request.requestId,
        kind: result.request.kind,
        created: result.created,
        existingOpen: result.existingOpen,
      }
    },
    async getRecentLifecycleEventForReply(userId) {
      const userSnap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
      const user = userSnap.data() as {
        lifecycle?: {
          lastLifecycleEventId?: string
          lastTouchAt?: string
          lastTouchType?: string
        }
      } | undefined
      const eventId = user?.lifecycle?.lastLifecycleEventId
      if (!eventId) return null
      const lastTouchAt = user?.lifecycle?.lastTouchAt
      const touchMs = lastTouchAt ? Date.parse(lastTouchAt) : 0
      if (!Number.isFinite(touchMs) || Date.now() - touchMs > LIFECYCLE_REPLY_RECENCY_MS) {
        return null
      }
      const eventSnap = await db.collection(CANDIDATE_LIFECYCLE_EVENT_COLLECTION).doc(eventId).get()
      if (!eventSnap.exists) return null
      const row = eventSnap.data() as {
        eventType?: string
        createdAt?: string
      } | undefined
      const eventType = row?.eventType
      if (
        eventType !== "laid_off_checkin" &&
        eventType !== "match_notification" &&
        eventType !== "profile_freshness_nudge" &&
        eventType !== "status_followup"
      ) {
        return null
      }
      return {
        eventId,
        eventType,
        createdAt: row?.createdAt,
        lastTouchAt,
      }
    },
    async recordLifecycleReply({ userId, sessionId, eventId, eventType, turnId, inboundEventId, occurredAt, update }) {
      const userRef = db.collection(PA_COLLECTIONS.users).doc(userId)
      const snap = await userRef.get()
      const existing = snap.data() as {
        statedPreferences?: Record<string, unknown>
      } | undefined
      const existingPrefs = existing?.statedPreferences && typeof existing.statedPreferences === "object"
        ? existing.statedPreferences
        : {}
      const statedPreferences: Record<string, unknown> = { ...existingPrefs }
      for (const [key, value] of Object.entries(update.statedPreferences)) {
        if (value === undefined) continue
        if (Array.isArray(value) && Array.isArray(existingPrefs[key])) {
          statedPreferences[key] = uniqStrings([...(existingPrefs[key] as string[]), ...value])
        } else {
          statedPreferences[key] = value
        }
      }
      if (Object.keys(update.statedPreferences).length > 0) {
        statedPreferences.updatedAt = occurredAt
      }

      const userPatch: Record<string, unknown> = {
        conversationDerivedPreferences: {
          lifecycleUpdates: {
            [eventType]: {
              eventId,
              turnId,
              inboundEventId,
              source: "imessage_lifecycle_reply",
              summary: update.summary,
              evidence: update.evidence,
              updatedAt: occurredAt,
            },
          },
          updatedAt: occurredAt,
        },
        updatedAt: occurredAt,
      }
      if (Object.keys(update.statedPreferences).length > 0) {
        userPatch.statedPreferences = statedPreferences
      }
      await userRef.set(userPatch, { merge: true })

      if (Object.keys(update.tags).length > 0) {
        await applyPartialUserTags(db, userId, update.tags, {
          source: "chat",
          nowIso: occurredAt,
          log: (event, payload) => console.log(new Date().toISOString(), event, payload ?? {}),
        })
      }

      await db.collection(CANDIDATE_LIFECYCLE_EVENT_COLLECTION).doc(eventId).set(
        {
          status: "candidate_replied",
          reply: {
            turnId,
            inboundEventId,
            sessionId,
            source: "imessage",
            summary: update.summary,
            evidence: update.evidence,
            at: occurredAt,
          },
          updatedAt: occurredAt,
        },
        { merge: true }
      )
      await appendAuditEvent(db, {
        kind: "turn_state",
        message: `Candidate replied to lifecycle ${eventType}`,
        userId,
        sessionId,
        turnId,
        inboundEventId,
        actor: "orchestrator",
        meta: { lifecycleEventId: eventId, lifecycleEventType: eventType, signals: update.evidence.rawSignals },
      })
    },
    // Phase 23 — onboarding state machine
    async getOnboardingUser(userId) {
      const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
      if (!snap.exists) return null
      const data = snap.data() as {
        id?: string
        phoneE164?: string
        onboardingState?:
          | "pending"
          | "first_mes_sent"
          | "grounding_q1_asked"
          | "q_tos_asked"
          | "q_role_asked"
          | "q_yoe_asked"
          | "q_visa_asked"
          | "q_startup_pref_asked"
          | "q_location_asked"
          | "q_resume_asked"
          | "complete"
        statedPreferences?: import("@pa/core-types").StatedPreferences
        runtimeMode?: "auto" | "paused"
        firstName?: string
        displayName?: string
        source?: string
        latestResumeArtifactId?: string
        jobTitle?: string
        lastCompany?: string
        location?: string
        workSession?: Record<string, unknown> | null
        sharedOnboarding?: Record<string, unknown> | null
        candidateContext?: Record<string, unknown> | null
        layoffContext?: Record<string, unknown> | null
      }
      return {
        id: data.id ?? userId,
        phoneE164: data.phoneE164 ?? "",
        onboardingState: data.onboardingState,
        statedPreferences: data.statedPreferences,
        runtimeMode: data.runtimeMode,
        firstName: data.firstName,
        displayName: data.displayName,
        source: data.source,
        latestResumeArtifactId: data.latestResumeArtifactId,
        jobTitle: data.jobTitle,
        lastCompany: data.lastCompany,
        location: data.location,
        workSession: data.workSession,
        sharedOnboarding: data.sharedOnboarding,
        candidateContext: data.candidateContext,
        layoffContext: data.layoffContext,
        pipelineState: (snap.data() as { pipelineState?: unknown } | undefined)?.pipelineState,
      }
    },
    async applyOnboarding(userId, phoneE164, step, opts) {
      // iter31 — read currentState so applyOnboardingStep idempotency check
      // (STATE_ORDER) lines up; previously we passed undefined which forced
      // every call to advance from scratch.
      const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
      const data = snap.exists
        ? (snap.data() as {
            onboardingState?: import("@pa/core-types").OnboardingState
            source?: string | null
            workSession?: Record<string, unknown> | null
          })
        : undefined
      await applyOnboardingStep(
        db,
        {
          id: userId,
          phoneE164,
          onboardingState: data?.onboardingState,
          source: data?.source,
          workSession: data?.workSession,
        },
        step,
        {
          now: opts?.now,
          priorAskedStep: opts?.priorAskedStep,
          priorUserReply: opts?.priorUserReply,
          intentAcked: opts?.intentAcked,
          suspendedForVent: opts?.suspendedForVent,
          tosAcceptedVersion: opts?.tosAcceptedVersion,
          tosDeclined: opts?.tosDeclined,
          intentAckTarget: opts?.intentAckTarget,
          // 2026-05-06 P9 fix — was MISSING from passthrough, silently
          // dropped every Judge-canonical write. Caused the live bug:
          // q_lang accepted "English" but `tags.preferredLang` stayed on
          // prior-session "zh" → bot replied in mixed bilingual. Now
          // forwards so applyOnboardingStep's `parsedAnswer takes precedence
          // over regex parse` branch is reachable from runtime-bridge.
          parsedAnswer: opts?.parsedAnswer,
        }
      )
    },
    async pauseJobRecommendationSubscription(userId, input) {
      const now = input.occurredAt
      await Promise.all([
        db.collection("pa-job-profiles").doc(userId).set(
          {
            userId,
            status: "paused",
            pausedAt: now,
            pausedReason: input.reason,
            pausedByInboundEventId: input.inboundEventId,
            updatedAt: now,
          },
          { merge: true },
        ),
        db.collection(PA_COLLECTIONS.users).doc(userId).set(
          {
            jobRecommendationSubscription: {
              status: "paused",
              pausedAt: now,
              pausedReason: input.reason,
              pausedByInboundEventId: input.inboundEventId,
              updatedAt: now,
            },
            updatedAt: now,
          },
          { merge: true },
        ),
      ])
      return { paused: true }
    },
    async resumeJobRecommendationSubscription(userId, input) {
      const now = input.occurredAt
      await Promise.all([
        db.collection("pa-job-profiles").doc(userId).set(
          {
            userId,
            status: "active",
            resumedAt: now,
            resumedReason: input.reason,
            resumedByInboundEventId: input.inboundEventId,
            updatedAt: now,
          },
          { merge: true },
        ),
        db.collection(PA_COLLECTIONS.users).doc(userId).set(
          {
            jobRecommendationSubscription: {
              status: "active",
              resumedAt: now,
              resumedReason: input.reason,
              resumedByInboundEventId: input.inboundEventId,
              updatedAt: now,
            },
            updatedAt: now,
          },
          { merge: true },
        ),
      ])
      return { resumed: true }
    },
    // iter31 — HITL runtime mode + ToS version helpers.
    async getRuntimeMode(userId) {
      const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
      if (!snap.exists) return "auto"
      const data = snap.data() as { runtimeMode?: "auto" | "paused" } | undefined
      return data?.runtimeMode === "paused" ? "paused" : "auto"
    },
    async getTosVersion() {
      try {
        const snap = await db
          .collection(PA_COLLECTIONS.remoteConfig)
          .doc("platform")
          .get()
        const data = snap.exists ? (snap.data() as { tosVersion?: string }) : undefined
        return data?.tosVersion ?? "v1.0"
      } catch {
        return "v1.0"
      }
    },
    // iter33 P3 — generateCvAnalysis is wired by the apps/functions layer
    // (which has SiliconFlow API key + Qwen-7B model). Tests omit it; the
    // deterministic dispatcher falls back to a generic "skimmed it" line
    // so onboarding still completes when LLM is unconfigured.
    ...(deps.generateCvAnalysis
      ? { generateCvAnalysis: deps.generateCvAnalysis }
      : {}),
    // iter33 P4 — generateJobRecs is wired by the apps/functions layer.
    // Tests omit it; the deterministic dispatcher falls back to a deferred
    // promise so onboarding still completes.
    ...(deps.generateJobRecs
      ? { generateJobRecs: deps.generateJobRecs }
      : {}),
    ...(deps.startPrescreenForJob
      ? { startPrescreenForJob: deps.startPrescreenForJob }
      : {}),
    ...(deps.sendReaction ? { sendReaction: deps.sendReaction } : {}),
    // iter34 P0.2 — generic LLM-fallback for q_role / q_yoe / q_visa /
    // q_startup_pref / q_location. Wired from apps/functions; tests omit
    // and dispatcher falls back to deterministic re-ask.
    ...(deps.extractAnswerIntent
      ? { extractAnswerIntent: deps.extractAnswerIntent }
      : {}),
    // iter32 — CV gate. Reads parsedCandidateResumes (cross-product
    // collection — see CLAUDE.md) for the user; returns true iff a row
    // exists. Defensive fail-OPEN is NOT appropriate here (Adam directive
    // 2026-05-04 #2: stricter). On Firestore error, we fail CLOSED (return
    // false) so the gate holds. cv-ingest pipeline retries are robust;
    // a transient read error shouldn't blow past the gate.
    async getUserCvParsed(userId) {
      try {
        const snap = await db
          .collection("parsedCandidateResumes")
          .where("userId", "==", userId)
          .limit(1)
          .get()
        return !snap.empty
      } catch {
        return false
      }
    },
  }
}

export async function processPendingInboundEvents(db: Firestore, limit = 10): Promise<number> {
  const snap = await db
    .collection(PA_COLLECTIONS.inboundEvents)
    .where("status", "==", "pending")
    .orderBy("createdAt", "asc")
    .limit(limit)
    .get()
  let processed = 0
  for (const doc of snap.docs) {
    processed += await claimAndProcessInboundEvent(db, doc.id)
  }
  return processed
}

export async function claimInboundEvent(db: Firestore, eventId: string, now = new Date()): Promise<InboundEvent | null> {
  const ref = db.collection(PA_COLLECTIONS.inboundEvents).doc(eventId)
  return db.runTransaction(async (t) => {
    const snap = await t.get(ref)
    if (!snap.exists) return null
    const raw = snap.data() as InboundEvent & { attempts?: number; leaseUntil?: string }
    if (raw.status !== "pending" && !(raw.status === "running" && isInboundLeaseExpired(raw.leaseUntil, now))) {
      return null
    }
    const claimedAt = now.toISOString()
    const leaseUntil = new Date(now.getTime() + INBOUND_LEASE_MS).toISOString()
    const patch = {
      status: "running" as const,
      attempts: (raw.attempts ?? 0) + 1,
      claimedAt,
      leaseUntil,
      startedAt: raw.startedAt ?? claimedAt,
      updatedAt: claimedAt,
    }
    t.set(ref, patch, { merge: true })
    return { ...raw, ...patch }
  })
}

export async function claimAndProcessInboundEvent(
  db: Firestore,
  eventId: string,
  log: (...args: unknown[]) => void = (...args) => console.log(new Date().toISOString(), ...args),
  deps: OrchestratorStoreDeps = {}
): Promise<number> {
  const event = await claimInboundEvent(db, eventId)
  if (!event) return 0
  await processInboundEvent(event, createFirestoreOrchestratorStore(db, deps))
  log("[orchestrator] processed", eventId)
  return 1
}

export async function reclaimExpiredInboundEvents(
  db: Firestore,
  log: (...args: unknown[]) => void = (...args) => console.log(new Date().toISOString(), ...args),
  now = new Date()
): Promise<number> {
  const snap = await db.collection(PA_COLLECTIONS.inboundEvents).where("status", "==", "running").limit(50).get()
  let reclaimed = 0
  for (const doc of snap.docs) {
    const raw = doc.data() as { leaseUntil?: string }
    if (!isInboundLeaseExpired(raw.leaseUntil, now)) continue
    log("[orchestrator] reclaim expired inbound lease", doc.id)
    reclaimed += await claimAndProcessInboundEvent(db, doc.id, log)
  }
  return reclaimed
}

export function startInboundEventListener(
  db: Firestore,
  log: (...args: unknown[]) => void = (...args) => console.log(new Date().toISOString(), ...args),
  input?: { reclaimMs?: number }
) {
  const ref = db
    .collection(PA_COLLECTIONS.inboundEvents)
    .where("status", "==", "pending")
    .orderBy("createdAt", "asc")

  const reclaimMs = input?.reclaimMs ?? Math.max(30_000, INBOUND_LEASE_MS)
  const reclaimTimer = setInterval(() => {
    void reclaimExpiredInboundEvents(db, log).catch((e) => log("[orchestrator] reclaim error", e))
  }, reclaimMs)

  const unsubscribe = ref.onSnapshot(
    (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== "added") continue
        void claimAndProcessInboundEvent(db, change.doc.id, log).catch((e) => {
          log("[orchestrator] listener process error", change.doc.id, e)
        })
      }
    },
    (err) => log("[orchestrator] listener error", err)
  )

  void reclaimExpiredInboundEvents(db, log).catch((e) => log("[orchestrator] initial reclaim error", e))

  return () => {
    clearInterval(reclaimTimer)
    unsubscribe()
  }
}

// v1.8 — re-exports for dashboard / functions consumers (no subpath
// imports because exports map is single-entry).
export {
  PrescreenConfigSchema,
  parsePrescreenConfig,
  safeParsePrescreenConfig,
  configMaxScore,
  configRequiredScore,
  configToStateQuestions,
  type PrescreenConfig,
  type PrescreenQuestionConfig,
  type KeywordSpecConfig,
} from "./prescreen/config.js"
export {
  emptyPreScreenState,
  InMemoryPreScreenStore,
  type PreScreenState,
  type PreScreenQuestionState,
  type PreScreenStateProvider,
  type PreScreenTerminal,
} from "./prescreen/state.js"
export { PreScreenPipeline, hardFilterClarifyText, prescreenReviewPendingAckText, terminalText } from "./prescreen/pipeline.js"
export type {
  ComposeClarifyInput,
  PreScreenClarifyComposer,
  PreScreenQuestion,
  RunTurnInput,
  RunTurnResult,
} from "./prescreen/pipeline.js"
// v2.2 — channel-agnostic prescreen runtime ifaces. SMS + voice both
// consume `PrescreenSessionFinder` + `PrescreenTurnRecorder` so a future
// agent-behavior change lands once and propagates everywhere.
export {
  ACTIVE_PRESCREEN_TIMEOUT_MS,
  RECENT_TERMINAL_PRESCREEN_GUARD_MS,
  FirestoreSessionFinder,
  InMemorySessionFinder,
  type InMemorySessionDoc,
  type PrescreenSessionFinder,
  type SessionByIdRecord,
  type SessionFinderResult,
} from "./prescreen/session-finder.js"
export {
  FirestoreTurnRecorder,
  InMemoryTurnRecorder,
  type PrescreenTurnAction,
  type PrescreenTurnRecord,
  type PrescreenTurnRecorder,
  type PrescreenTurnScoredSnapshot,
} from "./prescreen/turn-recorder.js"
export {
  runPrescreenTurn,
  isUserExitPrescreenReply,
  prescreenTurnRecordQId,
  expiredSessionText,
  userExitSessionText,
  recentTerminalSessionText,
  type PrescreenChannel,
  type PrescreenChannelTextHint,
  type PrescreenCfgLoader,
  type PrescreenLifecycle,
  type PrescreenRunContext,
  type PrescreenRunResult,
  type PrescreenRunnerDeps,
} from "./prescreen/runner.js"
export {
  KeywordSetJudge,
  buildKeywordSetPrompt,
} from "./onboarding/judges/keyword-set.js"
export type {
  KeywordSetJudgeSpec,
  KeywordSetLlmCaller,
  KeywordSetLlmOutput,
  KeywordSpec,
} from "./onboarding/judges/keyword-set.js"
export {
  externalSupplyEvalToEvaluationAttempt,
  practiceQuestionToEvaluationAttempt,
  prescreenSessionToEvaluationAttempt,
  type ExternalSupplyEvaluationInput,
  type PracticeQuestionEvaluationInput,
  type PrescreenEvaluationInput,
} from "./screening-evaluation.js"
export {
  injectVoiceModePrefix,
  getVoiceModePrefix,
  type VoiceMode,
} from "./prescreen/voice-mode.js"
export {
  buildShadowDiff,
  evaluateShadowGate,
  jaccardSimilarity,
  resolveEngineVersion,
  type EngineVersion,
  type OnboardingShadowDiff,
  type ShadowGateReport,
} from "./prescreen/shadow.js"
export {
  composeLevel1Reveal,
  composeFailJobRecsPreamble,
  type Level1RevealFields,
} from "./prescreen/level1-template.js"
export {
  createPiiConfirmPipeline,
  validateEmail,
  validatePhone,
  validateLegalName,
  // v1.9 Level 1 onboarding validators (yoe / visa / location / salary /
  // industry / company size).
  validateYoe,
  validateVisa,
  validateLocation,
  validateSalaryRange,
  validateIndustry,
  validateCompanySize,
  type PiiConfirmAnswers,
  type PiiConfirmHooks,
  type PiiConfirmPipelineOpts,
  type Level1Answers,
} from "./prescreen/pii-confirm.js"
export {
  createFeedbackSurveyPipeline,
  isSkipReply,
  type FeedbackHooks,
  type FeedbackSurveyOpts,
} from "./prescreen/feedback-survey.js"
export {
  WEKRUIT_LAYOFF_SOURCE,
  WEKRUIT_CANDIDATE_SOURCE,
  isWekruitSignupSource,
  type WekruitSignupSource,
} from "./onboarding.js"
// v1.9 P85 — top-level re-exports for OnboardingPipeline state types used
// by apps/functions pii-confirm-start.ts.
export { OnboardingPipeline } from "./onboarding/pipeline.js"
export type { PipelineState, PipelineStateProvider, RunTurnInput as OnboardingRunTurnInput, RunTurnResult as OnboardingRunTurnResult } from "./onboarding/pipeline.js"

// 2026-05-18 — chat → tag + memory extractor runtime wrappers (concrete deps
// for the pure functions in conversation-extractor.ts).
export {
  makeExtractorDeps,
  maybeRunExtractor,
  buildNeedsOnboardingDirective,
  readExtractionState,
  writeExtractionState,
  writeMemoryEntitiesToQdrant,
  productionLlmCall,
  type MakeExtractorDepsOptions,
  type MaybeRunExtractorArgs,
  type ExtractionState,
} from "./conversation-extractor-runtime.js"

// 2026-05-18 — chat → tag + memory extractor pure functions + types. Drives
// the candidate-retention flywheel: post-onboarding free-form chat →
// pa-users.tags + Qdrant pa_memory_entities. See
// .planning/GOAL-chat-tag-memory-extraction.md.
export {
  shouldRunExtractor,
  runExtraction,
  buildExtractorPrompt,
  ConversationExtractResultSchema,
  MIN_CONFIDENCE as CONVERSATION_EXTRACTOR_MIN_CONFIDENCE,
  VISA_STATUS_VOCAB,
  type ExtractorTriggerState,
  type ExtractorTriggerKind,
  type ExtractorTriggerDecision,
  type ConversationExtractMessage,
  type ConversationExtractRequest,
  type ConversationExtractResult,
  type ConversationExtractorDeps,
  type ExtractionLlmCall,
  type MemoryEntity,
  type RunExtractionOutcome,
  type VisaStatus,
} from "./conversation-extractor.js"
