/**
 * admin-employer-ops.ts — admin-only readers (+ one status action) over three
 * built-but-invisible top-level collections from the employer-onboarding /
 * headhunter surfaces. None of these had an admin reader before; operators had
 * no window onto the demand/roster/outbound-audit they generate.
 *
 *  1. `paAdminConnectRequestsList`  reads `pa-employer-connect-requests`
 *     `paAdminConnectRequestSetStatus`  stamps the fulfillment status.
 *     The collection has TWO doc shapes (recon): managed-setup demand
 *     (status:"requested", `orgName`/`requesterEmail`) written by
 *     paEmployerConnectRequest, AND a self-serve public-board audit
 *     (status:"reqs_pulled", `org`, no requester) written by
 *     paEmployerAtsImportReqs. The list tolerates both (org ?? orgName).
 *
 *  2. `paAdminTeamInvitesList`  reads `pa-employer-team-invites` — one
 *     pending-invite doc per invitee (paEmployerInviteTeam). No accept flow
 *     exists yet, so status is always "pending"; the roster surfaces who was
 *     invited to which org and whether delivery failed.
 *
 *  3. `paAdminHeadhunterEmailsList`  reads `pa-headhunter-emails` — the
 *     outbound-email audit log with THREE writers discriminated by `source`
 *     (headhunter_mcp | email_interview_offer | inbound_email_autoreply). This
 *     is a read-only audit; `status` is system-owned (set by the send result),
 *     so there is NO status-mutation CF here. `body` is NOT surfaced (PII).
 *
 * Architecture mirrors admin-funnel-snapshot.ts (pure deps-injected runners +
 * thin onCall shims) and admin-interview-bookings.ts (the status action mirrors
 * runAdminInterviewOutcome, MINUS the marketplace FSM-emit half — connect
 * requests have no candidate×job FSM coupling, so it is a pure merge-write).
 * Auth via the shared `authorizeAdminCallable` + PA_ADMIN_TOKEN secret.
 */
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { z } from "zod"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

const CONNECT_REQUESTS_COLLECTION = "pa-employer-connect-requests"
const TEAM_INVITES_COLLECTION = "pa-employer-team-invites"
const HEADHUNTER_EMAILS_COLLECTION = "pa-headhunter-emails"

// Generous vs. expected volume; a hit flips `truncated` so the UI warns.
const SCAN_CAP = 5_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** Coerce any Firestore timestamp shape (ISO, epoch ms, Timestamp) to ISO. */
export function toIso(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString()
  if (value && typeof value === "object") {
    const obj = value as { toDate?: () => Date; seconds?: number; _seconds?: number }
    if (typeof obj.toDate === "function") {
      try {
        const d = obj.toDate()
        if (d instanceof Date && Number.isFinite(d.getTime())) return d.toISOString()
      } catch {
        /* fall through */
      }
    }
    if (typeof obj.seconds === "number") return new Date(obj.seconds * 1000).toISOString()
    if (typeof obj._seconds === "number") return new Date(obj._seconds * 1000).toISOString()
  }
  return undefined
}

/**
 * Scan a collection with a plain `.limit()` and NO orderBy — orderBy would drop
 * docs missing the sort field (these collections' two/three writers don't all
 * write a uniform sortable field), so we scan all and let the client sort.
 */
async function scanAll(
  db: Firestore,
  collection: string,
  fields: readonly string[],
  cap: number = SCAN_CAP,
): Promise<{ docs: Array<{ id: string; data: Record<string, unknown> }>; truncated: boolean }> {
  let q = db.collection(collection).limit(cap)
  if (fields.length > 0) q = q.select(...fields)
  const snap = await q.get()
  const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }))
  return { docs, truncated: docs.length >= cap }
}

// ---------------------------------------------------------------------------
// (1a) Connect-requests fulfillment queue — list
// ---------------------------------------------------------------------------

export interface ConnectRequestRow {
  id: string
  kind?: string
  provider?: string
  orgName?: string
  requesterEmail?: string
  details?: string
  status?: string
  source?: string
  /** Self-serve board audit only — count of reqs pulled. */
  reqCount?: number
  /** Status-action audit trail. */
  statusBy?: string
  statusAt?: string
  statusNote?: string
  requestedAt?: string
}

export interface AdminConnectRequestsListResult {
  rows: ConnectRequestRow[]
  total: number
  truncated: boolean
  generatedAt: string
}

export const AdminConnectRequestsListInputSchema = z.object({
  adminToken: z.string().nullish(),
})
export type AdminConnectRequestsListInput = z.infer<typeof AdminConnectRequestsListInputSchema>

export async function runAdminConnectRequestsList(deps: {
  db: Firestore
}): Promise<AdminConnectRequestsListResult> {
  const scan = await scanAll(deps.db, CONNECT_REQUESTS_COLLECTION, [
    "kind",
    "provider",
    "orgName",
    "org",
    "requesterEmail",
    "details",
    "status",
    "source",
    "reqCount",
    "statusBy",
    "statusAt",
    "statusNote",
    "requestedAt",
    "requestedAtIso",
  ])

  const rows: ConnectRequestRow[] = scan.docs.map(({ id, data }) => {
    // The public-board audit writer uses `org`; the managed-setup writer uses
    // `orgName`. Surface whichever is present under `orgName`.
    const orgName = str(data.orgName) ?? str(data.org)
    const requestedAt = toIso(data.requestedAt) ?? str(data.requestedAtIso)
    const reqCount = typeof data.reqCount === "number" ? data.reqCount : undefined
    return {
      id,
      ...(str(data.kind) ? { kind: str(data.kind) } : {}),
      ...(str(data.provider) ? { provider: str(data.provider) } : {}),
      ...(orgName ? { orgName } : {}),
      ...(str(data.requesterEmail) ? { requesterEmail: str(data.requesterEmail) } : {}),
      ...(str(data.details) ? { details: str(data.details) } : {}),
      ...(str(data.status) ? { status: str(data.status) } : {}),
      ...(str(data.source) ? { source: str(data.source) } : {}),
      ...(reqCount !== undefined ? { reqCount } : {}),
      ...(str(data.statusBy) ? { statusBy: str(data.statusBy) } : {}),
      ...(str(data.statusAt) ? { statusAt: str(data.statusAt) } : {}),
      ...(str(data.statusNote) ? { statusNote: str(data.statusNote) } : {}),
      ...(requestedAt ? { requestedAt } : {}),
    }
  })

  return {
    rows,
    total: rows.length,
    truncated: scan.truncated,
    generatedAt: new Date().toISOString(),
  }
}

export const paAdminConnectRequestsList = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 120, secrets: [PA_ADMIN_TOKEN] },
  async (req): Promise<AdminConnectRequestsListResult> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const parsed = AdminConnectRequestsListInputSchema.safeParse(req.data ?? {})
    if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
    try {
      return await runAdminConnectRequestsList({ db: getFirestore() })
    } catch (err) {
      logger.error("[admin-connect-requests-list] failed", err)
      throw new HttpsError("internal", "connect requests list failed")
    }
  },
)

// ---------------------------------------------------------------------------
// (1b) Connect-request status action
// ---------------------------------------------------------------------------

export const AdminConnectRequestSetStatusInputSchema = z.object({
  id: z.string().trim().min(1),
  status: z.enum(["requested", "contacted", "connected", "declined"]),
  note: z.string().max(4_000).optional(),
  adminToken: z.string().nullish(),
})
export type AdminConnectRequestSetStatusInput = z.infer<typeof AdminConnectRequestSetStatusInputSchema>

export type AdminConnectRequestSetStatusResult = {
  ok: true
  id: string
  status: "requested" | "contacted" | "connected" | "declined"
}

export interface AdminConnectRequestSetStatusDeps {
  db: Firestore
  now?: () => string
  actorEmail?: string
}

export async function runAdminConnectRequestSetStatus(
  raw: unknown,
  deps: AdminConnectRequestSetStatusDeps,
): Promise<AdminConnectRequestSetStatusResult> {
  const parsed = AdminConnectRequestSetStatusInputSchema.safeParse(raw)
  if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
  const { id, status } = parsed.data
  const now = deps.now?.() ?? new Date().toISOString()
  const note = str(parsed.data.note)
  const by = str(deps.actorEmail) ?? "admin_token"

  const ref = deps.db.collection(CONNECT_REQUESTS_COLLECTION).doc(id)
  const snap = await ref.get()
  if (!snap.exists) {
    throw new HttpsError("not-found", "connect_request_not_found")
  }

  // Pure merge-write — no marketplace FSM coupling for this collection
  // (unlike interview bookings, which emit a parallel candidate×job event).
  await ref.set(
    {
      status,
      statusBy: by,
      statusAt: now,
      ...(note ? { statusNote: note } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )

  return { ok: true, id, status }
}

export const paAdminConnectRequestSetStatus = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 60, maxInstances: 1, secrets: [PA_ADMIN_TOKEN] },
  async (req): Promise<AdminConnectRequestSetStatusResult> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    try {
      return await runAdminConnectRequestSetStatus(req.data, {
        db: getFirestore(),
        actorEmail: str(req.auth?.token?.email),
      })
    } catch (err) {
      if (err instanceof HttpsError) throw err
      logger.error("[admin-connect-request-set-status] failed", err)
      throw new HttpsError("internal", "connect request status update failed")
    }
  },
)

// ---------------------------------------------------------------------------
// (2) Team-invites roster — list
// ---------------------------------------------------------------------------

export interface TeamInviteRow {
  id: string
  email?: string
  role?: string
  status?: string
  orgName?: string
  inviterEmail?: string
  /** True when the Mailgun send failed (recorded by the writer). */
  emailDeliveryFailed?: boolean
  mailgunStatus?: number
  invitedAt?: string
}

export interface AdminTeamInvitesListResult {
  rows: TeamInviteRow[]
  total: number
  truncated: boolean
  generatedAt: string
}

export const AdminTeamInvitesListInputSchema = z.object({
  adminToken: z.string().nullish(),
})
export type AdminTeamInvitesListInput = z.infer<typeof AdminTeamInvitesListInputSchema>

export async function runAdminTeamInvitesList(deps: {
  db: Firestore
}): Promise<AdminTeamInvitesListResult> {
  const scan = await scanAll(deps.db, TEAM_INVITES_COLLECTION, [
    "email",
    "role",
    "status",
    "orgName",
    "inviterEmail",
    "emailDeliveryFailed",
    "mailgunStatus",
    "invitedAt",
    "invitedAtIso",
  ])

  const rows: TeamInviteRow[] = scan.docs.map(({ id, data }) => {
    const invitedAt = toIso(data.invitedAt) ?? str(data.invitedAtIso)
    return {
      id,
      ...(str(data.email) ? { email: str(data.email) } : {}),
      ...(str(data.role) ? { role: str(data.role) } : {}),
      ...(str(data.status) ? { status: str(data.status) } : {}),
      ...(str(data.orgName) ? { orgName: str(data.orgName) } : {}),
      ...(str(data.inviterEmail) ? { inviterEmail: str(data.inviterEmail) } : {}),
      ...(data.emailDeliveryFailed === true ? { emailDeliveryFailed: true } : {}),
      ...(typeof data.mailgunStatus === "number" ? { mailgunStatus: data.mailgunStatus } : {}),
      ...(invitedAt ? { invitedAt } : {}),
    }
  })

  return {
    rows,
    total: rows.length,
    truncated: scan.truncated,
    generatedAt: new Date().toISOString(),
  }
}

export const paAdminTeamInvitesList = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 120, secrets: [PA_ADMIN_TOKEN] },
  async (req): Promise<AdminTeamInvitesListResult> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const parsed = AdminTeamInvitesListInputSchema.safeParse(req.data ?? {})
    if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
    try {
      return await runAdminTeamInvitesList({ db: getFirestore() })
    } catch (err) {
      logger.error("[admin-team-invites-list] failed", err)
      throw new HttpsError("internal", "team invites list failed")
    }
  },
)

// ---------------------------------------------------------------------------
// (3) Headhunter-email audit log — list (read-only; no status mutation)
// ---------------------------------------------------------------------------

export interface HeadhunterEmailRow {
  id: string
  to?: string
  subject?: string
  status?: string
  source?: string
  convToken?: string
  mailgunMessageId?: string
  /** Present on writers 2/3 (interview offer / inbound auto-reply). */
  userId?: string
  jobId?: string
  createdAt?: string
}

export interface AdminHeadhunterEmailsListResult {
  rows: HeadhunterEmailRow[]
  total: number
  truncated: boolean
  generatedAt: string
}

// `source` is the discriminator across the three writers.
export const HEADHUNTER_EMAIL_SOURCES = [
  "headhunter_mcp",
  "email_interview_offer",
  "inbound_email_autoreply",
] as const

export const AdminHeadhunterEmailsListInputSchema = z.object({
  limit: z.number().int().min(1).max(SCAN_CAP).optional().default(1_000),
  source: z.enum(HEADHUNTER_EMAIL_SOURCES).optional(),
  adminToken: z.string().nullish(),
})
export type AdminHeadhunterEmailsListInput = z.infer<typeof AdminHeadhunterEmailsListInputSchema>

export async function runAdminHeadhunterEmailsList(
  input: AdminHeadhunterEmailsListInput,
  deps: { db: Firestore },
): Promise<AdminHeadhunterEmailsListResult> {
  // Note: `body` is deliberately NOT selected — the audit surfaces subject only,
  // never the message body (PII).
  const scan = await scanAll(
    deps.db,
    HEADHUNTER_EMAILS_COLLECTION,
    ["to", "subject", "status", "source", "convToken", "mailgunMessageId", "userId", "jobId", "createdAt"],
    input.limit,
  )

  const rows: HeadhunterEmailRow[] = scan.docs
    .map(({ id, data }) => {
      const createdAt = toIso(data.createdAt)
      return {
        id,
        ...(str(data.to) ? { to: str(data.to) } : {}),
        ...(str(data.subject) ? { subject: str(data.subject) } : {}),
        ...(str(data.status) ? { status: str(data.status) } : {}),
        ...(str(data.source) ? { source: str(data.source) } : {}),
        ...(str(data.convToken) ? { convToken: str(data.convToken) } : {}),
        ...(str(data.mailgunMessageId) ? { mailgunMessageId: str(data.mailgunMessageId) } : {}),
        ...(str(data.userId) ? { userId: str(data.userId) } : {}),
        ...(str(data.jobId) ? { jobId: str(data.jobId) } : {}),
        ...(createdAt ? { createdAt } : {}),
      }
    })
    .filter((row) => (input.source ? row.source === input.source : true))

  return {
    rows,
    total: rows.length,
    truncated: scan.truncated,
    generatedAt: new Date().toISOString(),
  }
}

export const paAdminHeadhunterEmailsList = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 120, secrets: [PA_ADMIN_TOKEN] },
  async (req): Promise<AdminHeadhunterEmailsListResult> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const parsed = AdminHeadhunterEmailsListInputSchema.safeParse(req.data ?? {})
    if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
    try {
      return await runAdminHeadhunterEmailsList(parsed.data, { db: getFirestore() })
    } catch (err) {
      logger.error("[admin-headhunter-emails-list] failed", err)
      throw new HttpsError("internal", "headhunter emails list failed")
    }
  },
)
