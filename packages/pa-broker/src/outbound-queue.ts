import { createHash } from "node:crypto"
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

export function outboundMessageDocId(idempotencyKey: string): string {
  const h = createHash("sha256").update(idempotencyKey, "utf8").digest("hex")
  return `out_${h.slice(0, 40)}`
}

/**
 * Idempotent outbound enqueue: duplicate idempotencyKey returns the same row.
 */
export async function enqueueOutbound(
  db: Firestore,
  input: EnqueueOutboundInput
): Promise<{ id: string; created: boolean }> {
  const id = outboundMessageDocId(input.idempotencyKey)
  const ref = db.collection(OUT).doc(id)
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
  try {
    await ref.create(doc)
    return { id, created: true }
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 6) return { id, created: false }
    throw e
  }
}
