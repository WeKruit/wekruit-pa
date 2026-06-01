/**
 * pa-pending-outbound queue writer — pure CRUD over the human-approve-then-send
 * outbound queue. This module NEVER sends anything; it only validates and
 * persists queue rows and reads them back for the dashboard API. A separate
 * approved-send worker (outside this contract) consumes `approved` rows.
 *
 * Idempotency: `enqueuePendingOutbound` writes to a deterministic doc id
 * (`pending-<userId>-<reasonCode>-<sourceSessionId|short>`) so re-running a
 * backfill never creates duplicate queue rows — the same logical message
 * overwrites the same doc.
 *
 * Storage: `PA_COLLECTIONS.pendingOutbound`.
 */

import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  PendingOutboundSchema,
  pendingOutboundDocId,
  type PendingOutbound,
  type PendingOutboundStatus,
} from "@pa/core-types"

/**
 * Input accepted by `enqueuePendingOutbound`. Mirrors `PendingOutbound` but:
 *  - `id` is derived from the deterministic key (never supplied by callers),
 *  - fields with sensible defaults may be omitted.
 *
 * Defaults applied:
 *  - `channel`     → "imessage"
 *  - `status`      → "pending"
 *  - `suppressed`  → false
 *  - `version`     → 1
 *  - `createdAt`   → now (ISO) unless provided
 *  - nullable lifecycle fields (`approvedBy`/`approvedAt`/`sentAt`/`sendError`,
 *    `suppressedReason`, `toE164`, `sourceSessionId`, `enrichmentSnapshot`)
 *    → null unless provided
 */
export type EnqueuePendingOutboundInput = Omit<
  PendingOutbound,
  | "id"
  | "channel"
  | "status"
  | "suppressed"
  | "version"
  | "createdAt"
  | "toE164"
  | "sourceSessionId"
  | "enrichmentSnapshot"
  | "suppressedReason"
  | "approvedBy"
  | "approvedAt"
  | "sentAt"
  | "sendError"
> & {
  channel?: PendingOutbound["channel"]
  status?: PendingOutbound["status"]
  suppressed?: boolean
  version?: number
  createdAt?: string
  toE164?: string | null
  sourceSessionId?: string | null
  enrichmentSnapshot?: Record<string, unknown> | null
  suppressedReason?: string | null
  approvedBy?: string | null
  approvedAt?: string | null
  sentAt?: string | null
  sendError?: string | null
}

export interface EnqueuePendingOutboundResult {
  /** Deterministic doc id the row was written to. */
  id: string
  /** True when an existing row at this id was overwritten (idempotent re-run). */
  idempotent: boolean
  /** The validated, persisted document. */
  doc: PendingOutbound
}

/**
 * Validate + write a queued outbound message to `pa-pending-outbound` using a
 * deterministic doc id. Idempotent: re-running with the same
 * `(userId, reasonCode, sourceSessionId)` overwrites the same doc rather than
 * creating a duplicate. NEVER sends anything.
 */
export async function enqueuePendingOutbound(
  db: Firestore,
  input: EnqueuePendingOutboundInput,
  opts: { now?: () => string } = {}
): Promise<EnqueuePendingOutboundResult> {
  const now = opts.now ?? (() => new Date().toISOString())

  const id = pendingOutboundDocId({
    userId: input.userId,
    reasonCode: input.reasonCode,
    sourceSessionId: input.sourceSessionId ?? null,
  })

  const candidate: PendingOutbound = {
    id,
    userId: input.userId,
    toE164: input.toE164 ?? null,
    channel: input.channel ?? "imessage",
    kind: input.kind,
    draftBody: input.draftBody,
    whyQueued: input.whyQueued,
    reasonCode: input.reasonCode,
    sourceSessionId: input.sourceSessionId ?? null,
    enrichmentSnapshot: input.enrichmentSnapshot ?? null,
    status: input.status ?? "pending",
    suppressed: input.suppressed ?? false,
    suppressedReason: input.suppressedReason ?? null,
    createdAt: input.createdAt ?? now(),
    approvedBy: input.approvedBy ?? null,
    approvedAt: input.approvedAt ?? null,
    sentAt: input.sentAt ?? null,
    sendError: input.sendError ?? null,
    version: input.version ?? 1,
  }

  // Validate against the canonical contract before any write.
  const doc = PendingOutboundSchema.parse(candidate)

  const ref = db.collection(PA_COLLECTIONS.pendingOutbound).doc(id)
  const existing = await ref.get()
  const idempotent = existing.exists

  await ref.set(doc)

  return { id, idempotent, doc }
}

export interface ListPendingOptions {
  /**
   * Filter by lifecycle status. Defaults to "pending" (the dashboard review
   * queue). Pass `null` to return all rows regardless of status.
   */
  status?: PendingOutboundStatus | null
  /** Max rows to return. */
  limit?: number
}

/**
 * Read queue rows for the dashboard API. Filters by `status` (default
 * "pending"); pass `status: null` for all rows. Pure read — no mutation.
 */
export async function listPending(
  db: Firestore,
  options: ListPendingOptions = {}
): Promise<PendingOutbound[]> {
  const status = options.status === undefined ? "pending" : options.status

  const col = db.collection(PA_COLLECTIONS.pendingOutbound)
  let query: FirebaseFirestore.Query = col
  if (status !== null) {
    query = col.where("status", "==", status)
  }
  if (typeof options.limit === "number") {
    query = query.limit(options.limit)
  }

  const snap = await query.get()
  const rows: PendingOutbound[] = []
  for (const docSnap of snap.docs) {
    const parsed = PendingOutboundSchema.safeParse(docSnap.data())
    if (parsed.success) rows.push(parsed.data)
  }
  return rows
}
