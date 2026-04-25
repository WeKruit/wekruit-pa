import { randomUUID } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, type OutboundMessage } from "@pa/core-types"

const OUT = PA_COLLECTIONS.outbound

export type EnqueueOutboundInput = {
  userId: string
  toE164: string
  imessageChatId?: string
  body: string
  idempotencyKey: string
}

/**
 * Idempotent outbound enqueue: duplicate idempotencyKey returns existing pending/sent doc.
 */
export async function enqueueOutbound(
  db: Firestore,
  input: EnqueueOutboundInput
): Promise<{ id: string; created: boolean }> {
  const existing = await db
    .collection(OUT)
    .where("idempotencyKey", "==", input.idempotencyKey)
    .limit(1)
    .get()
  if (!existing.empty) {
    return { id: existing.docs[0]!.id, created: false }
  }

  const id = randomUUID()
  const now = new Date().toISOString()
  const doc: OutboundMessage = {
    id,
    userId: input.userId,
    toE164: input.toE164,
    ...(input.imessageChatId ? { imessageChatId: input.imessageChatId } : {}),
    body: input.body,
    status: "pending",
    createdAt: now,
    idempotencyKey: input.idempotencyKey,
  }
  await db.collection(OUT).doc(id).set(doc)
  return { id, created: true }
}
