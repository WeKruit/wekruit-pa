/**
 * Client wrapper for the `paPendingOutboundAdmin` callable backing the
 * `/admin/pending-outbound` page (batch human-approve-then-send queue).
 *
 * Mirrors `lib/launch-readiness-api.ts`: a thin typed shim that lazy-imports
 * the firebase functions client and calls a single dispatching callable.
 *
 * SAFETY: `sendPendingOutbound` is the only outward-facing call. Server-side
 * it is GATED (approved-only, suppression hard-block, live opt-out re-check)
 * and the live Sendblue dispatch seam is intentionally NOT wired yet, so a
 * `send` returns `{ blocked:true, reason:"send_not_wired" }` rather than
 * dispatching. The UI must surface that, never assume a send happened.
 */
import { httpsCallable } from "firebase/functions"

export const PENDING_OUTBOUND_ROUTE = "/admin/pending-outbound"
export const PENDING_OUTBOUND_CALLABLE = "paPendingOutboundAdmin"

export type PendingOutboundStatus =
  | "pending"
  | "approved"
  | "sent"
  | "skipped"
  | "failed"

export type PendingOutboundChannel = "imessage" | "sms"
export type PendingOutboundKind = "recovery" | "ai_review" | "rec" | "reengage"

export interface PendingOutboundRow {
  id: string
  userId: string
  toE164: string | null
  channel: PendingOutboundChannel
  kind: PendingOutboundKind
  draftBody: string
  whyQueued: string
  reasonCode: string
  sourceSessionId: string | null
  enrichmentSnapshot: Record<string, unknown> | null
  status: PendingOutboundStatus
  suppressed: boolean
  suppressedReason: string | null
  createdAt: string
  approvedBy: string | null
  approvedAt: string | null
  sentAt: string | null
  sendError: string | null
  version: number
}

export interface SendOutcome {
  id: string
  ok: boolean
  blocked: boolean
  reason: string
  row: PendingOutboundRow
}

async function call<I extends { action: string }, O>(input: I): Promise<O> {
  const { functions } = await import("./firebase.js")
  const fn = httpsCallable<I, O>(functions(), PENDING_OUTBOUND_CALLABLE)
  const res = await fn(input)
  return res.data
}

export async function listPendingOutbound(
  status: PendingOutboundStatus | null = "pending",
  limit = 200
): Promise<PendingOutboundRow[]> {
  const data = await call<
    { action: "list"; status: PendingOutboundStatus | null; limit: number },
    { rows?: PendingOutboundRow[] }
  >({ action: "list", status, limit })
  return data.rows ?? []
}

export async function updatePendingOutboundDraft(
  id: string,
  draftBody: string
): Promise<PendingOutboundRow> {
  const data = await call<
    { action: "update"; id: string; draftBody: string },
    { doc: PendingOutboundRow }
  >({ action: "update", id, draftBody })
  return data.doc
}

export async function approvePendingOutbound(
  id: string
): Promise<PendingOutboundRow> {
  const data = await call<
    { action: "approve"; id: string },
    { doc: PendingOutboundRow }
  >({ action: "approve", id })
  return data.doc
}

export async function skipPendingOutbound(
  id: string
): Promise<PendingOutboundRow> {
  const data = await call<
    { action: "skip"; id: string },
    { doc: PendingOutboundRow }
  >({ action: "skip", id })
  return data.doc
}

/**
 * GATED send. Server may decline (blocked) without dispatching. The caller
 * MUST inspect `ok` / `blocked` / `reason` and never assume delivery.
 */
export async function sendPendingOutbound(id: string): Promise<SendOutcome> {
  const data = await call<
    { action: "send"; id: string },
    { ok?: boolean; blocked?: boolean; reason?: string; doc: PendingOutboundRow }
  >({ action: "send", id })
  return {
    id,
    ok: Boolean(data.ok),
    blocked: Boolean(data.blocked),
    reason: data.reason ?? "unknown",
    row: data.doc,
  }
}
