import { z } from "zod"
import { ChannelSchema } from "./channel.js"

/** Inbound broker event lifecycle */
export const InboundEventStatusSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
  "dead_letter",
])
export type InboundEventStatus = z.infer<typeof InboundEventStatusSchema>

/** Raw payload from iMessage adapter (extensible for future channels) */
export const ImessageInboundPayloadSchema = z.object({
  kind: z.literal("imessage"),
  participant: z.string(),
  chatId: z.string(),
  messageRowId: z.number(),
  text: z.string(),
})
export type ImessageInboundPayload = z.infer<typeof ImessageInboundPayloadSchema>

export const InboundRawPayloadSchema = z.discriminatedUnion("kind", [ImessageInboundPayloadSchema])
export type InboundRawPayload = z.infer<typeof InboundRawPayloadSchema>

export const PaInboundEventSchema = z.object({
  id: z.string(),
  channel: ChannelSchema,
  status: InboundEventStatusSchema,
  idempotencyKey: z.string(),
  rawPayload: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  /** Set after user/session resolution */
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  /** Lease / claim (orchestrator instance id or random claim token) */
  claimedBy: z.string().optional(),
  leaseUntil: z.string().optional(),
  attemptCount: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(8),
  lastError: z.string().optional(),
  deadLetterReason: z.string().optional(),
  /** Links to orchestration */
  agentTurnId: z.string().optional(),
  correlationId: z.string().optional(),
})
export type PaInboundEvent = z.infer<typeof PaInboundEventSchema>

export const AgentTurnStatusSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
  "dead_letter",
])
export type AgentTurnStatus = z.infer<typeof AgentTurnStatusSchema>

export const AgentTurnStepSchema = z.object({
  at: z.string(),
  name: z.string(),
  detail: z.record(z.unknown()).optional(),
})
export type AgentTurnStep = z.infer<typeof AgentTurnStepSchema>

export const PaAgentTurnSchema = z.object({
  id: z.string(),
  inboundEventId: z.string(),
  userId: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  status: AgentTurnStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  steps: z.array(AgentTurnStepSchema).optional(),
  idempotencyKey: z.string(),
  claimedBy: z.string().optional(),
  leaseUntil: z.string().optional(),
  attemptCount: z.number().int().nonnegative().default(0),
  lastError: z.string().optional(),
  deadLetterReason: z.string().optional(),
  /** Assistant message id after transcript write */
  assistantMessageId: z.string().optional(),
  outboundId: z.string().optional(),
})
export type PaAgentTurn = z.infer<typeof PaAgentTurnSchema>

export const ToolCallStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "denied",
])
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>

/** Stable family for dashboards / candidate tool history (see @pa/pa-connectors tool-family). */
export const PaToolFamilySchema = z.enum([
  "web_search",
  "memory",
  "match_general",
  "match_collab",
  "job_profile",
  "legacy_matching",
  "valet",
  "other",
])
export type PaToolFamily = z.infer<typeof PaToolFamilySchema>

export const PaToolCallSchema = z.object({
  id: z.string(),
  turnId: z.string(),
  connectorName: z.string(),
  toolFamily: PaToolFamilySchema.optional(),
  connectorVersion: z.string().default("1"),
  status: ToolCallStatusSchema,
  argsDigest: z.string(),
  argsRedacted: z.record(z.unknown()).optional(),
  resultSummary: z.string().optional(),
  error: z.string().optional(),
  policyDecision: z.enum(["allow", "deny"]).optional(),
  policyReason: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  auditEventIds: z.array(z.string()).optional(),
})
export type PaToolCall = z.infer<typeof PaToolCallSchema>

export const AuditEventKindSchema = z.enum([
  "tool_call_started",
  "tool_call_completed",
  "tool_policy_denied",
  "safety_block",
  "rate_limit",
  "memory_filter_block",
  "connector_error",
  "turn_state",
  "inbound_duplicate",
  "agent_published",
  "agent_rollback",
  "agent_default_changed",
  "agent_model_probe",
  // Phase 11.3 — emitted by recordDriftIfAny() when resolveMem0PartitionKey(user) !== user.id.
  // One row per (userId, mem0UserId, surface) tuple per CF cold start (LRU-throttled).
  "memory.identity_drift",
  // Phase 22 — proactive check-in audit events (D-09)
  "proactive_send",
  "proactive_runtime_handoff",
  "proactive_runtime_suppressed",
  "proactive_cancel",
  "privacy_request",
])
export type AuditEventKind = z.infer<typeof AuditEventKindSchema>

export const PaAuditEventSchema = z.object({
  id: z.string(),
  kind: AuditEventKindSchema,
  createdAt: z.string(),
  actor: z.enum(["system", "orchestrator", "operator", "worker"]).default("system"),
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  inboundEventId: z.string().optional(),
  toolCallId: z.string().optional(),
  message: z.string(),
  meta: z.record(z.unknown()).optional(),
})
export type PaAuditEvent = z.infer<typeof PaAuditEventSchema>

export const PaRateLimitBucketSchema = z.object({
  id: z.string(),
  userId: z.string().optional(),
  channel: ChannelSchema.optional(),
  windowKey: z.string(),
  count: z.number().int().nonnegative(),
  windowStartedAt: z.string(),
  updatedAt: z.string(),
})
export type PaRateLimitBucket = z.infer<typeof PaRateLimitBucketSchema>

export const AbuseEventKindSchema = z.enum([
  "rate_limited",
  "prompt_injection",
  "prompt_injection_signal",
  "allowlist_deny",
  "tool_abuse",
  "cross_session_attempt",
  "blocked_connector",
])
export type AbuseEventKind = z.infer<typeof AbuseEventKindSchema>

export const PaAbuseEventSchema = z.object({
  id: z.string(),
  kind: AbuseEventKindSchema,
  createdAt: z.string(),
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  channel: ChannelSchema.optional(),
  message: z.string(),
  meta: z.record(z.unknown()).optional(),
})
export type PaAbuseEvent = z.infer<typeof PaAbuseEventSchema>

export const PaSessionLinkSchema = z.object({
  id: z.string(),
  userId: z.string(),
  primarySessionId: z.string(),
  linkedSessionIds: z.array(z.string()),
  createdAt: z.string(),
  reason: z.string().optional(),
})
export type PaSessionLink = z.infer<typeof PaSessionLinkSchema>

export const MemoryEventKindSchema = z.enum([
  "write",
  "delete",
  "export",
  "degraded",
  "filter_block",
])
export type MemoryEventKind = z.infer<typeof MemoryEventKindSchema>

export const PaMemoryEventSchema = z.object({
  id: z.string(),
  kind: MemoryEventKindSchema,
  createdAt: z.string(),
  userId: z.string(),
  mem0UserId: z.string().optional(),
  message: z.string(),
  meta: z.record(z.unknown()).optional(),
})
export type PaMemoryEvent = z.infer<typeof PaMemoryEventSchema>
