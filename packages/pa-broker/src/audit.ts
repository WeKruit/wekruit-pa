import { randomUUID } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, type AuditEventKind, type PaAuditEvent } from "@pa/core-types"

const AUDIT = PA_COLLECTIONS.auditEvents

export async function appendAuditEvent(
  db: Firestore,
  input: Omit<PaAuditEvent, "id" | "createdAt" | "actor"> & { id?: string; actor?: PaAuditEvent["actor"] }
): Promise<PaAuditEvent> {
  const id = input.id ?? randomUUID()
  const createdAt = new Date().toISOString()
  const row: PaAuditEvent = {
    id,
    createdAt,
    kind: input.kind,
    actor: input.actor ?? "system",
    userId: input.userId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    inboundEventId: input.inboundEventId,
    toolCallId: input.toolCallId,
    message: input.message,
    meta: input.meta,
  }
  await db.collection(AUDIT).doc(id).set(row)
  return row
}

export async function logToolAudit(
  db: Firestore,
  kind: AuditEventKind,
  msg: string,
  meta?: Record<string, unknown>
) {
  return appendAuditEvent(db, { kind, message: msg, meta, actor: "system" })
}
