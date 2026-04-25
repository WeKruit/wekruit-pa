import { randomUUID } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, type MemoryActionType, type MemoryFact, type ProcessingStatus } from "@pa/core-types"

function nowIso() {
  return new Date().toISOString()
}

export async function listConfirmedMemoryFacts(db: Firestore, userId: string): Promise<MemoryFact[]> {
  const snap = await db
    .collection(PA_COLLECTIONS.memoryFacts)
    .where("userId", "==", userId)
    .where("status", "==", "confirmed")
    .limit(200)
    .get()
  return snap.docs
    .map((d) => d.data() as MemoryFact)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function createConfirmedMemoryFact(
  db: Firestore,
  userId: string,
  content: string,
  source: MemoryFact["source"] = "explicit_user"
): Promise<string> {
  const id = randomUUID()
  const at = nowIso()
  const fact: MemoryFact = {
    id,
    userId,
    content,
    status: "confirmed",
    source,
    createdAt: at,
    updatedAt: at,
  }
  await db.collection(PA_COLLECTIONS.memoryFacts).doc(id).set(fact)
  return id
}

export async function markMemoryFactsDeleted(
  db: Firestore,
  userId: string,
  factIds: string[],
  eventId?: string
): Promise<void> {
  const batch = db.batch()
  const at = nowIso()
  for (const id of factIds) {
    batch.set(
      db.collection(PA_COLLECTIONS.memoryFacts).doc(id),
      { userId, status: "deleted", deletedAt: at, updatedAt: at, ...(eventId ? { deletedByEventId: eventId } : {}) },
      { merge: true }
    )
  }
  await batch.commit()
}

export async function recordMemoryAction(
  db: Firestore,
  input: {
    userId: string
    eventId?: string
    action: MemoryActionType
    status: ProcessingStatus
    content?: string
    factIds?: string[]
    reason?: string
  }
): Promise<void> {
  const id = randomUUID()
  await db.collection(PA_COLLECTIONS.memoryActions).doc(id).set({
    id,
    createdAt: nowIso(),
    ...input,
  })
}
