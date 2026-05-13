import { createHash, randomUUID } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  type Channel,
  type ChatMessage,
  type OnboardingStatus,
  type User,
} from "@pa/core-types"

const USERS = PA_COLLECTIONS.users
const SESSIONS = PA_COLLECTIONS.sessions
const MESSAGES = PA_COLLECTIONS.messages

function nowIso() {
  return new Date().toISOString()
}

export function normalizeE164(phone: string): string {
  const d = phone.replace(/\D/g, "")
  if (phone.trim().startsWith("+")) return `+${d}`
  return d.length === 10 ? `+1${d}` : `+${d}`
}

export function normalizeImessageParticipant(participant: string): string {
  const value = participant.trim()
  if (!value) return ""
  if (value.includes("@")) return value.toLowerCase()
  return normalizeE164(value)
}

export async function findUserByParticipant(
  db: Firestore,
  participant: string
): Promise<User | null> {
  const n = normalizeImessageParticipant(participant)
  if (!n) return null
  const query = n.includes("@")
    ? db.collection(USERS).where("channels.imessageHandle", "==", n)
    : db.collection(USERS).where("phoneE164", "==", n)
  const snap = await query.limit(1).get()
  if (snap.empty) return null
  const d = snap.docs[0]!
  return { id: d.id, ...d.data() } as User
}

export async function createProvisionalUser(db: Firestore, participant: string): Promise<User> {
  const id = randomUUID()
  const n = normalizeImessageParticipant(participant)
  const u: User = {
    id,
    phoneE164: n,
    createdAt: nowIso(),
    onboardingStatus: "provisional",
    channels: { imessageHandle: n },
  }
  await db.collection(USERS).doc(id).set(u)
  return u
}

function sessionDocId(userId: string, channel: Channel, externalChatId: string): string {
  const h = createHash("sha256")
    .update(`${userId}|${channel}|${externalChatId}`)
    .digest("hex")
  return `ses_${h.slice(0, 32)}`
}

export async function getOrCreateSession(
  db: Firestore,
  userId: string,
  channel: Channel,
  externalChatId: string
): Promise<{ id: string; userId: string; externalChatId: string; channel: Channel }> {
  const id = sessionDocId(userId, channel, externalChatId)
  const ref = db.collection(SESSIONS).doc(id)
  const existing = await ref.get()
  if (existing.exists) {
    const d = existing.data()!
    return { id, userId, externalChatId, channel, ...d } as {
      id: string
      userId: string
      externalChatId: string
      channel: Channel
    }
  }
  await ref.set({
    id,
    userId,
    channel,
    externalChatId,
    createdAt: nowIso(),
    lastMessageAt: nowIso(),
    lifecycle: "open",
  })
  return { id, userId, externalChatId, channel }
}

export async function appendMessage(
  db: Firestore,
  m: Omit<ChatMessage, "id"> & { id?: string; idempotencyKey?: string }
): Promise<ChatMessage> {
  // Phase 24 — never persist few-shot synthetic turns. Their ids are
  // prefixed "fs_" per packages/pa-orchestrator/src/voice/few-shot.ts.
  // Defense-in-depth: orchestrator only passes `history` (not
  // `historyForModel`) to appendMessage, so fs_* turns should not reach
  // here anyway — but guard added for belt-and-suspenders correctness.
  if (typeof m.id === "string" && m.id.startsWith("fs_")) {
    // Synthetic few-shot turn — return a no-op stub that satisfies the
    // return type without writing to Firestore.
    return { id: m.id, sessionId: m.sessionId, userId: m.userId, role: m.role, body: m.body, createdAt: m.createdAt } as ChatMessage
  }
  const id = m.id ?? randomUUID()
  const idempotencyKey = m.idempotencyKey
  if (idempotencyKey) {
    const ex = await db
      .collection(MESSAGES)
      .where("idempotencyKey", "==", idempotencyKey)
      .limit(1)
      .get()
    if (!ex.empty) {
      const d = ex.docs[0]!
      return d.data() as ChatMessage
    }
  }
  const doc = {
    id,
    sessionId: m.sessionId,
    userId: m.userId,
    role: m.role,
    body: m.body,
    createdAt: m.createdAt,
    ...(m.idempotencyKey ? { idempotencyKey: m.idempotencyKey } : {}),
    ...(m.rawMeta ? { rawMeta: m.rawMeta } : {}),
  } satisfies ChatMessage
  await db.collection(MESSAGES).doc(id).set(doc)
  const sessionPatch: Record<string, string> = { lastMessageAt: doc.createdAt }
  if (m.role === "user") sessionPatch.lastInboundAt = doc.createdAt
  if (m.role === "assistant") sessionPatch.lastOutboundAt = doc.createdAt
  await db.collection(SESSIONS).doc(m.sessionId).set(sessionPatch, { merge: true })
  return doc
}

export async function findMessageByIdempotencyKey(
  db: Firestore,
  idempotencyKey: string
): Promise<ChatMessage | null> {
  const snap = await db
    .collection(MESSAGES)
    .where("idempotencyKey", "==", idempotencyKey)
    .limit(1)
    .get()
  if (snap.empty) return null
  return snap.docs[0]!.data() as ChatMessage
}

export async function setUserActiveAgent(db: Firestore, userId: string, agentId: string) {
  await db
    .collection(USERS)
    .doc(userId)
    .set({ activeAgentId: agentId, updatedAt: nowIso() }, { merge: true })
}

export async function setOnboardingStatus(
  db: Firestore,
  userId: string,
  status: OnboardingStatus
) {
  await db
    .collection(USERS)
    .doc(userId)
    .set({ onboardingStatus: status, updatedAt: nowIso() }, { merge: true })
}

export async function getUser(db: Firestore, userId: string): Promise<User | null> {
  const d = await db.collection(USERS).doc(userId).get()
  if (!d.exists) return null
  return { id: d.id, ...d.data() } as User
}

// Phase 24.5 — feature-flag SDK (P9-Infra). Re-exported here so consumers
// import via the package root: `import { getFlag } from "@pa/pa-persistence"`.
export {
  DEFAULT_TTL_MS as FEATURE_FLAG_TTL_MS,
  getFlag,
  setFlag,
  revertFlag,
  addUserToFlagAllowlist,
  _clearFeatureFlagCache,
  _getFeatureFlagCacheStats,
} from "./feature-flags.js"
export type {
  FlagValue,
  FlagType,
  FlagScope,
  FlagDoc,
  FlagContext,
} from "./feature-flags.js"

// iter34 P3 — pa-onboarding-questions Firestore SDK (Adam directive 2026-05-05
// "dashboard对应的管理呢?"). Dashboard UI is next-session work; this SDK ships
// the data plane so the orchestrator can read Q config from Firestore instead
// of hard-coded defaultQuestions().
export {
  listOnboardingQuestions,
  getOnboardingQuestion,
  upsertOnboardingQuestion,
  disableOnboardingQuestion,
} from "./onboarding-questions.js"
export type {
  OnboardingQuestionDoc,
  OnboardingJudgeKind,
  OnboardingRephraserKind,
  OnboardingLLMStep,
  BilingualText as OnboardingBilingualText,
} from "./onboarding-questions.js"

// Phase 25 — pa_voice_reviews helpers (P9-Voice). LOCKED schema; see
// .planning/phases/25-voice-review-dashboard/CONTEXT.md.
export {
  VOICE_REVIEW_TAGS,
  writeVoiceReview,
  listVoiceReviews,
  listAssistantTurnsForReview,
} from "./voice-reviews.js"
export type {
  VoiceRating,
  VoiceReviewTag,
  AgentSnapshot,
  VoiceReviewDoc,
  VoiceReviewRow,
  WriteVoiceReviewInput,
  ListVoiceReviewsInput,
  ListAssistantTurnsInput,
  AssistantTurnWithReview,
} from "./voice-reviews.js"

// v2.0 S1 — marketplace data foundation reducers + append-only flywheel writes.
export {
  approveJobOpportunityDraft,
  applyCandidateJobEvent,
  applyCandidateLifecycleEvent,
  rejectJobOpportunityDraft,
  writeCorrectionEvent,
  writeEmployerVisibleProfile,
  writeFeedbackEvent,
  writeJobEnrichmentEvalFixture,
  writeJobOpportunityDraft,
} from "./marketplace.js"
export type {
  ApproveJobOpportunityDraftInput,
  MarketplaceTransitionResult,
  RejectJobOpportunityDraftInput,
} from "./marketplace.js"

// v2.0 S2 — identity + candidate claim data-plane helpers.
export {
  claimCandidateProfile,
  hashCandidateHandle,
  linkCandidateHandle,
  recordIdentityConflict,
  resolveCandidateIdentity,
  writeCandidateSelfProfile,
} from "./identity.js"
export type {
  ClaimCandidateProfileInput,
  LinkCandidateHandleInput,
  ResolveCandidateIdentityInput,
  WriteCandidateSelfProfileInput,
} from "./identity.js"

// v2.0 S3 — bulk resume intake operator persistence helpers.
export {
  bulkResumeEmailHash,
  createBulkResumeBatch,
  markBulkResumeItemIdentityConflict,
  markBulkResumeItemMissingEmailReview,
  markBulkResumeItemParsed,
  markBulkResumeItemParseFailed,
  markBulkResumeItemParsing,
  markBulkResumeItemRetryReady,
  recomputeBulkResumeBatchCounts,
  upsertBulkResumeItem,
} from "./bulk-resume-intake.js"
export type {
  BulkResumeItemPointer,
  CreateBulkResumeBatchInput,
  MarkBulkResumeItemParsedInput,
  UpsertBulkResumeItemInput,
} from "./bulk-resume-intake.js"

// Phase 26 T1 — per-user rate limit (P9-Prod-Ops).
export { checkAndIncrementRateLimit, RATE_LIMIT_COLLECTION } from "./rate-limit.js"
export type { RateLimitOptions, RateLimitResult } from "./rate-limit.js"

// Phase 26 T2 — Sendblue daily-quota counter (P9-Prod-Ops).
export {
  incrementDailyOutbound,
  getDailyOutboundCount,
  formatDailyBucket,
  OUTBOUND_QUOTA_COLLECTION,
} from "./outbound-quota.js"

// Phase 30 T1 — Downstream Eval Connectors (P9-Connectors).
export {
  TRIGGERS_COLLECTION,
  TRIGGER_FIRES_COLLECTION,
  listTriggers,
  getTrigger,
  saveTrigger,
  deleteTrigger,
  evaluateTriggers,
  checkCooldown,
  recordFire,
  listFiresForTrigger,
  renderPayload,
  hmacSign,
  firePostHook,
  newTriggerId,
} from "./triggers.js"
export type {
  Trigger,
  TriggerCondition,
  TriggerConditionKind,
  TriggerEndpoint,
  TriggerFireRow,
  KeywordConditionConfig,
  LlmJudgeConditionConfig,
  EvalCtx,
  MatchedTrigger,
  FirePostHookOptions,
  FirePostHookResult,
  SaveTriggerOpts,
} from "./triggers.js"

// Phase 31 T1 — Upstream Event Connector schema + helpers (P9-Connectors).
export {
  UPSTREAM_TEMPLATES_COLLECTION,
  UPSTREAM_FIRES_COLLECTION,
  listTemplates as listUpstreamTemplates,
  getTemplate as getUpstreamTemplate,
  getTemplateByEventKind as getUpstreamTemplateByEventKind,
  saveTemplate as saveUpstreamTemplate,
  renderTemplate as renderUpstreamTemplate,
  checkRateLimit as checkUpstreamRateLimit,
} from "./upstream-events.js"
export type {
  UpstreamTemplate,
  SaveUpstreamTemplateInput,
} from "./upstream-events.js"

// Phase 29 T1 — Agent Handbook (Bible-as-data, per-slug + immutable versions).
export {
  HANDBOOKS_COLLECTION,
  HANDBOOK_VERSIONS_SUBCOLLECTION,
  HANDBOOK_AUDIT_PREFIX as HANDBOOK_V2_AUDIT_PREFIX,
  HANDBOOK_TTL_MS,
  HANDBOOK_RENDER_ORDER,
  DEFAULT_HANDBOOK_SLUG,
  loadHandbook as loadHandbookV2,
  saveHandbook as saveHandbookV2,
  revertHandbook as revertHandbookV2,
  listVersions as listHandbookVersions,
  getVersion as getHandbookVersion,
  composeSystemPrompt as composeHandbookV2SystemPrompt,
  emptyHandbookSections,
  normalizeHandbookSections,
  _clearHandbookCache,
  _getHandbookCacheStats,
} from "./handbook.js"
export type {
  HandbookDoc,
  HandbookSections,
  PlaybookSpec,
  SaveHandbookOpts,
} from "./handbook.js"
