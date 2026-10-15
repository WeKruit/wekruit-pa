/**
 * paAdminCandidateComms — unified SMS + email comms timeline for one candidate.
 *
 * The /admin/users/:id detail surface (and any decision an operator makes about
 * a candidate) previously saw only HALF the conversation: pa-messages (SMS /
 * iMessage) was rendered, but every EMAIL the candidate sent or received lived
 * in separate collections no dashboard ever read. This callable merges them
 * into ONE time-ordered timeline so decisions aren't made on half the thread.
 *
 * Sources merged (all keyed to the candidate):
 *   - pa-messages         → SMS/iMessage, inbound (role=user) + outbound (role=assistant)
 *   - pa-headhunter-emails → OUTBOUND email audit (send_email / interview_offer /
 *                            inbound autoreply). userId present on most; the
 *                            headhunter send_email path stamps only candidateEmail.
 *   - pa-email-inbound    → INBOUND email (candidate REPLIES). userId from thread.
 *   - pa-email-threads    → token→candidate metadata (subject / optOut / direction).
 *
 * KEYING: most rows carry userId, but the headhunter `send_email` path persists
 * NO userId (only candidateEmail). So we run a userId query AND a
 * candidateEmail==user.email fallback query, then de-dupe. The user's email is
 * resolved from pa-users (email / normalizedEmail / contactEmail) with a
 * pa-candidate-handles fallback.
 *
 * Read-only. Admin-gated (authorizeAdminCallable + PA_ADMIN_TOKEN). Never sends.
 */
import { getFirestore, type Firestore, type Query } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { z } from "zod"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

const MESSAGES_COLLECTION = "pa-messages"
const HEADHUNTER_EMAILS_COLLECTION = "pa-headhunter-emails"
const EMAIL_INBOUND_COLLECTION = "pa-email-inbound"
const EMAIL_THREADS_COLLECTION = "pa-email-threads"
const USERS_COLLECTION = "pa-users"
const CANDIDATE_HANDLES_COLLECTION = "pa-candidate-handles"

/** Cap each source scan so a noisy candidate can't blow the callable budget. */
const PER_SOURCE_CAP = 500
/** Cap the merged timeline returned to the client. */
const TIMELINE_CAP = 800

export const AdminCandidateCommsInputSchema = z.object({
  userId: z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().min(1)),
  adminToken: z.string().optional(),
})
export type AdminCandidateCommsInput = z.infer<typeof AdminCandidateCommsInputSchema>

export interface CommsTimelineRow {
  /** Stable id (source doc id) — for React keys / dedupe. */
  id: string
  /** ISO-8601 timestamp (sortable across sources). */
  ts: string
  channel: "sms" | "email"
  direction: "inbound" | "outbound"
  subject?: string
  text: string
  status?: string
  source: string
}

export interface AdminCandidateCommsResult {
  userId: string
  candidateEmail?: string
  rows: CommsTimelineRow[]
  counts: { sms: number; email: number; total: number }
  truncated: boolean
  generatedAt: string
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * Normalize a Firestore timestamp-ish value (admin Timestamp | ISO string |
 * epoch number) to a sortable ISO string. Returns "" when unparseable.
 */
function toIso(value: unknown): string {
  if (!value) return ""
  // Firestore Timestamp (admin SDK) → has toDate()
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
  if (typeof value === "number") {
    return new Date(value).toISOString()
  }
  if (typeof value === "string") {
    const t = Date.parse(value)
    return Number.isNaN(t) ? "" : new Date(t).toISOString()
  }
  return ""
}

/** Resolve the candidate's email from pa-users, falling back to handles. */
async function resolveCandidateEmail(db: Firestore, userId: string): Promise<string | undefined> {
  const userSnap = await db.collection(USERS_COLLECTION).doc(userId).get().catch(() => null)
  if (userSnap && userSnap.exists) {
    const u = (userSnap.data() ?? {}) as Record<string, unknown>
    const direct = cleanString(u.email) ?? cleanString(u.normalizedEmail) ?? cleanString(u.contactEmail)
    if (direct) return direct.toLowerCase()
  }
  const handleSnap = await db
    .collection(CANDIDATE_HANDLES_COLLECTION)
    .where("candidateId", "==", userId)
    .where("kind", "==", "email")
    .limit(1)
    .get()
    .catch(() => null)
  if (handleSnap && !handleSnap.empty) {
    const v = handleSnap.docs[0]!.data()?.normalizedValue
    return cleanString(v)?.toLowerCase()
  }
  return undefined
}

/** Run a query, swallow errors (missing index / field) → empty. */
async function safeQueryDocs(q: Query): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  try {
    const snap = await q.get()
    return snap.docs.map((d) => ({ id: d.id, data: (d.data() ?? {}) as Record<string, unknown> }))
  } catch {
    return []
  }
}

export async function runAdminCandidateComms(
  raw: unknown,
  deps: { db: Firestore; now?: () => string },
): Promise<AdminCandidateCommsResult> {
  const parsed = AdminCandidateCommsInputSchema.safeParse(raw)
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error.message)
  }
  const { userId } = parsed.data
  const { db } = deps
  const nowIso = deps.now?.() ?? new Date().toISOString()

  const candidateEmail = await resolveCandidateEmail(db, userId)

  // ── SMS (pa-messages) ───────────────────────────────────────────────────
  const smsDocs = await safeQueryDocs(
    db.collection(MESSAGES_COLLECTION).where("userId", "==", userId).limit(PER_SOURCE_CAP),
  )

  // ── Email — outbound audit (pa-headhunter-emails) ───────────────────────
  // userId-keyed (interview_offer + inbound autoreply) PLUS candidateEmail
  // fallback (the headhunter send_email path stamps only `to`).
  const outboundByUser = await safeQueryDocs(
    db.collection(HEADHUNTER_EMAILS_COLLECTION).where("userId", "==", userId).limit(PER_SOURCE_CAP),
  )
  // SECURITY: the by-email fallback exists because the headhunter send_email path
  // stamps only `to` (no userId). But two pa-users can share an email — so keep a
  // by-email doc ONLY when it has NO userId of its own OR it matches this user.
  // A doc bearing a DIFFERENT userId belongs to another candidate → drop it.
  const notForeignUser = ({ data }: { data: Record<string, unknown> }): boolean => {
    const docUid = cleanString(data.userId)
    return !docUid || docUid === userId
  }
  const outboundByEmail = candidateEmail
    ? (
        await safeQueryDocs(
          db.collection(HEADHUNTER_EMAILS_COLLECTION).where("to", "==", candidateEmail).limit(PER_SOURCE_CAP),
        )
      ).filter(notForeignUser)
    : []

  // ── Email — inbound (pa-email-inbound) ──────────────────────────────────
  const inboundByUser = await safeQueryDocs(
    db.collection(EMAIL_INBOUND_COLLECTION).where("userId", "==", userId).limit(PER_SOURCE_CAP),
  )
  const inboundByEmail = candidateEmail
    ? (
        await safeQueryDocs(
          db.collection(EMAIL_INBOUND_COLLECTION).where("candidateEmail", "==", candidateEmail).limit(PER_SOURCE_CAP),
        )
      ).filter(notForeignUser)
    : []

  // ── Email — thread metadata (pa-email-threads) for subject backfill ─────
  const threadsByUser = await safeQueryDocs(
    db.collection(EMAIL_THREADS_COLLECTION).where("userId", "==", userId).limit(PER_SOURCE_CAP),
  )
  const threadsByEmail = candidateEmail
    ? (
        await safeQueryDocs(
          db.collection(EMAIL_THREADS_COLLECTION).where("candidateEmail", "==", candidateEmail).limit(PER_SOURCE_CAP),
        )
      ).filter(notForeignUser)
    : []
  const subjectByToken = new Map<string, string>()
  for (const { data } of [...threadsByUser, ...threadsByEmail]) {
    const token = cleanString(data.convToken)
    const subject = cleanString(data.subject)
    if (token && subject && !subjectByToken.has(token)) subjectByToken.set(token, subject)
  }

  const rows: CommsTimelineRow[] = []
  const seen = new Set<string>()
  const push = (row: CommsTimelineRow) => {
    const key = `${row.source}:${row.id}`
    if (seen.has(key)) return
    seen.add(key)
    rows.push(row)
  }

  // SMS rows: role drives direction (user=inbound, assistant=outbound). Skip
  // pure system events (no human-readable channel content).
  for (const { id, data } of smsDocs) {
    const role = cleanString(data.role)
    if (role !== "user" && role !== "assistant") continue
    const body = cleanString(data.body)
    if (!body) continue
    push({
      id,
      ts: toIso(data.createdAt),
      channel: "sms",
      direction: role === "user" ? "inbound" : "outbound",
      text: body,
      source: "pa-messages",
    })
  }

  // Outbound email rows.
  for (const { id, data } of [...outboundByUser, ...outboundByEmail]) {
    const token = cleanString(data.convToken)
    const subject = cleanString(data.subject) ?? (token ? subjectByToken.get(token) : undefined)
    // body present on send_email / interview_offer audits; autoreply audit omits it.
    const text = cleanString(data.body) ?? (subject ? `(email sent: ${subject})` : "(email sent)")
    push({
      id,
      ts: toIso(data.createdAt),
      channel: "email",
      direction: "outbound",
      ...(subject ? { subject } : {}),
      text,
      ...(cleanString(data.status) ? { status: cleanString(data.status) } : {}),
      source: cleanString(data.source) ?? HEADHUNTER_EMAILS_COLLECTION,
    })
  }

  // Inbound email rows.
  for (const { id, data } of [...inboundByUser, ...inboundByEmail]) {
    const token = cleanString(data.convToken)
    const subject = cleanString(data.subject) ?? (token ? subjectByToken.get(token) : undefined)
    const text = cleanString(data.strippedText) ?? "(empty reply)"
    push({
      id,
      ts: toIso(data.createdAt),
      channel: "email",
      direction: "inbound",
      ...(subject ? { subject } : {}),
      text,
      source: EMAIL_INBOUND_COLLECTION,
    })
  }

  // Sort ascending by time (chat-stream order). Rows with no parseable ts sink
  // to the top (oldest-unknown) deterministically by id.
  rows.sort((a, b) => {
    if (a.ts && b.ts && a.ts !== b.ts) return a.ts.localeCompare(b.ts)
    if (a.ts && !b.ts) return 1
    if (!a.ts && b.ts) return -1
    return a.id.localeCompare(b.id)
  })

  const truncated = rows.length > TIMELINE_CAP
  const finalRows = truncated ? rows.slice(rows.length - TIMELINE_CAP) : rows
  const smsCount = finalRows.filter((r) => r.channel === "sms").length
  const emailCount = finalRows.filter((r) => r.channel === "email").length

  return {
    userId,
    ...(candidateEmail ? { candidateEmail } : {}),
    rows: finalRows,
    counts: { sms: smsCount, email: emailCount, total: finalRows.length },
    truncated,
    generatedAt: nowIso,
  }
}

export const paAdminCandidateComms = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 60, maxInstances: 2, secrets: [PA_ADMIN_TOKEN] },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    return runAdminCandidateComms(req.data, { db: getFirestore() })
  },
)
