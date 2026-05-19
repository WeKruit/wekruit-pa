import type { Firestore, Query } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  PracticeQuestionBankItemSchema,
  type PracticeConversationMode,
  type PracticeQuestionBankItem,
  type PracticeQuestionKind,
  type PracticeQuestionStatus,
} from "@pa/core-types"

export interface ListPracticeQuestionsInput {
  status?: PracticeQuestionStatus
  kind?: PracticeQuestionKind
  conversationMode?: PracticeConversationMode
  tags?: string[]
  limit?: number
}

const COLLECTION = PA_COLLECTIONS.practiceQuestionBank
const CLIENT_FILTER_SCAN_LIMIT = 1000

function parseQuestion(data: unknown): PracticeQuestionBankItem | null {
  const parsed = PracticeQuestionBankItemSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

function boundedLimit(limit: number | undefined): number {
  if (!limit) return 50
  return Math.max(1, Math.min(200, Math.floor(limit)))
}

export async function getPracticeQuestion(
  db: Firestore,
  id: string,
): Promise<PracticeQuestionBankItem | null> {
  const snap = await db.collection(COLLECTION).doc(id).get()
  if (!snap.exists) return null
  return parseQuestion(snap.data())
}

export async function listPracticeQuestions(
  db: Firestore,
  input: ListPracticeQuestionsInput = {},
): Promise<PracticeQuestionBankItem[]> {
  let q: Query = db
    .collection(COLLECTION)
    .where("status", "==", input.status ?? "active")
  if (input.kind) q = q.where("kind", "==", input.kind)
  const outputLimit = boundedLimit(input.limit)
  const needsClientFilter = Boolean(input.conversationMode || (input.tags && input.tags.length > 0))
  const snap = await q.limit(needsClientFilter ? CLIENT_FILTER_SCAN_LIMIT : outputLimit).get()
  let rows = snap.docs
    .map((doc) => parseQuestion(doc.data()))
    .filter((row): row is PracticeQuestionBankItem => row !== null)

  if (input.conversationMode) {
    rows = rows.filter((row) => row.conversationMode === input.conversationMode)
  }
  if (input.tags && input.tags.length > 0) {
    const wanted = new Set(input.tags.map((tag) => tag.toLowerCase()))
    rows = rows.filter((row) =>
      [...row.tags, ...row.categories, ...row.keyConcepts].some((tag) =>
        wanted.has(tag.toLowerCase()),
      ),
    )
  }
  return rows.slice(0, outputLimit)
}
