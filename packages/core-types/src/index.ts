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
  "other",
])
export type LlmProvider = z.infer<typeof LlmProviderSchema>

export const MemoryModeSchema = z.enum(["firestore_only", "mem0", "both"])
export type MemoryMode = z.infer<typeof MemoryModeSchema>

export const MessageRoleSchema = z.enum(["user", "assistant", "system"])
export type MessageRole = z.infer<typeof MessageRoleSchema>

export const UserSchema = z.object({
  id: z.string(),
  phoneE164: z.string(),
  displayName: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  onboardingStatus: OnboardingStatusSchema,
  activeAgentId: z.string().optional(),
  mem0UserId: z.string().optional(),
  channels: z
    .object({
      imessageHandle: z.string().optional(),
    })
    .optional(),
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
  status: AgentStatusSchema.default("published"),
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
  error: z.string().optional(),
  sentAt: z.string().optional(),
  updatedAt: z.string().optional(),
})
export type OutboundMessage = z.infer<typeof OutboundMessageSchema>

export const MemoryFactStatusSchema = z.enum(["proposed", "confirmed", "rejected", "deleted"])
export type MemoryFactStatus = z.infer<typeof MemoryFactStatusSchema>

export const MemorySensitivitySchema = z.enum(["low", "medium", "high"])
export type MemorySensitivity = z.infer<typeof MemorySensitivitySchema>

export const MemoryFactSchema = z.object({
  id: z.string(),
  userId: z.string(),
  key: z.string(),
  value: z.string(),
  status: MemoryFactStatusSchema,
  sensitivity: MemorySensitivitySchema.default("low"),
  confidence: z.number().min(0).max(1).optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
})
export type MemoryFact = z.infer<typeof MemoryFactSchema>

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
