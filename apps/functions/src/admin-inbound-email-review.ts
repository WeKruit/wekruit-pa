/**
 * admin-inbound-email-review.ts — HITL surfaces for inbound candidate email.
 *
 * Closes the unsupervised-auto-reply gap: the inbound webhook now records the
 * LLM-composed reply as a DRAFT (`pa-inbound-email-drafts/{id}`, status
 * "pending_review") instead of auto-sending. These callables let an operator
 * review, edit, approve+send, or dismiss those drafts, and surface the
 * unmatched dead-letter queue (replies that couldn't be mapped to a thread —
 * the comp/visa/STOP replies that most need a human).
 *
 *   - paAdminInboundEmailDrafts        → list pending (+ recently-acted) drafts
 *   - paAdminSendInboundEmailDraft      → approve+send (or edit-then-send) /
 *                                         dismiss a single draft
 *   - paAdminInboundUnmatchedList       → list pa-inbound-emails-unmatched
 *
 * All admin-gated (authorizeAdminCallable + PA_ADMIN_TOKEN). The send path
 * reuses the canonical Mailgun transport with the SAME verpReplyToAddress +
 * In-Reply-To headers the auto-send path used, so threading is preserved.
 * Every approve writes an auditable adminDecision { by, at } — the HITL
 * correction event the v2.0 mandate requires.
 */
import { FieldValue, getFirestore, type Firestore, type Query } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { z } from "zod"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"
import { sendMailgun, type MailgunConfig } from "./email/mailgun.js"
import { EMAIL_THREADS_COLLECTION } from "./email/email-thread.js"

const MAILGUN_API_KEY = defineSecret("MAILGUN_API_KEY")
const MAILGUN_DOMAIN = defineSecret("MAILGUN_DOMAIN")
const MAILGUN_FROM = defineSecret("MAILGUN_FROM")
const MAILGUN_REGION = defineSecret("MAILGUN_REGION")
const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

const DRAFTS_COLLECTION = "pa-inbound-email-drafts"
const UNMATCHED_COLLECTION = "pa-inbound-emails-unmatched"
const HEADHUNTER_EMAILS_COLLECTION = "pa-headhunter-emails"

const SCAN_BATCH_SIZE = 200
const SCAN_CAP = 1_000
const REPLY_BODY_MAX = 8_000

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function mailgunConfigFromEnv(): MailgunConfig | null {
  const apiKey = process.env.MAILGUN_API_KEY ?? ""
  const domain = process.env.MAILGUN_DOMAIN ?? ""
  if (!apiKey || !domain) return null
  const from = process.env.MAILGUN_FROM ?? `WeKruit Claire <claire@${domain}>`
  const region = (process.env.MAILGUN_REGION === "eu" ? "eu" : "us") as "us" | "eu"
  return { apiKey, domain, from, region }
}

function toIso(value: unknown): string {
  if (!value) return ""
  if (typeof value === "object" && value !== null && typeof (value as { toDate?: unknown }).toDate === "function") {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString()
    } catch {
      return ""
    }
  }
  if (typeof value === "object" && value !== null && typeof (value as { seconds?: unknown }).seconds === "number") {
    return new Date((value as { seconds: number }).seconds * 1000).toISOString()
  }
  if (typeof value === "string") {
    const t = Date.parse(value)
    return Number.isNaN(t) ? "" : new Date(t).toISOString()
  }
  return ""
}

/** Batched scan of a collection ordered by createdAt desc (best-effort). */
async function scanCollection(
  db: Firestore,
  collection: string,
): Promise<{ rows: Array<{ id: string; data: Record<string, unknown> }>; truncated: boolean }> {
  const rows: Array<{ id: string; data: Record<string, unknown> }> = []
  let cursor: unknown | undefined
  let truncated = false
  for (;;) {
    let query: Query = db.collection(collection).orderBy("createdAt", "desc").limit(SCAN_BATCH_SIZE)
    if (cursor !== undefined) query = query.startAfter(cursor)
    const snap = await query.get().catch(() => null)
    if (!snap) break
    for (const doc of snap.docs) {
      rows.push({ id: doc.id, data: (doc.data() ?? {}) as Record<string, unknown> })
    }
    if (snap.docs.length < SCAN_BATCH_SIZE) break
    if (rows.length >= SCAN_CAP) {
      truncated = true
      break
    }
    cursor = (snap.docs[snap.docs.length - 1]!.data() ?? {}).createdAt
    if (cursor === undefined) break
  }
  return { rows: rows.slice(0, SCAN_CAP), truncated }
}

// ───────────────────────────────────────────────────────────────────────────
// LIST DRAFTS
// ───────────────────────────────────────────────────────────────────────────

export const AdminInboundEmailDraftsInputSchema = z.object({
  status: z.enum(["pending_review", "sent", "dismissed", "all"]).optional(),
  adminToken: z.string().optional(),
})
export type AdminInboundEmailDraftsInput = z.infer<typeof AdminInboundEmailDraftsInputSchema>

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

export interface AdminInboundEmailDraftsResult {
  rows: InboundEmailDraftRow[]
  counts: { pending_review: number; sent: number; dismissed: number; total: number }
  truncated: boolean
  generatedAt: string
}

export async function runAdminInboundEmailDrafts(
  raw: unknown,
  deps: { db: Firestore; now?: () => string },
): Promise<AdminInboundEmailDraftsResult> {
  const parsed = AdminInboundEmailDraftsInputSchema.safeParse(raw)
  if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
  const wantStatus = parsed.data.status ?? "pending_review"
  const { rows: scanned, truncated } = await scanCollection(deps.db, DRAFTS_COLLECTION)

  const counts = { pending_review: 0, sent: 0, dismissed: 0, total: 0 }
  const rows: InboundEmailDraftRow[] = []
  for (const { id, data } of scanned) {
    const status = cleanString(data.status) ?? "pending_review"
    if (status === "pending_review") counts.pending_review += 1
    else if (status === "sent") counts.sent += 1
    else if (status === "dismissed") counts.dismissed += 1
    counts.total += 1
    if (wantStatus !== "all" && status !== wantStatus) continue
    const decision =
      data.adminDecision && typeof data.adminDecision === "object" ? (data.adminDecision as Record<string, unknown>) : null
    rows.push({
      id,
      ...(cleanString(data.convToken) ? { convToken: cleanString(data.convToken) } : {}),
      ...(cleanString(data.userId) ? { userId: cleanString(data.userId) } : {}),
      ...(cleanString(data.jobId) ? { jobId: cleanString(data.jobId) } : {}),
      ...(cleanString(data.candidateEmail) ? { candidateEmail: cleanString(data.candidateEmail) } : {}),
      ...(cleanString(data.inboundSubject) ? { inboundSubject: cleanString(data.inboundSubject) } : {}),
      ...(cleanString(data.inboundPreview) ? { inboundPreview: cleanString(data.inboundPreview) } : {}),
      ...(cleanString(data.replySubject) ? { replySubject: cleanString(data.replySubject) } : {}),
      ...(cleanString(data.replyBody) ? { replyBody: cleanString(data.replyBody) } : {}),
      status,
      createdAt: toIso(data.createdAt),
      ...(decision && cleanString(decision.at) ? { decidedAt: cleanString(decision.at) } : {}),
      ...(decision && cleanString(decision.by) ? { decidedBy: cleanString(decision.by) } : {}),
    })
  }
  return { rows, counts, truncated, generatedAt: deps.now?.() ?? new Date().toISOString() }
}

export const paAdminInboundEmailDrafts = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 60, maxInstances: 2, secrets: [PA_ADMIN_TOKEN] },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    return runAdminInboundEmailDrafts(req.data, { db: getFirestore() })
  },
)

// ───────────────────────────────────────────────────────────────────────────
// SEND / DISMISS A DRAFT
// ───────────────────────────────────────────────────────────────────────────

export const AdminSendInboundEmailDraftInputSchema = z.object({
  draftId: z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().min(1)),
  action: z.enum(["approve_send", "dismiss"]),
  /** Optional operator edit of the reply body before sending. */
  editedBody: z.string().max(REPLY_BODY_MAX).optional(),
  note: z.string().max(2_000).optional(),
  adminToken: z.string().optional(),
})
export type AdminSendInboundEmailDraftInput = z.infer<typeof AdminSendInboundEmailDraftInputSchema>

export type AdminSendInboundEmailDraftResult =
  | { ok: true; draftId: string; action: "approve_send"; sent: boolean; status: string; reason?: string }
  | { ok: true; draftId: string; action: "dismiss"; status: "dismissed" }

export async function runAdminSendInboundEmailDraft(
  raw: unknown,
  deps: { db: Firestore; now?: () => string; actorEmail?: string },
): Promise<AdminSendInboundEmailDraftResult> {
  const parsed = AdminSendInboundEmailDraftInputSchema.safeParse(raw)
  if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
  const { draftId, action } = parsed.data
  const at = deps.now?.() ?? new Date().toISOString()
  const by = cleanString(deps.actorEmail) ?? "admin_token"

  const ref = deps.db.collection(DRAFTS_COLLECTION).doc(draftId)
  const snap = await ref.get()
  if (!snap.exists) throw new HttpsError("not-found", "draft_not_found")
  const draft = (snap.data() ?? {}) as Record<string, unknown>
  const currentStatus = cleanString(draft.status) ?? "pending_review"

  if (action === "dismiss") {
    if (currentStatus === "dismissed") return { ok: true, draftId, action: "dismiss", status: "dismissed" }
    await ref.set(
      {
        status: "dismissed",
        adminDecision: { by, at, ...(cleanString(parsed.data.note) ? { note: cleanString(parsed.data.note) } : {}) },
        updatedAt: at,
      },
      { merge: true },
    )
    return { ok: true, draftId, action: "dismiss", status: "dismissed" }
  }

  // approve_send — idempotent: already-sent draft returns ok without re-sending.
  if (currentStatus === "sent") {
    return { ok: true, draftId, action: "approve_send", sent: true, status: "sent" }
  }
  if (currentStatus === "dismissed") {
    throw new HttpsError("failed-precondition", "draft_dismissed")
  }

  const candidateEmail = cleanString(draft.candidateEmail)
  const replyTo = cleanString(draft.replyTo)
  const replySubject = cleanString(draft.replySubject) ?? "Re: your message"
  const inboundMessageId = cleanString(draft.inboundMessageId)
  const replyBody = cleanString(parsed.data.editedBody) ?? cleanString(draft.replyBody)
  if (!candidateEmail || !replyBody) {
    throw new HttpsError("failed-precondition", "draft_incomplete")
  }

  // SECURITY (locked rule d — STOP gate / TOCTOU): re-read the thread NOW, at
  // approve-time. The webhook sets thread.optOut on a STOP reply but only blocks
  // NEW drafts; a draft composed BEFORE the STOP would otherwise stay sendable.
  // Abort the send (and mark the draft suppressed) if the candidate has opted out.
  const draftConvToken = cleanString(draft.convToken)
  if (draftConvToken) {
    const threadSnap = await deps.db
      .collection(EMAIL_THREADS_COLLECTION)
      .doc(draftConvToken)
      .get()
      .catch(() => null)
    if (threadSnap?.exists && (threadSnap.data() as Record<string, unknown>)?.optOut === true) {
      await ref.set(
        { status: "suppressed_opt_out", lastError: "candidate_opted_out", updatedAt: at },
        { merge: true },
      )
      return {
        ok: true,
        draftId,
        action: "approve_send",
        sent: false,
        status: "suppressed_opt_out",
        reason: "candidate_opted_out",
      }
    }
  }

  const cfg = mailgunConfigFromEnv()
  if (!cfg) {
    await ref.set({ status: "send_failed", lastError: "email_not_configured", updatedAt: at }, { merge: true })
    return { ok: true, draftId, action: "approve_send", sent: false, status: "send_failed", reason: "email_not_configured" }
  }

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">${escapeHtml(
    replyBody,
  ).replace(/\n/g, "<br>")}</div>`

  // Audit FIRST (fail-open), then send. Mirrors the auto-send audit shape.
  const auditRef = deps.db.collection(HEADHUNTER_EMAILS_COLLECTION).doc()
  await auditRef
    .set({
      to: candidateEmail,
      subject: replySubject,
      body: replyBody.slice(0, REPLY_BODY_MAX),
      userId: cleanString(draft.userId) ?? null,
      jobId: cleanString(draft.jobId) ?? null,
      convToken: cleanString(draft.convToken) ?? null,
      status: "pending",
      source: "inbound_email_operator_approved",
      approvedBy: by,
      createdAt: FieldValue.serverTimestamp(),
    })
    .catch(() => undefined)

  try {
    const sendRes = await sendMailgun(cfg, {
      to: candidateEmail,
      subject: replySubject,
      text: replyBody,
      html,
      ...(replyTo ? { replyTo } : {}),
      ...(inboundMessageId ? { headers: { "In-Reply-To": inboundMessageId, References: inboundMessageId } } : {}),
    })
    await auditRef
      .set(
        {
          status: sendRes.ok ? "sent" : "failed",
          mailgunMessageId: sendRes.messageId ?? null,
          mailgunStatus: sendRes.status,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
      .catch(() => undefined)
    await ref.set(
      {
        status: sendRes.ok ? "sent" : "send_failed",
        ...(cleanString(parsed.data.editedBody) ? { replyBody: replyBody.slice(0, REPLY_BODY_MAX), edited: true } : {}),
        adminDecision: { by, at, action: "approve_send", ...(cleanString(parsed.data.note) ? { note: cleanString(parsed.data.note) } : {}) },
        auditId: auditRef.id,
        updatedAt: at,
      },
      { merge: true },
    )
    // Flip the thread back to outbound once we actually send.
    if (sendRes.ok && cleanString(draft.convToken)) {
      await deps.db
        .collection(EMAIL_THREADS_COLLECTION)
        .doc(cleanString(draft.convToken)!)
        .set({ lastDirection: "outbound", pendingReview: false, updatedAt: at }, { merge: true })
        .catch(() => undefined)
    }
    return {
      ok: true,
      draftId,
      action: "approve_send",
      sent: sendRes.ok,
      status: sendRes.ok ? "sent" : "send_failed",
      ...(sendRes.ok ? {} : { reason: `mailgun_status_${sendRes.status}` }),
    }
  } catch (err) {
    await auditRef.set({ status: "error", updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => undefined)
    await ref
      .set({ status: "send_failed", lastError: err instanceof Error ? err.message : String(err), updatedAt: at }, { merge: true })
      .catch(() => undefined)
    return { ok: true, draftId, action: "approve_send", sent: false, status: "send_failed", reason: "email_send_error" }
  }
}

export const paAdminSendInboundEmailDraft = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
    maxInstances: 2,
    secrets: [MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM, MAILGUN_REGION, PA_ADMIN_TOKEN],
  },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    return runAdminSendInboundEmailDraft(req.data, {
      db: getFirestore(),
      actorEmail: cleanString(req.auth?.token?.email),
    })
  },
)

// ───────────────────────────────────────────────────────────────────────────
// UNMATCHED QUEUE
// ───────────────────────────────────────────────────────────────────────────

export const AdminInboundUnmatchedListInputSchema = z.object({
  adminToken: z.string().optional(),
})
export type AdminInboundUnmatchedListInput = z.infer<typeof AdminInboundUnmatchedListInputSchema>

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

export interface AdminInboundUnmatchedListResult {
  rows: InboundUnmatchedRow[]
  counts: { no_conv_token: number; thread_not_found: number; sensitive_topic_hitl: number; other: number; total: number }
  truncated: boolean
  generatedAt: string
}

export async function runAdminInboundUnmatchedList(
  raw: unknown,
  deps: { db: Firestore; now?: () => string },
): Promise<AdminInboundUnmatchedListResult> {
  const parsed = AdminInboundUnmatchedListInputSchema.safeParse(raw)
  if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
  const { rows: scanned, truncated } = await scanCollection(deps.db, UNMATCHED_COLLECTION)
  const counts = { no_conv_token: 0, thread_not_found: 0, sensitive_topic_hitl: 0, other: 0, total: 0 }
  const rows: InboundUnmatchedRow[] = []
  for (const { id, data } of scanned) {
    const reason = cleanString(data.reason) ?? "other"
    if (reason === "no_conv_token") counts.no_conv_token += 1
    else if (reason === "thread_not_found") counts.thread_not_found += 1
    else if (reason === "sensitive_topic_hitl") counts.sensitive_topic_hitl += 1
    else counts.other += 1
    counts.total += 1
    const resolution =
      data.resolution && typeof data.resolution === "object" ? (data.resolution as Record<string, unknown>) : null
    rows.push({
      id,
      ...(cleanString(data.recipient) ? { recipient: cleanString(data.recipient) } : {}),
      ...(cleanString(data.sender) ? { sender: cleanString(data.sender) } : {}),
      ...(cleanString(data.subject) ? { subject: cleanString(data.subject) } : {}),
      reason,
      ...(cleanString(data.convToken) ? { convToken: cleanString(data.convToken) } : {}),
      ...(cleanString(data.inboundTextPreview) ? { inboundTextPreview: cleanString(data.inboundTextPreview) } : {}),
      ...(cleanString(data.messageId) ? { messageId: cleanString(data.messageId) } : {}),
      createdAt: toIso(data.createdAt),
      ...(resolution && cleanString(resolution.status) ? { resolutionStatus: cleanString(resolution.status) } : {}),
    })
  }
  return { rows, counts, truncated, generatedAt: deps.now?.() ?? new Date().toISOString() }
}

export const paAdminInboundUnmatchedList = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 60, maxInstances: 2, secrets: [PA_ADMIN_TOKEN] },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    return runAdminInboundUnmatchedList(req.data, { db: getFirestore() })
  },
)
