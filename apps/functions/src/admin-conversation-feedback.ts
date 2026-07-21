/**
 * admin-conversation-feedback.ts — `paAdminConversationFeedback` admin callable.
 *
 * Returns the candidate conversations classified by paConversationSentimentScan,
 * default-filtered to the unhappy ones, sorted by severity (very_negative first),
 * with optional category / sentiment filters. Each returned row carries the full
 * candidate↔Claire transcript (read from pa-messages) for the dashboard's
 * master-detail transcript preview pane.
 *
 * Admin-only (authorizeAdminCallable, mirrors paAdminPrescreenOpsSnapshot).
 */
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { onCall } from "firebase-functions/v2/https"
import {
  PA_COLLECTIONS,
  conversationSentimentRank,
  type ConversationFeedbackInput,
  type ConversationFeedbackResponse,
  type ConversationFeedbackRow,
  type ConversationSentiment,
  type ConversationSentimentCategory,
  type ConversationSentimentDoc,
  type ConversationSentimentMessage,
} from "@pa/core-types"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

const SENTIMENT = PA_COLLECTIONS.conversationSentiment
const MESSAGES = PA_COLLECTIONS.messages

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 300
const TRANSCRIPT_CAP = 80

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

/** Load the last-N messages for a candidate (chronological) for the preview pane. */
async function loadTranscript(db: Firestore, userId: string): Promise<ConversationSentimentMessage[]> {
  try {
    const snap = await db
      .collection(MESSAGES)
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(TRANSCRIPT_CAP)
      .get()
    const msgs = snap.docs
      .map((d) => {
        const data = d.data() as Record<string, unknown>
        const body = str(data.body) || str(data.text) || str(data.content)
        if (!body) return null
        const createdAt =
          str(data.createdAt) ||
          (data.createdAt as { toDate?: () => Date } | undefined)?.toDate?.()?.toISOString?.() ||
          ""
        const m: ConversationSentimentMessage = {
          role: data.role === "assistant" ? "assistant" : "user",
          body,
          ...(createdAt ? { createdAt } : {}),
        }
        return m
      })
      .filter((m): m is ConversationSentimentMessage => m !== null)
    return msgs.reverse()
  } catch {
    return []
  }
}

export async function runAdminConversationFeedback(
  raw: unknown,
  deps: { db: Firestore; now?: () => string },
): Promise<ConversationFeedbackResponse> {
  const input = (raw ?? {}) as ConversationFeedbackInput
  const unhappyOnly = input.unhappyOnly !== false
  const limit = Math.max(1, Math.min(MAX_LIMIT, input.limit ?? DEFAULT_LIMIT))
  const categoryFilter = str(input.category) as ConversationSentimentCategory | ""
  const sentimentFilter = str(input.sentiment) as ConversationSentiment | ""

  // Read the collection (one doc per candidate). Volume is bounded (≤ all
  // candidates with conversations in the window), so a full scan + in-memory
  // sort keeps the query simple and avoids a composite index.
  const snap = await deps.db.collection(SENTIMENT).get()
  const all = snap.docs.map((d) => d.data() as ConversationSentimentDoc)

  // byCategory is computed across the UNHAPPY set so the top-strip chips reflect
  // the actionable buckets regardless of the current filter.
  const byCategory: Record<string, number> = {}
  for (const doc of all) {
    if (!doc.unhappy) continue
    byCategory[doc.category] = (byCategory[doc.category] ?? 0) + 1
  }

  let filtered = all
  if (unhappyOnly) filtered = filtered.filter((d) => d.unhappy)
  if (categoryFilter) filtered = filtered.filter((d) => d.category === categoryFilter)
  if (sentimentFilter) filtered = filtered.filter((d) => d.sentiment === sentimentFilter)

  filtered.sort((a, b) => {
    const rank = conversationSentimentRank(a.sentiment) - conversationSentimentRank(b.sentiment)
    if (rank !== 0) return rank
    return str(b.lastMessageAt || b.classifiedAt).localeCompare(str(a.lastMessageAt || a.classifiedAt))
  })

  const bySentiment: Record<string, number> = {}
  for (const doc of filtered) {
    bySentiment[doc.sentiment] = (bySentiment[doc.sentiment] ?? 0) + 1
  }

  const page = filtered.slice(0, limit)
  const rows: ConversationFeedbackRow[] = await Promise.all(
    page.map(async (doc) => ({
      ...doc,
      transcript: await loadTranscript(deps.db, doc.userId),
    })),
  )

  return {
    generatedAt: deps.now?.() ?? new Date().toISOString(),
    byCategory,
    bySentiment,
    rows,
  }
}

export const paAdminConversationFeedback = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 120, maxInstances: 1, secrets: [PA_ADMIN_TOKEN] },
  async (req): Promise<ConversationFeedbackResponse> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    return runAdminConversationFeedback(req.data, { db: getFirestore() })
  },
)
