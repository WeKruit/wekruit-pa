import { z } from "zod"
import { ChannelSchema, type Channel } from "./channel.js"

export type { Channel }
export { ChannelSchema }

export const OnboardingStatusSchema = z.enum([
  "provisional",
  "pending",
  "code_sent",
  "active",
  "blocked",
])
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>

export const LlmProviderSchema = z.enum([
  "openai",
  "azure_openai",
  "anthropic",
  "deepseek",
  "siliconflow",
  "other",
])
export type LlmProvider = z.infer<typeof LlmProviderSchema>

export const MemoryModeSchema = z.enum(["firestore_only", "mem0", "both"])
export type MemoryMode = z.infer<typeof MemoryModeSchema>

export const MessageRoleSchema = z.enum(["user", "assistant", "system"])
export type MessageRole = z.infer<typeof MessageRoleSchema>

/** Phase 23 — onboarding state machine step */
export const OnboardingStateSchema = z.enum([
  "pending",
  "first_mes_sent",
  "grounding_q1_asked",
  "complete",
])
export type OnboardingState = z.infer<typeof OnboardingStateSchema>

/** Phase 23 — closed-beta participant lifecycle */
export const BetaParticipantStatusSchema = z.enum([
  "invited",
  "active",
  "suspended",
  "removed",
])
export type BetaParticipantStatus = z.infer<typeof BetaParticipantStatusSchema>

export const BetaParticipantSchema = z.object({
  id: z.string(),
  /** Normalized: +E164 phone OR lowercased email */
  contactHandle: z.string(),
  contactType: z.enum(["phone", "email"]),
  /** null until first contact resolves to a pa_users row */
  userId: z.string().nullable(),
  status: BetaParticipantStatusSchema,
  addedAt: z.string(),
  addedBy: z.string(),
  removedAt: z.string().nullable(),
  notes: z.string().nullable(),
  metadata: z.object({
    source: z.string().optional(),
    cohort: z.string().optional(),
  }).default({}),
})
export type BetaParticipant = z.infer<typeof BetaParticipantSchema>

export const UserSchema = z.object({
  id: z.string(),
  phoneE164: z.string(),
  displayName: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  onboardingStatus: OnboardingStatusSchema,
  activeAgentId: z.string().optional(),
  /**
   * Phase 11.3 — authoritative for the Mem0/Qdrant payload `user_id`
   * partition on collection `pa-memory` (semantic memory only). Defaults
   * to `user.id` when unset. ALL Mem0/Qdrant call sites MUST resolve via
   * `resolveMem0PartitionKey(user)` from `@pa/memory` — never read this
   * field directly. Backfilled to `= id` for legacy users by
   * `scripts/pa-backfill-mem0-user-id.mjs` so dashboard behavior is
   * byte-identical pre/post 11.3.
   *
   * NEVER use this field for Firestore scoping (pa_messages, pa_users,
   * pa_audit_events, persona card etc. are all `userId`-keyed; see
   * .planning/phases/11-persona-identity-injection/11-IDENTITY-CONTRACT.md).
   */
  mem0UserId: z.string().optional(),
  /**
   * Gate for in-band test admin commands (e.g. `__PA_RESET__` magic string
   * triggers `clearUserMemory`). MUST be `false` / unset for any user that
   * could plausibly belong to a real customer. Operator must flip this
   * explicitly via dashboard or `scripts/pa-set-test-mode.mjs`.
   */
  testMode: z.boolean().optional(),
  channels: z
    .object({
      imessageHandle: z.string().optional(),
    })
    .optional(),
  /** Phase 23 — onboarding state machine for closed-beta first-contact flow */
  onboardingState: OnboardingStateSchema.optional(),
  onboardedAt: z.string().nullable().optional(),
  metadata: z.object({
    cohort: z.string().optional(),
  }).optional(),
})
export type User = z.infer<typeof UserSchema>

export const SessionLifecycleSchema = z.enum(["open", "closed", "blocked"])
export type SessionLifecycle = z.infer<typeof SessionLifecycleSchema>

export const SessionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  channel: ChannelSchema,
  externalChatId: z.string(),
  lastMessageAt: z.string().optional(),
  lastInboundAt: z.string().optional(),
  lastOutboundAt: z.string().optional(),
  lifecycle: SessionLifecycleSchema.optional(),
  createdAt: z.string(),
})
export type Session = z.infer<typeof SessionSchema>

export const ChatMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  userId: z.string(),
  role: MessageRoleSchema,
  body: z.string(),
  createdAt: z.string(),
  idempotencyKey: z.string().optional(),
  rawMeta: z.record(z.unknown()).optional(),
})
export type ChatMessage = z.infer<typeof ChatMessageSchema>

export const ToolPolicySchema = z.enum(["none", "allowlist", "restricted"])
export type ToolPolicy = z.infer<typeof ToolPolicySchema>

export const AgentStatusSchema = z.enum(["draft", "published", "archived"])
export type AgentStatus = z.infer<typeof AgentStatusSchema>

export const AgentPersonaSchema = z.object({
  tone: z.string().optional(),
  style: z.array(z.string()).optional(),
  boundaries: z.array(z.string()).optional(),
  goals: z.array(z.string()).optional(),
})
export type AgentPersona = z.infer<typeof AgentPersonaSchema>

export const AgentDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  systemPrompt: z.string(),
  provider: LlmProviderSchema,
  model: z.string(),
  status: AgentStatusSchema.optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().positive().optional(),
  isDefault: z.boolean().optional(),
  version: z.string().default("1"),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  publishedAt: z.string().optional(),
  publishedBy: z.string().optional(),
  persona: AgentPersonaSchema.optional(),
  modelProbe: z
    .object({
      status: z.enum(["unknown", "passed", "failed"]).default("unknown"),
      checkedAt: z.string().optional(),
      error: z.string().optional(),
    })
    .optional(),
  /** Source of truth for transcript + Mem0 behavior for this agent (retrieval + post-turn writeback). */
  memoryMode: MemoryModeSchema.default("firestore_only"),
  toolPolicy: ToolPolicySchema.default("none"),
  allowedConnectors: z.array(z.string()).optional(),
  toolBudgetPerTurn: z.number().int().nonnegative().optional(),
  /** Phase 24 T1B: 12 mes_examples relocated from systemPrompt to messages-array alternating turns. */
  fewShotMessages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      })
    )
    .optional(),
  /**
   * Phase 29 — opt-in flag for the handbook composer. When `true`, the
   * orchestrator loads `pa-handbook-sections` and composes the systemPrompt
   * at runtime instead of reading the inline `systemPrompt` field. When
   * `false` / undefined, the legacy inline path is used (failsafe during
   * cutover; the inline systemPrompt field is kept until cleanup).
   */
  handbookEnabled: z.boolean().optional(),
})
export type AgentDef = z.infer<typeof AgentDefSchema>

export const MemoryEntryKindSchema = z.enum(["summary", "fact", "raw"])
export type MemoryEntryKind = z.infer<typeof MemoryEntryKindSchema>

export const MemoryEntrySchema = z.object({
  id: z.string(),
  userId: z.string(),
  sessionId: z.string().optional(),
  content: z.string(),
  kind: MemoryEntryKindSchema,
  createdAt: z.string(),
})
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>

export const OutboundStatusSchema = z.enum(["pending", "sending", "sent", "failed"])
export type OutboundStatus = z.infer<typeof OutboundStatusSchema>

export const OutboundMessageSchema = z.object({
  id: z.string().optional(),
  userId: z.string(),
  toE164: z.string(),
  /** When set, macOS worker prefers sending to this chat id (Photon). */
  imessageChatId: z.string().optional(),
  body: z.string(),
  status: OutboundStatusSchema,
  createdAt: z.string(),
  createdBy: z.string().optional(),
  idempotencyKey: z.string().optional(),
  /** pa-orchestrator path: link to source session for analytics + dashboards. */
  sessionId: z.string().optional(),
  /** pa-orchestrator path: which side wrote it (assistant turn vs operator). */
  role: MessageRoleSchema.optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  attempts: z.number().int().nonnegative().optional(),
  leaseUntil: z.string().optional(),
  claimedAt: z.string().optional(),
  sentAt: z.string().optional(),
  updatedAt: z.string().optional(),
  /**
   * Phase 15 — chunked delivery plan, if the worker delivered the
   * outbound body as 2+ chunks (typing-indicator simulation). Optional
   * + additive: workers and consumers that pre-date Phase 15 simply
   * ignore this field. Operator dashboards may surface a badge.
   */
  chunkPlan: z
    .object({
      count: z.number().int().min(1),
      delaysMs: z.array(z.number().int().nonnegative()),
    })
    .optional(),
})
export type OutboundMessage = z.infer<typeof OutboundMessageSchema>

export const ProcessingStatusSchema = z.enum(["pending", "running", "succeeded", "failed"])
export type ProcessingStatus = z.infer<typeof ProcessingStatusSchema>

export const InboundEventSchema = z.object({
  id: z.string(),
  userId: z.string(),
  sessionId: z.string(),
  channel: ChannelSchema,
  externalChatId: z.string(),
  from: z.string(),
  body: z.string(),
  status: ProcessingStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  attempts: z.number().int().nonnegative().optional(),
  leaseUntil: z.string().optional(),
  claimedAt: z.string().optional(),
  idempotencyKey: z.string(),
  errorCode: z.string().optional(),
  error: z.string().optional(),
  rawMeta: z.record(z.unknown()).optional(),
})
export type InboundEvent = z.infer<typeof InboundEventSchema>

export const TurnStageSchema = z.enum([
  "received",
  "memory_command",
  "memory_load",
  "llm",
  "outbound",
  "succeeded",
  "failed",
])
export type TurnStage = z.infer<typeof TurnStageSchema>

export const TurnSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  userId: z.string(),
  sessionId: z.string(),
  agentId: z.string().optional(),
  status: ProcessingStatusSchema,
  stage: TurnStageSchema,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  completedAt: z.string().optional(),
  memoryMode: MemoryModeSchema.optional(),
  mem0Degraded: z.boolean().optional(),
  mem0DegradedReason: z.string().optional(),
  mem0SearchResultCount: z.number().int().nonnegative().optional(),
  errorCode: z.string().optional(),
  error: z.string().optional(),
})
export type Turn = z.infer<typeof TurnSchema>

export const MemoryFactStatusSchema = z.enum(["confirmed", "deleted"])
export type MemoryFactStatus = z.infer<typeof MemoryFactStatusSchema>

export const MemoryFactSchema = z.object({
  id: z.string(),
  userId: z.string(),
  content: z.string(),
  status: MemoryFactStatusSchema,
  source: z.enum(["explicit_user", "operator", "proposal"]).default("explicit_user"),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  deletedAt: z.string().optional(),
  deletedByEventId: z.string().optional(),
  /**
   * Memory-opt P0-2 — persona-card importance-weighted ranker inputs.
   * Both fields are OPTIONAL and BACKWARD-COMPATIBLE: legacy rows that
   * predate the ranker default to 0, in which case the ranker collapses
   * to recency-only ordering (which matches the prior FIFO behavior for
   * same-creation-time facts).
   *
   *  - `accessCount`: monotonic counter incremented when the fact is
   *    surfaced/used. Currently advisory; a future writeback path may
   *    update it from `pa-memory-actions`.
   *  - `salience`: 0..1 importance hint. Auto-bumped to 1 by the ranker
   *    for identity-bearing or long-term-goal facts (regex-detected at
   *    rank time so legacy rows benefit without backfill).
   */
  accessCount: z.number().nonnegative().optional(),
  salience: z.number().min(0).max(1).optional(),
})
export type MemoryFact = z.infer<typeof MemoryFactSchema>

export const MemoryActionTypeSchema = z.enum([
  "remember",
  "reject_sensitive",
  "list",
  "forget",
  "clear_request",
  "clear_confirm",
])
export type MemoryActionType = z.infer<typeof MemoryActionTypeSchema>

export const MemoryActionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  eventId: z.string().optional(),
  action: MemoryActionTypeSchema,
  status: ProcessingStatusSchema,
  content: z.string().optional(),
  factIds: z.array(z.string()).optional(),
  reason: z.string().optional(),
  createdAt: z.string(),
})
export type MemoryAction = z.infer<typeof MemoryActionSchema>

export const ConversationSummarySchema = z.object({
  id: z.string(),
  userId: z.string(),
  sessionId: z.string(),
  fromMessageCreatedAt: z.string(),
  toMessageCreatedAt: z.string(),
  summary: z.string(),
  source: z.enum(["manual", "scheduled", "archive"]).default("scheduled"),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
})
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>

export const MessageArchivePointerSchema = z.object({
  id: z.string(),
  userId: z.string(),
  sessionId: z.string().optional(),
  archivePath: z.string(),
  month: z.string(),
  messageCount: z.number().int().nonnegative(),
  firstCreatedAt: z.string().optional(),
  lastCreatedAt: z.string().optional(),
  sha256: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
})
export type MessageArchivePointer = z.infer<typeof MessageArchivePointerSchema>

export const ScheduledJobStatusSchema = z.enum(["pending", "processing", "completed", "failed", "dead_letter"])
export type ScheduledJobStatus = z.infer<typeof ScheduledJobStatusSchema>

export const ScheduledJobSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: ScheduledJobStatusSchema,
  dueAt: z.string(),
  payload: z.record(z.unknown()).default({}),
  attemptCount: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(5),
  backoffMs: z.number().int().nonnegative().default(60_000),
  claimedBy: z.string().optional(),
  leaseUntil: z.string().optional(),
  lastError: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
})
export type ScheduledJob = z.infer<typeof ScheduledJobSchema>

export const RuntimeHeartbeatSchema = z.object({
  id: z.string(),
  runtimeId: z.string(),
  kind: z.enum(["worker", "orchestrator", "scheduler"]),
  status: z.enum(["ok", "degraded", "down"]).default("ok"),
  lastSeenAt: z.string(),
  meta: z.record(z.unknown()).optional(),
})
export type RuntimeHeartbeat = z.infer<typeof RuntimeHeartbeatSchema>

export {
  PA_COLLECTIONS,
  PA_REMOTE_CONFIG_DOC,
} from "./collections.js"

// Phase 22 — Proactive check-in schema + idempotency helper
// Export as ProactiveScheduledJob to avoid shadowing the Phase 7 ScheduledJob above.
export {
  PROACTIVE_JOB_STATUS,
  fireWindowHash,
  type ProactiveTriggerType,
  type ProactiveRecurrence,
  type ProactiveJobContext,
  type TimeAnchorContext,
  type SilenceAnchorContext,
  type ApplicationFollowupContext,
  type ProactiveJobStatus,
  type ScheduledJob as ProactiveScheduledJob,
} from "./scheduled-jobs.js"

export {
  InboundEventStatusSchema,
  type InboundEventStatus,
  ImessageInboundPayloadSchema,
  type ImessageInboundPayload,
  InboundRawPayloadSchema,
  type InboundRawPayload,
  PaInboundEventSchema,
  type PaInboundEvent,
  AgentTurnStatusSchema,
  type AgentTurnStatus,
  AgentTurnStepSchema,
  type AgentTurnStep,
  PaAgentTurnSchema,
  type PaAgentTurn,
  ToolCallStatusSchema,
  type ToolCallStatus,
  PaToolCallSchema,
  type PaToolCall,
  AuditEventKindSchema,
  type AuditEventKind,
  PaAuditEventSchema,
  type PaAuditEvent,
  PaRateLimitBucketSchema,
  type PaRateLimitBucket,
  AbuseEventKindSchema,
  type AbuseEventKind,
  PaAbuseEventSchema,
  type PaAbuseEvent,
  PaSessionLinkSchema,
  type PaSessionLink,
  MemoryEventKindSchema,
  type MemoryEventKind,
  PaMemoryEventSchema,
  type PaMemoryEvent,
} from "./broker.js"
