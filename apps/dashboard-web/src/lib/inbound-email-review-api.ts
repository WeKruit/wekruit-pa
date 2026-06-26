/**
 * Callable wrappers for the inbound-email HITL surfaces
 * (apps/functions/src/admin-inbound-email-review.ts):
 *   - paAdminInboundEmailDrafts     — pending auto-reply drafts awaiting approval
 *   - paAdminSendInboundEmailDraft  — approve+send (or edit-then-send) / dismiss
 *   - paAdminInboundUnmatchedList   — the unmatched dead-letter queue
 * Backs /admin/email-review.
 */
import { httpsCallable } from "firebase/functions"
import { functions } from "./firebase.js"

export interface InboundEmailDraftRow {
  id: string
  convToken?: string
  userId?: string
  jobId?: string
  candidateEmail?: string
  inboundSubject?: string
  inboundPreview?: string
  replySubject?: string
  replyBody?: string
  status?: string
  createdAt: string
  decidedAt?: string
  decidedBy?: string
}

export interface InboundEmailDraftsResult {
  rows: InboundEmailDraftRow[]
  counts: { pending_review: number; sent: number; dismissed: number; total: number }
  truncated: boolean
  generatedAt: string
}

export async function getInboundEmailDrafts(
  status: "pending_review" | "sent" | "dismissed" | "all" = "pending_review",
): Promise<InboundEmailDraftsResult> {
  const fn = httpsCallable<{ status?: string }, InboundEmailDraftsResult>(functions(), "paAdminInboundEmailDrafts")
  const res = await fn({ status })
  return res.data
}

export interface SendInboundEmailDraftInput {
  draftId: string
  action: "approve_send" | "dismiss"
  editedBody?: string
  note?: string
}

export interface SendInboundEmailDraftResult {
  ok: boolean
  draftId: string
  action: "approve_send" | "dismiss"
  sent?: boolean
  status: string
  reason?: string
}

export async function sendInboundEmailDraft(
  input: SendInboundEmailDraftInput,
): Promise<SendInboundEmailDraftResult> {
  const fn = httpsCallable<SendInboundEmailDraftInput, SendInboundEmailDraftResult>(
    functions(),
    "paAdminSendInboundEmailDraft",
  )
  const res = await fn(input)
  return res.data
}

export interface InboundUnmatchedRow {
  id: string
  recipient?: string
  sender?: string
  subject?: string
  reason?: string
  convToken?: string
  inboundTextPreview?: string
  messageId?: string
  createdAt: string
  resolutionStatus?: string
}

export interface InboundUnmatchedListResult {
  rows: InboundUnmatchedRow[]
  counts: { no_conv_token: number; thread_not_found: number; sensitive_topic_hitl: number; other: number; total: number }
  truncated: boolean
  generatedAt: string
}

export async function getInboundUnmatchedList(): Promise<InboundUnmatchedListResult> {
  const fn = httpsCallable<Record<string, never>, InboundUnmatchedListResult>(
    functions(),
    "paAdminInboundUnmatchedList",
  )
  const res = await fn({})
  return res.data
}
