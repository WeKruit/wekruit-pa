import { z } from "zod"

export const ChannelSchema = z.enum(["imessage", "sms", "rcs", "other"])
export type Channel = z.infer<typeof ChannelSchema>

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

export const SessionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  channel: ChannelSchema,
  externalChatId: z.string(),
  lastMessageAt: z.string().optional(),
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

export const ToolPolicySchema = z.enum(["none", "allowlist"])
export type ToolPolicy = z.infer<typeof ToolPolicySchema>

export const AgentDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  systemPrompt: z.string(),
  provider: LlmProviderSchema,
  model: z.string(),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().positive().optional(),
  isDefault: z.boolean().optional(),
  version: z.string().default("1"),
  /** Source of truth for transcript + Mem0 behavior for this agent (retrieval + post-turn writeback). */
  memoryMode: MemoryModeSchema.default("firestore_only"),
  toolPolicy: ToolPolicySchema.default("none"),
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

export const OutboundStatusSchema = z.enum(["pending", "sending", "sent", "failed"])
export type OutboundStatus = z.infer<typeof OutboundStatusSchema>

export const OutboundMessageSchema = z.object({
  id: z.string().optional(),
  userId: z.string(),
  toE164: z.string(),
  body: z.string(),
  status: OutboundStatusSchema,
  createdAt: z.string(),
  createdBy: z.string().optional(),
  idempotencyKey: z.string().optional(),
  sessionId: z.string().optional(),
  role: MessageRoleSchema.optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  attempts: z.number().int().nonnegative().optional(),
  leaseUntil: z.string().optional(),
  claimedAt: z.string().optional(),
  sentAt: z.string().optional(),
  updatedAt: z.string().optional(),
})
export type OutboundMessage = z.infer<typeof OutboundMessageSchema>

export { PA_COLLECTIONS, PA_REMOTE_CONFIG_DOC } from "./collections.js"
