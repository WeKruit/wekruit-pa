import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, type OutboundMessage } from "@pa/core-types"

const OUT = PA_COLLECTIONS.outbound

export type EnqueueOutboundInput = {
  userId: string
  toE164: string
  fromNumber?: string
  imessageChatId?: string
  body: string
  /**
   * Optional image attachment URL. When present the Sendblue outbox sends the
   * row as an iMessage image attachment (rec-card path) with `body` as the
   * caption. Omitted → text-only send, unchanged.
   */
  mediaUrl?: string
  idempotencyKey: string
  runtimeApproved?: true
  runtimeSource?: string
}

const APPROVED_RUNTIME_SOURCES = new Set([
  "pa_orchestrator",
  "pa_prescreen_runtime",
  "pa_pii_runtime",
  "pa_identity_notice",
  "pa_operator_review",
  "test_runtime",
])

export function outboundMessageDocId(idempotencyKey: string): string {
  const h = createHash("sha256").update(idempotencyKey, "utf8").digest("hex")
  return `out_${h.slice(0, 40)}`
}

export function isApprovedRuntimeSource(source: unknown): boolean {
  return typeof source === "string" && APPROVED_RUNTIME_SOURCES.has(source)
}

/**
 * Idempotent outbound enqueue: duplicate idempotencyKey returns the same row.
 */
export async function enqueueOutbound(
  db: Firestore,
  input: EnqueueOutboundInput
): Promise<{ id: string; created: boolean }> {
  if (input.runtimeApproved !== true) {
    throw new Error("outbound_requires_runtime_approval")
  }
  if (!isApprovedRuntimeSource(input.runtimeSource)) {
    throw new Error("outbound_requires_approved_runtime_source")
  }
  const id = outboundMessageDocId(input.idempotencyKey)
  const ref = db.collection(OUT).doc(id)
  const now = new Date().toISOString()
  const doc: OutboundMessage = {
    id,
    userId: input.userId,
    toE164: input.toE164,
    ...(input.fromNumber ? { fromNumber: input.fromNumber } : {}),
    ...(input.imessageChatId ? { imessageChatId: input.imessageChatId } : {}),
    body: input.body,
    ...(input.mediaUrl ? { mediaUrl: input.mediaUrl } : {}),
    status: "pending",
    createdAt: now,
    idempotencyKey: input.idempotencyKey,
    runtimeApproved: true,
    runtimeSource: input.runtimeSource,
    source: input.runtimeSource,
  }
  try {
    await ref.create(doc)
    return { id, created: true }
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 6) return { id, created: false }
    throw e
  }
}
