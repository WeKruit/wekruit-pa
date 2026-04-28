/**
 * Phase 25 — `pa_voice_reviews` SDK (P9-Voice).
 *
 * LOCKED schema (see .planning/phases/25-voice-review-dashboard/CONTEXT.md):
 * `pa_voice_reviews/{messageId}`:
 *   {
 *     messageId:      string,
 *     rating:         1 | 2 | 3 | 4 | 5,
 *     tags:           ("probe"|"diagnose"|"too_long"|"tone"|"ai_speak"|"ok")[],
 *     comment:        string,
 *     reviewerId:     string,
 *     agentSnapshot:  { bibleVersion: string, modelId: string },
 *     createdAt:      Timestamp
 *   }
 *
 * Phase 27 read-only contract: do NOT mutate this schema after Phase 25 ships.
 * Future fields → additive only (new optional keys), never rename/remove.
 *
 * agentSnapshot is denormalized at write time so Bible-version churn does not
 * break historical reviews.
 */

import type { Firestore, Timestamp } from "firebase-admin/firestore"
import { FieldValue } from "firebase-admin/firestore"

const VOICE_REVIEWS = "pa_voice_reviews"
const MESSAGES = "pa_messages"

export const VOICE_REVIEW_TAGS = [
  "probe",
  "diagnose",
  "too_long",
  "tone",
  "ai_speak",
  "ok",
] as const
export type VoiceReviewTag = (typeof VOICE_REVIEW_TAGS)[number]

export type VoiceRating = 1 | 2 | 3 | 4 | 5

export interface AgentSnapshot {
  bibleVersion: string
  modelId: string
}

export interface VoiceReviewDoc {
  messageId: string
  rating: VoiceRating
  tags: VoiceReviewTag[]
  comment: string
  reviewerId: string
  agentSnapshot: AgentSnapshot
  createdAt: Timestamp | FieldValue
}

export interface WriteVoiceReviewInput {
  messageId: string
  rating: VoiceRating
  tags: VoiceReviewTag[]
  comment: string
  reviewerId: string
  agentSnapshot: AgentSnapshot
}

const VALID_RATINGS = new Set<number>([1, 2, 3, 4, 5])
const VALID_TAGS = new Set<string>(VOICE_REVIEW_TAGS)

function assertValid(input: WriteVoiceReviewInput): void {
  if (!input.messageId || typeof input.messageId !== "string") {
    throw new Error("voice-reviews: messageId required")
  }
  if (!VALID_RATINGS.has(input.rating)) {
    throw new Error(`voice-reviews: rating must be 1..5 (got ${String(input.rating)})`)
  }
  if (!Array.isArray(input.tags)) {
    throw new Error("voice-reviews: tags must be an array")
  }
  for (const t of input.tags) {
    if (!VALID_TAGS.has(t)) {
      throw new Error(`voice-reviews: invalid tag "${String(t)}" — allowed: ${VOICE_REVIEW_TAGS.join(",")}`)
    }
  }
  if (typeof input.comment !== "string") {
    throw new Error("voice-reviews: comment must be a string (use '' for empty)")
  }
  if (!input.reviewerId || typeof input.reviewerId !== "string") {
    throw new Error("voice-reviews: reviewerId required")
  }
  const snap = input.agentSnapshot
  if (!snap || typeof snap !== "object") {
    throw new Error("voice-reviews: agentSnapshot required")
  }
  if (!snap.bibleVersion || typeof snap.bibleVersion !== "string") {
    throw new Error("voice-reviews: agentSnapshot.bibleVersion required")
  }
  if (!snap.modelId || typeof snap.modelId !== "string") {
    throw new Error("voice-reviews: agentSnapshot.modelId required")
  }
}

/**
 * Write `pa_voice_reviews/{messageId}` with serverTimestamp createdAt.
 * Idempotent: re-rating the same messageId overwrites in place (latest wins).
 */
export async function writeVoiceReview(
  db: Firestore,
  input: WriteVoiceReviewInput
): Promise<void> {
  assertValid(input)
  const doc: VoiceReviewDoc = {
    messageId: input.messageId,
    rating: input.rating,
    // Dedup tags but preserve order
    tags: Array.from(new Set(input.tags)) as VoiceReviewTag[],
    comment: input.comment,
    reviewerId: input.reviewerId,
    agentSnapshot: {
      bibleVersion: input.agentSnapshot.bibleVersion,
      modelId: input.agentSnapshot.modelId,
    },
    createdAt: FieldValue.serverTimestamp(),
  }
  await db.collection(VOICE_REVIEWS).doc(input.messageId).set(doc)
}

export interface ListVoiceReviewsInput {
  /** ISO timestamp lower bound (`createdAt >= sinceTs`). */
  sinceTs?: string
  /** Filter `rating <= ratingMax`. Phase 27 uses `ratingMax: 2` for cron. */
  ratingMax?: VoiceRating
  /** Filter `rating >= ratingMin`. */
  ratingMin?: VoiceRating
  /** Page size. Default 100. */
  limit?: number
}

export interface VoiceReviewRow extends Omit<VoiceReviewDoc, "createdAt"> {
  createdAt: string | null
}

function tsToIso(value: unknown): string | null {
  if (!value) return null
  if (typeof value === "string") return value
  if (typeof (value as { toDate?: () => Date }).toDate === "function") {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString()
    } catch {
      return null
    }
  }
  if (typeof (value as { seconds?: number }).seconds === "number") {
    const seconds = (value as { seconds: number }).seconds
    return new Date(seconds * 1000).toISOString()
  }
  return null
}

/**
 * Paginated query — Phase 27 read consumer.
 * Sorted by createdAt desc.
 */
export async function listVoiceReviews(
  db: Firestore,
  input: ListVoiceReviewsInput = {}
): Promise<VoiceReviewRow[]> {
  const limit = input.limit ?? 100
  // firebase-admin uses dynamic builder; cast to keep typings light.
  let q = db.collection(VOICE_REVIEWS) as unknown as {
    where: (field: string, op: string, val: unknown) => typeof q
    orderBy: (field: string, dir: "desc" | "asc") => typeof q
    limit: (n: number) => typeof q
    get: () => Promise<{ docs: Array<{ id: string; data: () => Record<string, unknown> }> }>
  }
  if (input.ratingMax != null) q = q.where("rating", "<=", input.ratingMax)
  if (input.ratingMin != null) q = q.where("rating", ">=", input.ratingMin)
  if (input.sinceTs) q = q.where("createdAt", ">=", input.sinceTs)
  q = q.orderBy("createdAt", "desc").limit(limit)
  const snap = await q.get()
  return snap.docs.map((d) => {
    const raw = d.data() as Partial<VoiceReviewDoc> & { createdAt?: unknown }
    const snapAgent = raw.agentSnapshot as AgentSnapshot | undefined
    return {
      messageId: (raw.messageId as string) ?? d.id,
      rating: (raw.rating as VoiceRating) ?? 3,
      tags: Array.isArray(raw.tags) ? (raw.tags as VoiceReviewTag[]) : [],
      comment: (raw.comment as string) ?? "",
      reviewerId: (raw.reviewerId as string) ?? "",
      agentSnapshot: {
        bibleVersion: snapAgent?.bibleVersion ?? "",
        modelId: snapAgent?.modelId ?? "",
      },
      createdAt: tsToIso(raw.createdAt),
    }
  })
}

export interface ListAssistantTurnsInput {
  /** Cursor: `messageId` of last seen turn. */
  cursor?: string
  /** Page size. Default 50. */
  limit?: number
}

export interface AssistantTurnWithReview {
  /** pa_messages doc id (== voice review key). */
  messageId: string
  sessionId: string
  userId: string
  body: string
  createdAt: string | null
  /** Prior user-turn body (context for reviewer). null if turn is first. */
  priorUserBody: string | null
  /** Whether a `pa_voice_reviews/{messageId}` doc already exists. */
  reviewed: boolean
  /** Existing review (if reviewed === true) for "edit in place" UX. */
  review: VoiceReviewRow | null
  /** Cursor token for next page (last messageId on this page). */
  nextCursor: string | null
}

/**
 * Lists assistant turns from `pa_messages` (newest first) and LEFT-joins
 * `pa_voice_reviews` so the UI can show reviewed/unreviewed badges per row.
 *
 * Each row also includes `priorUserBody` — the immediately preceding user turn
 * in the same session — so reviewers see what the assistant was responding to.
 *
 * Pagination uses messageId-based cursor (Firestore startAfter on createdAt).
 */
export async function listAssistantTurnsForReview(
  db: Firestore,
  input: ListAssistantTurnsInput = {}
): Promise<AssistantTurnWithReview[]> {
  const limit = input.limit ?? 50

  // Fetch assistant turns newest-first.
  let assistantQ = db.collection(MESSAGES) as unknown as {
    where: (field: string, op: string, val: unknown) => typeof assistantQ
    orderBy: (field: string, dir: "desc" | "asc") => typeof assistantQ
    startAfter: (val: unknown) => typeof assistantQ
    limit: (n: number) => typeof assistantQ
    get: () => Promise<{ docs: Array<{ id: string; data: () => Record<string, unknown> }> }>
  }
  assistantQ = assistantQ.where("role", "==", "assistant").orderBy("createdAt", "desc")

  if (input.cursor) {
    // Cursor is the createdAt ISO of the last seen row.
    assistantQ = assistantQ.startAfter(input.cursor)
  }
  assistantQ = assistantQ.limit(limit)
  const turnSnap = await assistantQ.get()
  const turns = turnSnap.docs.map((d) => {
    const raw = d.data() as Record<string, unknown>
    return {
      messageId: (raw.id as string) ?? d.id,
      sessionId: (raw.sessionId as string) ?? "",
      userId: (raw.userId as string) ?? "",
      body: (raw.body as string) ?? "",
      createdAt: (raw.createdAt as string) ?? null,
    }
  })

  if (turns.length === 0) return []

  // Batch-fetch existing reviews for these messageIds.
  const reviewsById = new Map<string, VoiceReviewRow>()
  const reviewsCol = db.collection(VOICE_REVIEWS) as unknown as {
    doc: (id: string) => { get: () => Promise<{ exists: boolean; id: string; data: () => Record<string, unknown> | undefined }> }
  }
  await Promise.all(
    turns.map(async (t) => {
      const snap = await reviewsCol.doc(t.messageId).get()
      if (!snap.exists) return
      const raw = (snap.data() ?? {}) as Partial<VoiceReviewDoc> & { createdAt?: unknown }
      const snapAgent = raw.agentSnapshot as AgentSnapshot | undefined
      reviewsById.set(t.messageId, {
        messageId: (raw.messageId as string) ?? t.messageId,
        rating: (raw.rating as VoiceRating) ?? 3,
        tags: Array.isArray(raw.tags) ? (raw.tags as VoiceReviewTag[]) : [],
        comment: (raw.comment as string) ?? "",
        reviewerId: (raw.reviewerId as string) ?? "",
        agentSnapshot: {
          bibleVersion: snapAgent?.bibleVersion ?? "",
          modelId: snapAgent?.modelId ?? "",
        },
        createdAt: tsToIso(raw.createdAt),
      })
    })
  )

  // Fetch prior user turn per session — minimal query: per session, find
  // role==user with createdAt < turn.createdAt order desc limit 1.
  const priorByMessage = new Map<string, string | null>()
  await Promise.all(
    turns.map(async (t) => {
      if (!t.sessionId || !t.createdAt) {
        priorByMessage.set(t.messageId, null)
        return
      }
      const priorQ = db.collection(MESSAGES) as unknown as {
        where: (field: string, op: string, val: unknown) => typeof priorQ
        orderBy: (field: string, dir: "desc" | "asc") => typeof priorQ
        limit: (n: number) => typeof priorQ
        get: () => Promise<{ docs: Array<{ data: () => Record<string, unknown> }> }>
      }
      const snap = await priorQ
        .where("sessionId", "==", t.sessionId)
        .where("role", "==", "user")
        .where("createdAt", "<", t.createdAt)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get()
      if (snap.docs.length === 0) {
        priorByMessage.set(t.messageId, null)
        return
      }
      const raw = snap.docs[0]!.data() as Record<string, unknown>
      priorByMessage.set(t.messageId, (raw.body as string) ?? null)
    })
  )

  const lastTurn = turns[turns.length - 1]
  const nextCursor = lastTurn?.createdAt ?? null

  return turns.map((t) => ({
    messageId: t.messageId,
    sessionId: t.sessionId,
    userId: t.userId,
    body: t.body,
    createdAt: t.createdAt,
    priorUserBody: priorByMessage.get(t.messageId) ?? null,
    reviewed: reviewsById.has(t.messageId),
    review: reviewsById.get(t.messageId) ?? null,
    nextCursor,
  }))
}
