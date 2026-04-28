/**
 * Phase 25 T2 — dashboard Firestore client for pa_voice_reviews + assistant
 * turn listing. Mirrors the pattern in `flags-api.ts`: direct Firestore SDK
 * calls (the @pa/pa-persistence helpers in T1 are firebase-admin and live
 * on the server — this file is the browser counterpart).
 *
 * LOCKED schema (CONTEXT.md):
 *   pa_voice_reviews/{messageId}: { messageId, rating, tags[], comment,
 *     reviewerId, agentSnapshot{bibleVersion,modelId}, createdAt: Timestamp }
 */
import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  where,
  type QueryConstraint,
} from "firebase/firestore"
import { auth, db } from "./firebase.js"

export const VOICE_REVIEWS_COLLECTION = "pa_voice_reviews"
export const MESSAGES_COLLECTION = "pa_messages"

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

export type AgentSnapshot = {
  bibleVersion: string
  modelId: string
}

export type VoiceReview = {
  messageId: string
  rating: VoiceRating
  tags: VoiceReviewTag[]
  comment: string
  reviewerId: string
  agentSnapshot: AgentSnapshot
  createdAt: string | null
}

export type PriorTurn = {
  role: "user" | "assistant"
  body: string
  createdAt: string | null
  messageId: string
}

export type AssistantTurn = {
  messageId: string
  sessionId: string
  userId: string
  body: string
  createdAt: string | null
  /**
   * Conversation thread leading up to this assistant turn.
   * Up to 6 prior messages (any role) in the same session, ordered
   * oldest → newest so render flows top-to-bottom like a chat UI.
   */
  priorTurns: PriorTurn[]
  reviewed: boolean
  review: VoiceReview | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tsToIso(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Timestamp) return value.toDate().toISOString()
  if (typeof value === "string") return value
  if (
    typeof value === "object" &&
    value !== null &&
    "seconds" in (value as Record<string, unknown>)
  ) {
    const seconds = Number((value as { seconds: unknown }).seconds)
    if (Number.isFinite(seconds)) return new Date(seconds * 1000).toISOString()
  }
  return null
}

function currentReviewerId(): string {
  const u = auth().currentUser
  return u?.email ?? u?.uid ?? "unknown"
}

function reviewFromSnap(id: string, raw: Record<string, unknown>): VoiceReview {
  const snapAgent = (raw.agentSnapshot as AgentSnapshot | undefined) ?? {
    bibleVersion: "",
    modelId: "",
  }
  return {
    messageId: (raw.messageId as string) ?? id,
    rating: (raw.rating as VoiceRating) ?? 3,
    tags: Array.isArray(raw.tags) ? (raw.tags as VoiceReviewTag[]) : [],
    comment: (raw.comment as string) ?? "",
    reviewerId: (raw.reviewerId as string) ?? "",
    agentSnapshot: {
      bibleVersion: snapAgent.bibleVersion ?? "",
      modelId: snapAgent.modelId ?? "",
    },
    createdAt: tsToIso(raw.createdAt),
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * List assistant turns newest-first with LEFT-joined review state.
 * `cursor` is the createdAt ISO of the last row from the previous page.
 */
export async function listAssistantTurns(opts: {
  cursor?: string | null
  limit?: number
}): Promise<{ rows: AssistantTurn[]; nextCursor: string | null }> {
  const pageSize = opts.limit ?? 50
  const constraints: QueryConstraint[] = [
    where("role", "==", "assistant"),
    orderBy("createdAt", "desc"),
  ]
  if (opts.cursor) {
    constraints.push(startAfter(opts.cursor))
  }
  constraints.push(limit(pageSize))
  const turnsSnap = await getDocs(
    query(collection(db(), MESSAGES_COLLECTION), ...constraints)
  )

  const turns = turnsSnap.docs.map((d) => {
    const raw = d.data() as Record<string, unknown>
    return {
      messageId: (raw.id as string) ?? d.id,
      sessionId: (raw.sessionId as string) ?? "",
      userId: (raw.userId as string) ?? "",
      body: (raw.body as string) ?? "",
      createdAt: (raw.createdAt as string) ?? null,
    }
  })
  if (turns.length === 0) return { rows: [], nextCursor: null }

  // Per-row: fetch existing review (if any) + prior user turn for context.
  const rows: AssistantTurn[] = await Promise.all(
    turns.map(async (t) => {
      const reviewSnap = await getDoc(
        doc(db(), VOICE_REVIEWS_COLLECTION, t.messageId)
      )
      const review = reviewSnap.exists()
        ? reviewFromSnap(reviewSnap.id, reviewSnap.data() as Record<string, unknown>)
        : null

      let priorTurns: PriorTurn[] = []
      if (t.sessionId && t.createdAt) {
        // Fetch last 6 messages (any role) in this session before the rated
        // turn. Order desc (newest first) for the query, then reverse so the
        // caller renders oldest → newest like a chat thread.
        const priorSnap = await getDocs(
          query(
            collection(db(), MESSAGES_COLLECTION),
            where("sessionId", "==", t.sessionId),
            where("createdAt", "<", t.createdAt),
            orderBy("createdAt", "desc"),
            limit(6)
          )
        )
        priorTurns = priorSnap.docs
          .map((d) => {
            const raw = d.data() as Record<string, unknown>
            const role = raw.role === "assistant" ? "assistant" : "user"
            return {
              role: role as "user" | "assistant",
              body: (raw.body as string) ?? "",
              createdAt: (raw.createdAt as string) ?? null,
              messageId: (raw.id as string) ?? d.id,
            }
          })
          .reverse()
      }

      return {
        messageId: t.messageId,
        sessionId: t.sessionId,
        userId: t.userId,
        body: t.body,
        createdAt: t.createdAt,
        priorTurns,
        reviewed: review !== null,
        review,
      }
    })
  )

  const last = turns[turns.length - 1]
  return { rows, nextCursor: last?.createdAt ?? null }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type SaveVoiceReviewInput = {
  messageId: string
  rating: VoiceRating
  tags: VoiceReviewTag[]
  comment: string
  agentSnapshot: AgentSnapshot
}

const VALID_RATINGS = new Set<number>([1, 2, 3, 4, 5])
const VALID_TAGS = new Set<string>(VOICE_REVIEW_TAGS)

export async function saveVoiceReview(input: SaveVoiceReviewInput): Promise<void> {
  if (!input.messageId) throw new Error("messageId required")
  if (!VALID_RATINGS.has(input.rating)) {
    throw new Error(`rating must be 1..5 (got ${String(input.rating)})`)
  }
  for (const t of input.tags) {
    if (!VALID_TAGS.has(t)) {
      throw new Error(`invalid tag "${t}"`)
    }
  }
  const reviewerId = currentReviewerId()
  await setDoc(doc(db(), VOICE_REVIEWS_COLLECTION, input.messageId), {
    messageId: input.messageId,
    rating: input.rating,
    tags: Array.from(new Set(input.tags)),
    comment: input.comment,
    reviewerId,
    agentSnapshot: {
      bibleVersion: input.agentSnapshot.bibleVersion,
      modelId: input.agentSnapshot.modelId,
    },
    createdAt: serverTimestamp(),
  })
}

// ---------------------------------------------------------------------------
// localStorage drafts (R1 mitigation: drafts survive page reload)
// ---------------------------------------------------------------------------

const DRAFT_PREFIX = "pa.voice.draft."

export type ReviewDraft = {
  rating: VoiceRating | null
  tags: VoiceReviewTag[]
  comment: string
}

export function loadDraft(messageId: string): ReviewDraft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_PREFIX + messageId)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ReviewDraft>
    return {
      rating: (parsed.rating as VoiceRating | null) ?? null,
      tags: Array.isArray(parsed.tags)
        ? (parsed.tags.filter((t) => VALID_TAGS.has(t)) as VoiceReviewTag[])
        : [],
      comment: typeof parsed.comment === "string" ? parsed.comment : "",
    }
  } catch {
    return null
  }
}

export function saveDraft(messageId: string, draft: ReviewDraft): void {
  try {
    window.localStorage.setItem(DRAFT_PREFIX + messageId, JSON.stringify(draft))
  } catch {
    // ignore quota / private mode
  }
}

export function clearDraft(messageId: string): void {
  try {
    window.localStorage.removeItem(DRAFT_PREFIX + messageId)
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Default agentSnapshot for in-progress reviews. Real values should be
// populated from the assistant turn's metadata once that surfaces in
// pa_messages; for now we pin to the current Bible/model so reviews don't
// fail validation. Phase 27 reads this snapshot, so denormalization is
// CRITICAL — reviews keep historical accuracy across Bible churn.
// ---------------------------------------------------------------------------

export const DEFAULT_AGENT_SNAPSHOT: AgentSnapshot = {
  bibleVersion: "v7.0",
  modelId: "gpt-5.4-nano",
}
