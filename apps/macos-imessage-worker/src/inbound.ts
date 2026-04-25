import type { Message } from "@photon-ai/imessage-kit"
import { PA_COLLECTIONS, type InboundEvent } from "@pa/core-types"
import type { Firestore } from "firebase-admin/firestore"

function safeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120)
}

export function buildInboundEventFromMessage(input: {
  msg: Message
  userId: string
  sessionId: string
  externalChatId: string
  createdAt?: string
}): InboundEvent {
  const guid = input.msg.id || String(input.msg.rowId)
  const id = `imessage-${safeIdPart(guid)}`
  return {
    id,
    userId: input.userId,
    sessionId: input.sessionId,
    channel: "imessage",
    externalChatId: input.externalChatId,
    from: input.msg.participant || "",
    body: input.msg.text?.trim() ?? "",
    status: "pending",
    createdAt: input.createdAt ?? new Date().toISOString(),
    idempotencyKey: `imessage-in-${guid}`,
    rawMeta: {
      source: "imessage",
      messageRowId: input.msg.rowId,
      messageGuid: guid,
    },
  }
}

export async function enqueueInboundEvent(db: Firestore, event: InboundEvent): Promise<boolean> {
  const ref = db.collection(PA_COLLECTIONS.inboundEvents).doc(event.id)
  const created = await db.runTransaction(async (tx) => {
    const existing = await tx.get(ref)
    if (existing.exists) return false
    tx.set(ref, event)
    return true
  })
  return created
}
