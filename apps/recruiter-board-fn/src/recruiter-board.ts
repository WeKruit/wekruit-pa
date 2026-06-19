/**
 * Recruiter board HTTP Cloud Functions.
 *
 * Backs the `/recruiters` route on wekruit-recruiters.web.app. Public, CORS-enabled.
 * Lives in the `recruiter-board` multi-codebase (separate from pa-orchestrator)
 * so cold start + bundle stay small and the API stays usable for downstream
 * consumers (e.g. recruiter agents calling the public list endpoint).
 *
 *   GET  paCollabJobsList          -> sanitized list of WeKruit collab jobs
 *                                     (supports ?limit, ?offset, ?since, ?status)
 *   POST paRecruiterInviteCodeCreate -> admin creates one-use recruiter invite code
 *                                      and can email it to the recruiter
 *   POST paRecruiterInviteCodeResend -> admin resends an existing sent-but-unclaimed invite
 *   POST paRecruiterInviteCodeReplace -> admin replaces a legacy unrecoverable invite code
 *   POST paRecruiterInviteCodeRestore -> admin stores a known raw code on a preview-only row
 *   GET  paRecruiterMe             -> returns the Firebase Auth-bound recruiter profile
 *   POST paRecruiterAccess         -> validates invite code + binds Firebase Auth uid
 *   POST paRecruiterPreferencesUpdate -> recruiter updates notification settings
 *   GET  paRecruiterNotificationsList -> recruiter-authenticated notification center
 *   POST paRecruiterNotificationsRead -> marks recruiter notifications read
 *   GET  paRecruiterRoleApplicationsList -> recruiter-authenticated role applications
 *   POST paRecruiterRoleApplicationSave -> applies/withdraws for a role
 *   GET  paRecruiterSourcedCandidatesList -> recruiter-authenticated source CRM
 *   POST paRecruiterSourcedCandidateSave -> upserts one sourced candidate
 *   GET  paRecruiterRoleFeedbackList -> recruiter-authenticated role feedback
 *   POST paRecruiterRoleFeedbackSave -> upserts role difficulty / market feedback
 *   GET  paRecruiterRoleQuestionsList -> recruiter-authenticated role Q&A
 *   POST paRecruiterRoleQuestionCreate -> creates one role calibration question
 *   GET  paRecruiterRoleIntelligenceList -> recruiter-authenticated aggregate role signal
 *   POST paRecruiterCandidateIdentityCheck -> checks candidate ownership before submit
 *   POST paRecruiterSubmission     -> writes pa-recruiter-submissions doc
 *                                     (honors Idempotency-Key header)
 *   POST paRecruiterSubmissionUpdate -> owning recruiter edits candidate cells /
 *                                       checklist / extraFields while the row is unlocked
 *   GET  paRecruiterSubmissionCommentsList -> recruiter↔WeKruit thread on one submission
 *   POST paRecruiterSubmissionCommentAdd -> recruiter appends one thread comment
 *   GET  paRecruiterSubmissionsList -> recruiter-authenticated status tracker
 *   TRG  paRecruiterRoleReleasedNotify -> emails recruiters when a role is released
 *   TRG  paRecruiterRoleFeedbackSignalWrite -> appends recruiter role feedback into marketplace flywheel
 *   TRG  paRecruiterRoleApplicationDecisionNotify -> creates recruiter inbox decision notices
 *   TRG  paRecruiterSubmissionFeedbackNotify -> emails + creates recruiter inbox status/feedback,
 *                                                requested-info, confirmation, and payout notices
 *   TRG  paRecruiterSubmissionCommentNotify -> recruiter inbox (+ email for WeKruit replies)
 *                                               on submission thread comments
 *   GET  paCollabJobsListSchema    -> JSON Schema for the list response shape
 *
 * Companion docs:
 *   .planning/INITIATIVE-recruiter-board.md
 */
import { onRequest } from "firebase-functions/v2/https"
import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore, FieldValue, type DocumentReference, type Firestore, type Timestamp } from "firebase-admin/firestore"
import { getAuth } from "firebase-admin/auth"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { appendSubmissionToSheet } from "./recruiter-board-sheet.js"
import {
  computeRecruiterDigest,
  selectRoles,
  renderDigestEmail,
  toMs as digestToMs,
  type RawJob,
  type RawSubmission,
  type RecruiterDigest,
} from "./recruiter-digest.js"

// Memory floor for these endpoints. They serve small JSON payloads (11 docs
// today, ~80 docs ceiling). Pinned to a fixed value rather than the platform
// default to make cost behavior predictable; the new dedicated codebase has
// no shared bundle weight. 128MiB OOMed at startup (firebase-admin +
// googleapis runtime peak ~144MiB; logs 2026-05-27 14:49-16:12 UTC showed
// "Memory limit of 128 MiB exceeded with 144 MiB used" → readiness probe
// failed → 500). Bumped to 256MiB. See firebase.json `recruiter-board`
// codebase entry for deploy isolation.
const RECRUITER_BOARD_MEMORY = "256MiB"

// Optional environment variable. When set and the runtime SA has Editor access
// on the sheet, each submission is appended to a per-jobId tab. If unset, the
// Firestore write still happens and sheet sync is skipped.
const RECRUITER_BOARD_SHEET_ID_ENV = "RECRUITER_BOARD_SHEET_ID"

const MAILGUN_API_KEY = defineSecret("MAILGUN_API_KEY")
const MAILGUN_DOMAIN = defineSecret("MAILGUN_DOMAIN")
const MAILGUN_FROM = defineSecret("MAILGUN_FROM")
const MAILGUN_REGION = defineSecret("MAILGUN_REGION")
const PA_ADMIN_TOKEN_SECRET = defineSecret("PA_ADMIN_TOKEN")
const MAILGUN_SECRETS = [MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM, MAILGUN_REGION]
const ADMIN_INVITE_ENDPOINT_SCALE = {
  minInstances: 1,
  maxInstances: 1,
}
const RECRUITER_PUBLIC_BASE_URL = "https://wekruit-recruiters.web.app"

// ─────────────────────────────────────────────────────────────────────────────
// Hiring-board admin gating
//
// Anonymous visitors of https://wekruit.github.io/hiring-board/ must NEVER
// see the real company name on a collab job. Authenticated `@wekruit.com`
// staff get the full payload (real company, real Firestore doc id) so they
// can perform admin operations from the same surface.
// ─────────────────────────────────────────────────────────────────────────────

const HIRING_BOARD_ADMIN_EMAIL_DOMAIN = "@wekruit.com"
const RECRUITER_PRIMARY_ROLE_SLOT_LIMIT = 10
// Anti-abuse backstop only — contracted recruiters submit freely; the
// role-approval ceremony is not a product gate (founder 2026-06-09).
const RECRUITER_SINGLE_SUBMISSION_WEEKLY_LIMIT = 100
const RECRUITER_PENDING_SUBMISSION_STATUSES = ["submitted", "new", "reviewing", "backburner"]
const RECRUITER_ADVANCED_SUBMISSION_STATUSES = ["advanced", "wekruit_interview", "client_review", "interviewing", "offer", "hired"]

/**
 * Verifies a Bearer Firebase ID token and returns true when the caller's
 * email ends with `@wekruit.com`. Any missing/malformed/expired/invalid
 * token returns false (we never throw — anonymous viewing is allowed, just
 * with the anonymized payload).
 *
 * `verifyIdToken` is dependency-injected so unit tests can run without
 * Firebase Auth wired up.
 */
async function hiringBoardAdminEmail(
  req: { headers: { authorization?: string } },
  verifyIdToken?: (token: string) => Promise<{ email?: string }>,
): Promise<string | null> {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith("Bearer ")) return null
  const token = auth.slice("Bearer ".length).trim()
  if (!token) return null
  const adminToken = (process.env.PA_ADMIN_TOKEN ?? "").trim()
  if (adminToken && token === adminToken) return "admin-cli@wekruit.com"
  const verify =
    verifyIdToken ??
    (async (t: string) => {
      const decoded = await getAuth().verifyIdToken(t)
      return { email: decoded.email }
    })
  try {
    const decoded = await verify(token)
    const email = (decoded.email ?? "").toLowerCase()
    return email.endsWith(HIRING_BOARD_ADMIN_EMAIL_DOMAIN) ? email : null
  } catch {
    return null
  }
}

export async function isHiringBoardAdmin(
  req: { headers: { authorization?: string } },
  verifyIdToken?: (token: string) => Promise<{ email?: string }>,
): Promise<boolean> {
  return (await hiringBoardAdminEmail(req, verifyIdToken)) !== null
}

/**
 * Maps a hiring-board public-facing `jobId` (which is the opaque
 * `publicId` for anonymous viewers) back to the real Firestore doc id.
 *
 * Accepts both:
 *   - A real Firestore doc id (admin path, or legacy bookmark) — returned
 *     as-is when the doc exists.
 *   - A `publicId` UUID — resolved via `where("publicId", "==", X)`.
 *
 * Returns null when neither resolves to a collab job.
 */
export async function resolvePublicIdToDocId(
  db: Firestore,
  jobId: string,
): Promise<string | null> {
  // Try direct doc id first — cheap, common admin path.
  const directSnap = await db.collection("pa-jobs").doc(jobId).get()
  if (directSnap.exists) return directSnap.id

  // Fall back to publicId lookup for anonymized URLs.
  const query = await db
    .collection("pa-jobs")
    .where("publicId", "==", jobId)
    .limit(1)
    .get()
  if (query.empty) return null
  return query.docs[0]!.id
}

// ─────────────────────────────────────────────────────────────────────────────
// Types — recruiterBoard payload (mirrored loosely; see INITIATIVE doc)
// ─────────────────────────────────────────────────────────────────────────────

export interface RecruiterBoardLabel {
  company: string
  companyCode: string
  location: string
  pills: { text: string; tone?: "warm" | "cool" | "neutral" }[]
}

export interface RecruiterBoardCulture {
  bet: string
  bullets: string[]
}

export interface RecruiterBoardChecklistItem {
  id: string
  text: string
}

export interface RecruiterBoardChecklistGroup {
  kind: "hard" | "fit" | "bonus" | "anti"
  heading: string
  items: RecruiterBoardChecklistItem[]
}

export interface RecruiterBoardChecklist {
  groups: RecruiterBoardChecklistGroup[]
}

export interface RecruiterBoardSubmitField {
  id: string
  label: string
  kind: "url" | "text"
  required?: boolean
  placeholder?: string
}

// Recruiter-safe slice of the admin priority object (recruiterBoard.priority).
// Only `tier` + `rank` are exposed to recruiters; the internal `note` and
// `emailAudience` (ops email-angle metadata) stay admin-only.
export type RecruiterBoardPriorityTier = "urgent" | "high" | "normal" | "paused"
export interface RecruiterBoardPriority {
  tier: RecruiterBoardPriorityTier
  rank: number | null
}

export interface RecruiterBoardPayload {
  active: boolean
  sortOrder: number
  label: RecruiterBoardLabel
  culture: RecruiterBoardCulture
  checklist: RecruiterBoardChecklist
  interviewProcess?: string
  submitFields?: RecruiterBoardSubmitField[]
  priority?: RecruiterBoardPriority
}

const PRIORITY_TIERS: readonly RecruiterBoardPriorityTier[] = ["urgent", "high", "normal", "paused"]

// Read the recruiter-safe priority slice off a stored recruiterBoard. Returns
// undefined when no priority has been set (so unranked roles stay clean).
function publicRecruiterBoardPriority(raw: unknown): RecruiterBoardPriority | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const p = raw as Record<string, unknown>
  const tier = typeof p.tier === "string" && (PRIORITY_TIERS as readonly string[]).includes(p.tier)
    ? (p.tier as RecruiterBoardPriorityTier)
    : "normal"
  const rankNum = typeof p.rank === "number" ? p.rank : Number(p.rank)
  const rank = Number.isInteger(rankNum) && rankNum >= 1 && rankNum <= 999 ? rankNum : null
  // Nothing meaningful set → omit so the badge/sort treat it as plain.
  if (tier === "normal" && rank === null) return undefined
  return { tier, rank }
}

// Sort weight: lower shown first. urgent → high → normal → paused, and within a
// tier ranked roles (rank asc) float above unranked.
function priorityScore(priority?: RecruiterBoardPriority): number {
  const tierWeight: Record<RecruiterBoardPriorityTier, number> = {
    urgent: 0,
    high: 1_000,
    normal: 2_000,
    paused: 3_000,
  }
  const base = priority ? tierWeight[priority.tier] : tierWeight.normal
  const rankPart = priority?.rank != null ? priority.rank : 999
  return base + rankPart
}

export interface JdBlock {
  heading: string
  body: string
  kind?: "list" | "prose"
}

// What the public list endpoint returns. For non-admins the `jobId` is the
// opaque `publicId` and `recruiterBoard.label.company` is anonymized (e.g.
// `"Co. A · early-stage AI infra startup"`). Admins see the real doc id and
// full payload.
//
// `updatedAt` is ISO-8601. It is derived from `recruiterBoard.updatedAt`
// (preferred) and falls back to the doc's `updatedAt` field, then to `null`
// when neither exists. Downstream consumers can poll the list with
// `?since=<ISO>` to fetch only changed jobs.
export interface PublicCollabJob {
  jobId: string
  title: string
  compSummary?: string
  companyWebsite?: string
  jdBlocks: JdBlock[]
  recruiterBoard: RecruiterBoardPayload
  updatedAt: string | null
}

export interface CollabJobsListResponse {
  ok: true
  jobs: PublicCollabJob[]
  /** Total count of jobs matching the filters, ignoring offset/limit. */
  total: number
  /** Offset to pass on the next request, or `null` when this is the last page. */
  nextOffset: number | null
}

function setCors(res: { set: (k: string, v: string) => unknown }): void {
  res.set("Access-Control-Allow-Origin", "*")
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization,Idempotency-Key")
  res.set("Access-Control-Max-Age", "3600")
}

// ─────────────────────────────────────────────────────────────────────────────
// Recruiter access — invite-code gated Firebase Auth registration
// ─────────────────────────────────────────────────────────────────────────────

const RECRUITER_INVITE_CODES_COLLECTION = "pa-recruiter-invite-codes"
const RECRUITER_USERS_COLLECTION = "pa-recruiter-users"
const RECRUITER_SUBMISSIONS_COLLECTION = "pa-recruiter-submissions"
const RECRUITER_NOTIFICATIONS_COLLECTION = "pa-recruiter-notifications"
const RECRUITER_SOURCED_CANDIDATES_COLLECTION = "pa-recruiter-sourced-candidates"
const RECRUITER_ROLE_APPLICATIONS_COLLECTION = "pa-recruiter-role-applications"
const RECRUITER_ROLE_FEEDBACK_COLLECTION = "pa-recruiter-role-feedback"
const RECRUITER_ROLE_QUESTIONS_COLLECTION = "pa-recruiter-role-questions"
const FEEDBACK_EVENTS_COLLECTION = "pa-feedback-events"
const AUDIT_EVENTS_COLLECTION = "pa-audit-events"

export interface RecruiterNotificationPreferences {
  newRolesEmail: boolean
  submissionUpdatesEmail: boolean
}

export interface RecruiterWorkspacePreferences {
  primaryRoleIds: string[]
}

export interface RecruiterProfilePublic {
  recruiterId: string
  firebaseUid: string
  name: string
  email: string
  legalEntityName?: string
  tosAcceptedAt?: string
  notificationPreferences: RecruiterNotificationPreferences
  workspacePreferences: RecruiterWorkspacePreferences
}

export interface RecruiterNotificationListItem {
  id: string
  notificationId?: string
  type: string
  status?: string
  title: string
  body: string
  recruiterId?: string
  recruiterEmail?: string
  entityType?: string
  entityId?: string
  jobId?: string
  publicJobId?: string
  roleTitle?: string
  companyLabel?: string
  location?: string
  roleUrl?: string
  readAt?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

interface RecruiterAccessRegistrationInput {
  name: string
  email: string
  inviteCode: string
  legalEntityName?: string
  tosAccepted?: boolean
}

interface RecruiterFirebaseIdentity {
  uid: string
  email: string
}

interface RecruiterInviteCodeCreateInput {
  label?: string
  code?: string
  recruiterEmail?: string
  sendEmail: boolean
  maxUses: number
  expiresAt?: string
}

interface RecruiterInviteCodeReplaceInput {
  inviteCodeId: string
}

interface RecruiterInviteCodeResendInput {
  inviteCodeId: string
}

interface RecruiterInviteCodeRestoreInput {
  inviteCodeId: string
  inviteCode: string
}

function normalizeRecruiterEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

function validEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)
}

export function normalizeRecruiterInviteCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "")
}

export function hashRecruiterInviteCode(normalizedCode: string): string {
  return createHash("sha256").update(normalizedCode).digest("hex")
}

export function generateRecruiterInviteCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const bytes = randomBytes(8)
  let suffix = ""
  for (let i = 0; i < 8; i++) suffix += alphabet[bytes[i]! % alphabet.length]
  return `WK-${suffix.slice(0, 4)}-${suffix.slice(4)}`
}

export function defaultRecruiterInviteCodeExpiresAt(nowMs = Date.now()): string {
  const expiresAt = new Date(nowMs)
  expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 1)
  return expiresAt.toISOString()
}

function maskRecruiterInviteCode(normalizedCode: string): string {
  return `${normalizedCode.slice(0, 5)}••••${normalizedCode.slice(-2)}`
}

export async function recruiterIdentityFromFirebaseBearer(
  req: { headers?: { authorization?: string }; get?: (name: string) => string | undefined },
  verifyIdToken?: (token: string) => Promise<{ uid?: string; email?: string }>,
): Promise<RecruiterFirebaseIdentity | null> {
  const auth = req.headers?.authorization ?? req.get?.("authorization") ?? req.get?.("Authorization")
  if (!auth || !auth.startsWith("Bearer ")) return null
  const token = auth.slice("Bearer ".length).trim()
  if (!token || token.includes(":")) return null
  const verify =
    verifyIdToken ??
    (async (t: string) => {
      const decoded = await getAuth().verifyIdToken(t)
      return { uid: decoded.uid, email: decoded.email }
    })
  try {
    const decoded = await verify(token)
    const uid = typeof decoded.uid === "string" ? decoded.uid.trim() : ""
    const email = typeof decoded.email === "string" ? decoded.email.trim().toLowerCase() : ""
    if (!uid || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
    return { uid, email }
  } catch {
    return null
  }
}

export function validateRecruiterRegistration(input: unknown):
  | { ok: true; value: RecruiterAccessRegistrationInput }
  | { ok: false; reason: string } {
  if (!input || typeof input !== "object") return { ok: false, reason: "missing_body" }
  const b = input as Record<string, unknown>
  if (!isNonEmptyString(b.name)) return { ok: false, reason: "missing_name" }
  if (!isNonEmptyString(b.email)) return { ok: false, reason: "missing_email" }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return { ok: false, reason: "invalid_email" }
  const inviteCodeRaw = typeof b.inviteCode === "string" ? b.inviteCode : ""
  const hasInviteCode = isNonEmptyString(inviteCodeRaw)
  if (b.name.length > 200 || b.email.length > 320 || inviteCodeRaw.length > 80) {
    return { ok: false, reason: "input_too_long" }
  }
  const legalEntityName = typeof b.legalEntityName === "string" ? b.legalEntityName.trim() : ""
  if (legalEntityName.length > 300) {
    return { ok: false, reason: "legal_entity_name_too_long" }
  }
  const base: RecruiterAccessRegistrationInput = {
    name: b.name.trim(),
    email: normalizeRecruiterEmail(b.email as string),
    inviteCode: hasInviteCode ? normalizeRecruiterInviteCode(inviteCodeRaw) : "",
  }
  if (legalEntityName) base.legalEntityName = legalEntityName
  if (b.tosAccepted === true) base.tosAccepted = true
  return { ok: true, value: base }
}

export function validateInviteCodeCreate(input: unknown):
  | { ok: true; value: RecruiterInviteCodeCreateInput }
  | { ok: false; reason: string } {
  const b = input && typeof input === "object" ? input as Record<string, unknown> : {}
  const maxUsesRaw = b.maxUses === undefined ? 1 : Number(b.maxUses)
  if (maxUsesRaw !== 1) {
    return { ok: false, reason: "invalid_max_uses" }
  }
  let code: string | undefined
  if (b.code !== undefined) {
    if (!isNonEmptyString(b.code) || b.code.length > 80) return { ok: false, reason: "invalid_code" }
    code = normalizeRecruiterInviteCode(b.code)
    if (!/^WK-[A-Z0-9-]{4,40}$/.test(code)) return { ok: false, reason: "invalid_code" }
  }
  let label: string | undefined
  if (b.label !== undefined) {
    if (typeof b.label !== "string" || b.label.length > 200) return { ok: false, reason: "invalid_label" }
    label = b.label.trim() || undefined
  }
  const sendEmail = b.sendEmail === undefined ? false : b.sendEmail === true
  if (b.sendEmail !== undefined && typeof b.sendEmail !== "boolean") return { ok: false, reason: "invalid_send_email" }
  let recruiterEmail: string | undefined
  if (b.recruiterEmail !== undefined) {
    if (typeof b.recruiterEmail !== "string" || b.recruiterEmail.length > 320) {
      return { ok: false, reason: "invalid_recruiter_email" }
    }
    recruiterEmail = normalizeRecruiterEmail(b.recruiterEmail)
    if (!validEmail(recruiterEmail)) return { ok: false, reason: "invalid_recruiter_email" }
  }
  if (sendEmail && !recruiterEmail) return { ok: false, reason: "missing_recruiter_email" }
  let expiresAt = defaultRecruiterInviteCodeExpiresAt()
  if (b.expiresAt !== undefined) {
    if (typeof b.expiresAt !== "string") return { ok: false, reason: "invalid_expires_at" }
    const ms = Date.parse(b.expiresAt)
    if (Number.isNaN(ms) || ms <= Date.now()) return { ok: false, reason: "invalid_expires_at" }
    expiresAt = new Date(ms).toISOString()
  }
  return { ok: true, value: { code, label, recruiterEmail, sendEmail, maxUses: 1, expiresAt } }
}

export function validateInviteCodeReplace(input: unknown):
  | { ok: true; value: RecruiterInviteCodeReplaceInput }
  | { ok: false; reason: string } {
  if (!input || typeof input !== "object") return { ok: false, reason: "missing_body" }
  const b = input as Record<string, unknown>
  if (!isNonEmptyString(b.inviteCodeId)) return { ok: false, reason: "missing_invite_code_id" }
  const inviteCodeId = b.inviteCodeId.trim()
  if (!/^[a-f0-9]{64}$/i.test(inviteCodeId)) return { ok: false, reason: "invalid_invite_code_id" }
  return { ok: true, value: { inviteCodeId } }
}

export function validateInviteCodeResend(input: unknown):
  | { ok: true; value: RecruiterInviteCodeResendInput }
  | { ok: false; reason: string } {
  return validateInviteCodeReplace(input)
}

export function validateInviteCodeRestore(input: unknown):
  | { ok: true; value: RecruiterInviteCodeRestoreInput }
  | { ok: false; reason: string } {
  if (!input || typeof input !== "object") return { ok: false, reason: "missing_body" }
  const b = input as Record<string, unknown>
  const replaceValidation = validateInviteCodeReplace({ inviteCodeId: b.inviteCodeId })
  if (!replaceValidation.ok) return replaceValidation
  if (!isNonEmptyString(b.inviteCode) || b.inviteCode.length > 80) return { ok: false, reason: "invalid_code" }
  const inviteCode = normalizeRecruiterInviteCode(b.inviteCode)
  if (!/^WK-[A-Z0-9-]{4,40}$/.test(inviteCode)) return { ok: false, reason: "invalid_code" }
  return {
    ok: true,
    value: {
      inviteCodeId: replaceValidation.value.inviteCodeId,
      inviteCode,
    },
  }
}

function buildRecruiterInviteCodeDoc(input: {
  inviteCodeId: string
  inviteCode: string
  label?: string | null
  recruiterEmail?: string | null
  sendEmail?: boolean
  expiresAt?: string | null
  createdByEmail: string
  replacesInviteCodeId?: string
}): Record<string, unknown> {
  return {
    inviteCodeId: input.inviteCodeId,
    inviteCode: input.inviteCode,
    active: true,
    label: input.label ?? null,
    recruiterEmail: input.recruiterEmail ?? null,
    codePreview: maskRecruiterInviteCode(input.inviteCode),
    maxUses: 1,
    usedCount: 0,
    expiresAt: input.expiresAt ?? null,
    inviteEmailStatus: input.sendEmail ? "queued" : "not_requested",
    inviteEmailRequestedByEmail: input.sendEmail ? input.createdByEmail : null,
    createdByEmail: input.createdByEmail,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...(input.replacesInviteCodeId ? { replacesInviteCodeId: input.replacesInviteCodeId } : {}),
  }
}

function readNotificationPreferences(data: Record<string, unknown> | null | undefined): RecruiterNotificationPreferences {
  const raw = data?.notificationPreferences
  const prefs = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  return {
    newRolesEmail: prefs.newRolesEmail !== false,
    submissionUpdatesEmail: prefs.submissionUpdatesEmail !== false,
  }
}

export function recruiterSubmissionUpdateEmailsEnabled(
  profile: Record<string, unknown> | null | undefined,
): boolean {
  return readNotificationPreferences(profile).submissionUpdatesEmail
}

function readWorkspacePreferences(data: Record<string, unknown> | null | undefined): RecruiterWorkspacePreferences {
  const raw = data?.workspacePreferences
  const prefs = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  const roleIds = Array.isArray(prefs.primaryRoleIds)
    ? prefs.primaryRoleIds
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter(Boolean)
    : []
  return { primaryRoleIds: [...new Set(roleIds)].slice(0, RECRUITER_PRIMARY_ROLE_SLOT_LIMIT) }
}

function publicRecruiterNotification(
  doc: { id: string; data: () => Record<string, unknown> | undefined },
): RecruiterNotificationListItem {
  const data = doc.data() ?? {}
  const type = typeof data.type === "string" && data.type.trim() ? data.type.trim() : "notification"
  const roleTitle = typeof data.roleTitle === "string" ? data.roleTitle.trim() : ""
  const companyLabel = typeof data.companyLabel === "string" ? data.companyLabel.trim() : ""
  const fallbackTitle =
    type === "new_role" ? "New role released" :
    type === "role_application_decision" ? "Role application reviewed" :
    type === "candidate_confirmation" ? "Candidate confirmation update" :
    type === "payout_update" ? "Payout update" :
    type === "submission_comment" ? "Submission comment" :
    type === "submission_feedback" ? "Submission update" :
    "Recruiter notification"
  const fallbackBody =
    type === "new_role"
      ? [roleTitle || "A new WeKruit role", companyLabel].filter(Boolean).join(" · ")
      : roleTitle || companyLabel || "Open the recruiter workspace for details."
  return {
    id: doc.id,
    notificationId: typeof data.notificationId === "string" ? data.notificationId : doc.id,
    type,
    status: typeof data.status === "string" ? data.status : undefined,
    title: typeof data.title === "string" && data.title.trim() ? data.title.trim() : fallbackTitle,
    body: typeof data.body === "string" && data.body.trim() ? data.body.trim() : fallbackBody,
    recruiterId: typeof data.recruiterId === "string" ? data.recruiterId : undefined,
    recruiterEmail: typeof data.recruiterEmail === "string" ? data.recruiterEmail : undefined,
    entityType: typeof data.entityType === "string" ? data.entityType : undefined,
    entityId: typeof data.entityId === "string" ? data.entityId : undefined,
    jobId: typeof data.jobId === "string" ? data.jobId : undefined,
    publicJobId: typeof data.publicJobId === "string" ? data.publicJobId : undefined,
    roleTitle: roleTitle || undefined,
    companyLabel: companyLabel || undefined,
    location: typeof data.location === "string" ? data.location : undefined,
    roleUrl: typeof data.roleUrl === "string" ? data.roleUrl : undefined,
    readAt: coerceToIso(data.readAt),
    createdAt: coerceToIso(data.createdAt),
    updatedAt: coerceToIso(data.updatedAt),
  }
}

export function validateRecruiterNotificationsReadInput(input: unknown):
  | { ok: true; value: { all: boolean; notificationIds: string[] } }
  | { ok: false; reason: string } {
  if (!input || typeof input !== "object") return { ok: false, reason: "missing_body" }
  const body = input as Record<string, unknown>
  const all = body.all === true
  const notificationIds: string[] = []
  if (body.notificationIds !== undefined) {
    if (!Array.isArray(body.notificationIds)) return { ok: false, reason: "invalid_notification_ids" }
    for (const raw of body.notificationIds) {
      if (typeof raw !== "string") return { ok: false, reason: "invalid_notification_ids" }
      const id = raw.trim()
      if (!id || id.length > 160 || !/^[A-Za-z0-9_-]+$/.test(id)) return { ok: false, reason: "invalid_notification_ids" }
      if (!notificationIds.includes(id)) notificationIds.push(id)
    }
  }
  if (!all && notificationIds.length === 0) return { ok: false, reason: "missing_notification_ids" }
  if (notificationIds.length > 100) return { ok: false, reason: "too_many_notification_ids" }
  return { ok: true, value: { all, notificationIds } }
}

export function mergeRecruiterNotificationPreferences(
  current: RecruiterNotificationPreferences,
  input: unknown,
): { ok: true; value: RecruiterNotificationPreferences } | { ok: false; reason: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "invalid_notification_preferences" }
  }
  const body = input as Record<string, unknown>
  if (body.newRolesEmail !== undefined && typeof body.newRolesEmail !== "boolean") {
    return { ok: false, reason: "invalid_new_roles_email" }
  }
  if (body.submissionUpdatesEmail !== undefined && typeof body.submissionUpdatesEmail !== "boolean") {
    return { ok: false, reason: "invalid_submission_updates_email" }
  }
  if (body.newRolesEmail === undefined && body.submissionUpdatesEmail === undefined) {
    return { ok: false, reason: "missing_notification_preferences_update" }
  }
  return {
    ok: true,
    value: {
      newRolesEmail: typeof body.newRolesEmail === "boolean" ? body.newRolesEmail : current.newRolesEmail,
      submissionUpdatesEmail: typeof body.submissionUpdatesEmail === "boolean"
        ? body.submissionUpdatesEmail
        : current.submissionUpdatesEmail,
    },
  }
}

export function validateRecruiterWorkspacePreferences(input: unknown):
  | { ok: true; value: RecruiterWorkspacePreferences }
  | { ok: false; reason: string } {
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {}
  if (!Array.isArray(body.primaryRoleIds)) return { ok: false, reason: "invalid_primary_role_ids" }
  const primaryRoleIds: string[] = []
  for (const raw of body.primaryRoleIds) {
    if (typeof raw !== "string") return { ok: false, reason: "invalid_primary_role_ids" }
    const id = raw.trim()
    if (!id || id.length > 160) return { ok: false, reason: "invalid_primary_role_ids" }
    if (!primaryRoleIds.includes(id)) primaryRoleIds.push(id)
  }
  if (primaryRoleIds.length > RECRUITER_PRIMARY_ROLE_SLOT_LIMIT) {
    return { ok: false, reason: "too_many_primary_roles" }
  }
  return { ok: true, value: { primaryRoleIds } }
}

function inviteCodeExpired(data: Record<string, unknown>, nowMs: number): boolean {
  const expiresAtIso = coerceToIso(data.expiresAt)
  if (!expiresAtIso) return false
  const expiresAtMs = Date.parse(expiresAtIso)
  return Number.isNaN(expiresAtMs) ? false : expiresAtMs <= nowMs
}

function candidateInviteCodeIds(normalizedCode: string): string[] {
  const hashedId = hashRecruiterInviteCode(normalizedCode)
  return hashedId === normalizedCode ? [hashedId] : [hashedId, normalizedCode]
}

export function inviteCodeUsable(data: Record<string, unknown>, nowMs: number): boolean {
  if (data.active === false) return false
  if (inviteCodeExpired(data, nowMs)) return false
  const usedCount = typeof data.usedCount === "number" ? data.usedCount : 0
  return usedCount < 1
}

export function recruiterInviteCodeMatchesBoundUser(
  existingData: Record<string, unknown> | null | undefined,
  normalizedCode: string,
): boolean {
  const inviteCodeId = typeof existingData?.inviteCodeId === "string" ? existingData.inviteCodeId.trim() : ""
  return Boolean(inviteCodeId && candidateInviteCodeIds(normalizedCode).includes(inviteCodeId))
}

export function recruiterInviteCodeAllowsEmail(
  inviteCodeData: Record<string, unknown> | null | undefined,
  recruiterEmail: string,
): boolean {
  const invitedEmail = typeof inviteCodeData?.recruiterEmail === "string"
    ? normalizeRecruiterEmail(inviteCodeData.recruiterEmail)
    : ""
  return !invitedEmail || invitedEmail === normalizeRecruiterEmail(recruiterEmail)
}

export async function resolveRecruiterInviteRefByEmail(
  db: Firestore,
  recruiterEmail: string,
  nowMs = Date.now(),
): Promise<DocumentReference | null> {
  const snapshot = await db.collection(RECRUITER_INVITE_CODES_COLLECTION)
    .where("recruiterEmail", "==", normalizeRecruiterEmail(recruiterEmail))
    .get()
  let best: { ref: DocumentReference; createdAtMs: number } | null = null
  for (const doc of snapshot.docs) {
    const data = doc.data() as Record<string, unknown> | undefined
    if (!data || !inviteCodeUsable(data, nowMs)) continue
    const createdAtIso = coerceToIso(data.createdAt)
    const createdAtMs = createdAtIso ? Date.parse(createdAtIso) : 0
    if (!best || createdAtMs > best.createdAtMs) best = { ref: doc.ref, createdAtMs }
  }
  return best?.ref ?? null
}

export async function registerRecruiterAccess(
  db: Firestore,
  identity: RecruiterFirebaseIdentity,
  input: RecruiterAccessRegistrationInput,
): Promise<RecruiterProfilePublic | null> {
  if (identity.email !== input.email) {
    throw new Error("email_mismatch")
  }
  const recruiterId = identity.uid
  const tosAcceptedAt = input.tosAccepted ? new Date().toISOString() : undefined
  const recruiterBase: RecruiterProfilePublic = {
    recruiterId,
    firebaseUid: identity.uid,
    name: input.name,
    email: identity.email,
    ...(input.legalEntityName ? { legalEntityName: input.legalEntityName } : {}),
    ...(tosAcceptedAt ? { tosAcceptedAt } : {}),
    notificationPreferences: { newRolesEmail: true, submissionUpdatesEmail: true },
    workspacePreferences: { primaryRoleIds: [] },
  }

  // Codeless claims resolve the invite by the invited email. The query cannot
  // run inside the transaction, so resolve a candidate ref up front and
  // re-validate it via tx.get below to keep the claim race-safe.
  const emailResolvedInviteRef = input.inviteCode
    ? null
    : await resolveRecruiterInviteRefByEmail(db, identity.email)

  const result = await db.runTransaction(async (tx) => {
    const nowMs = Date.now()
    const userRef = db.collection(RECRUITER_USERS_COLLECTION).doc(recruiterId)
    const existingUser = await tx.get(userRef)
    const existingData = existingUser.exists ? existingUser.data() as Record<string, unknown> : null
    if (existingData?.status === "disabled") return null

    if (existingUser.exists) {
      const existingEmail = typeof existingData?.email === "string" ? existingData.email.trim().toLowerCase() : ""
      if (existingEmail && existingEmail !== identity.email) throw new Error("email_mismatch")
      if (input.inviteCode && !recruiterInviteCodeMatchesBoundUser(existingData, input.inviteCode)) return null
      const notificationPreferences = readNotificationPreferences(existingData)
      const workspacePreferences = readWorkspacePreferences(existingData)
      const recruiter = { ...recruiterBase, notificationPreferences, workspacePreferences }
      tx.set(userRef, {
        ...recruiter,
        status: "active",
        lastSeenAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
      return recruiter
    }

    let inviteId: string | null = null
    let inviteRef: DocumentReference | null = null
    if (input.inviteCode) {
      for (const id of candidateInviteCodeIds(input.inviteCode)) {
        const ref = db.collection(RECRUITER_INVITE_CODES_COLLECTION).doc(id)
        const snap = await tx.get(ref)
        if (!snap.exists) continue
        const data = snap.data() as Record<string, unknown>
        if (!inviteCodeUsable(data, nowMs)) return null
        if (!recruiterInviteCodeAllowsEmail(data, identity.email)) throw new Error("email_mismatch")
        inviteId = id
        inviteRef = ref
        break
      }
    } else if (emailResolvedInviteRef) {
      const snap = await tx.get(emailResolvedInviteRef)
      if (snap.exists) {
        const data = snap.data() as Record<string, unknown>
        if (inviteCodeUsable(data, nowMs) && recruiterInviteCodeAllowsEmail(data, identity.email)) {
          inviteId = emailResolvedInviteRef.id
          inviteRef = emailResolvedInviteRef
        }
      }
    }
    if (!inviteId || !inviteRef) return null

    const recruiter = {
      ...recruiterBase,
      notificationPreferences: { newRolesEmail: true, submissionUpdatesEmail: true },
      workspacePreferences: { primaryRoleIds: [] },
    }

    tx.set(userRef, {
      ...recruiter,
      status: "active",
      inviteCodeId: inviteId,
      registeredAt: FieldValue.serverTimestamp(),
      lastSeenAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })
    tx.set(inviteRef, {
      usedCount: FieldValue.increment(1),
      lastUsedAt: FieldValue.serverTimestamp(),
      lastUsedByUid: identity.uid,
      lastUsedByEmail: identity.email,
    }, { merge: true })
    return recruiter
  })

  return result
}

async function authenticateRecruiter(
  db: Firestore,
  req: { headers?: { authorization?: string }; get?: (name: string) => string | undefined },
): Promise<RecruiterProfilePublic | null> {
  const identity = await recruiterIdentityFromFirebaseBearer(req)
  if (!identity) return null
  const snap = await db.collection(RECRUITER_USERS_COLLECTION).doc(identity.uid).get()
  if (!snap.exists) return null
  const data = snap.data() as Record<string, unknown>
  if (data.status === "disabled") return null
  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : ""
  if (email !== identity.email) return null
  return {
    recruiterId: identity.uid,
    firebaseUid: identity.uid,
    name: String(data.name ?? ""),
    email,
    ...(typeof data.legalEntityName === "string" ? { legalEntityName: data.legalEntityName } : {}),
    ...(typeof data.tosAcceptedAt === "string" ? { tosAcceptedAt: data.tosAcceptedAt } : {}),
    notificationPreferences: readNotificationPreferences(data),
    workspacePreferences: readWorkspacePreferences(data),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// paCollabJobsList — public GET (+ admin-elevated view via Bearer token)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strips the real company name from a recruiter-board label when the
 * caller is not a hiring-board admin. The anonymized form is expected to
 * be of the shape `"Co. X · <description>"`; if upstream content already
 * contains a real name we fall back to `"Co. <companyCode>"` so we never
 * leak identity even on a malformed doc.
 */
function anonymizeCompanyLabel(
  label: RecruiterBoardLabel,
): RecruiterBoardLabel {
  const raw = label.company ?? ""
  // Already in the expected `"Co. A · ..."` shape — pass through.
  if (/^Co\.\s/.test(raw)) {
    return label
  }
  const code = (label.companyCode ?? "X").trim() || "X"
  return {
    ...label,
    company: `Co. ${code}`,
  }
}

export interface FetchCollabJobsOptions {
  isAdmin: boolean
  /** `"open"` = `recruiterBoard.active === true` (default). `"filled"` = `active === false`. */
  status?: "open" | "filled"
  /** ISO-8601. Returns only jobs whose `recruiterBoard.updatedAt` is strictly greater. */
  since?: string
  /** 1..200, clamped. Defaults to 50 in the HTTP layer. Undefined here = no limit. */
  limit?: number
  /** Defaults to 0. */
  offset?: number
}

export interface FetchCollabJobsResult {
  jobs: PublicCollabJob[]
  total: number
  nextOffset: number | null
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/**
 * Coerces a Firestore Timestamp / Date / ISO string / number into ISO-8601,
 * or `null` if the value is missing/unparseable.
 */
function coerceToIso(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  // Firestore Timestamp: has `toDate()` method.
  if (typeof value === "object" && value !== null && typeof (value as { toDate?: unknown }).toDate === "function") {
    const d = (value as Timestamp).toDate()
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof value === "number") {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof value === "string") {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

function extractJobUpdatedAt(
  rb: RecruiterBoardPayload | undefined,
  docData: Record<string, unknown>,
): string | null {
  const rbUpdated = (rb as unknown as Record<string, unknown> | undefined)?.updatedAt
  return coerceToIso(rbUpdated) ?? coerceToIso(docData.updatedAt)
}

/**
 * Sort-order fallback for synthesized payloads. Large so un-curated rows
 * always sort after every explicitly-ordered (seeded) row.
 */
const SYNTHESIZED_SORT_ORDER = 1_000_000

/**
 * pa-jobs docs flip to `wekruitCollaborationStatus === "collaborated"` before
 * an operator curates a `recruiterBoard` payload. Those docs used to be
 * silently dropped (`if (!rb) continue`), which made newly-collaborated jobs
 * invisible on the recruiter board until someone hand-seeded a payload.
 * Synthesize a minimal default instead: active, company label from the job
 * doc, large sortOrder so curated rows keep their order. Docs explicitly
 * marked `recruiterBoard.active === false` are untouched — a deliberate hide
 * always wins over synthesis.
 */
function synthesizeRecruiterBoardPayload(d: Record<string, unknown>): RecruiterBoardPayload {
  const company = String(d.companyName ?? d.company ?? "").trim()
  const location = typeof d.location === "string" ? d.location.trim() : ""
  return {
    active: true,
    sortOrder: SYNTHESIZED_SORT_ORDER,
    label: {
      company: company || "Collaborated company",
      companyCode: "",
      location,
      pills: [],
    },
    culture: { bet: "", bullets: [] },
    checklist: { groups: [] },
  }
}

function normalizeCompanyId(raw: string): string {
  if (typeof raw !== "string") return ""
  const bounded = raw.slice(0, 200).toLowerCase()
  const collapsed = bounded.replace(/[^a-z0-9]+/g, "-")
  let start = 0
  let end = collapsed.length
  while (start < end && collapsed.charCodeAt(start) === 45) start++
  while (end > start && collapsed.charCodeAt(end - 1) === 45) end--
  return collapsed.slice(start, end).slice(0, 100)
}

export async function fetchCollabJobs(
  db: Firestore,
  options: FetchCollabJobsOptions = { isAdmin: false },
): Promise<FetchCollabJobsResult> {
  const wantStatus: "open" | "filled" = options.status ?? "open"
  const wantActive = wantStatus === "open"

  // Validate `since` once up front so a malformed value fails fast in the
  // HTTP layer rather than silently filtering nothing.
  let sinceMs: number | null = null
  if (options.since !== undefined) {
    const parsed = Date.parse(options.since)
    if (Number.isNaN(parsed)) {
      throw new Error(`invalid_since:${options.since}`)
    }
    sinceMs = parsed
  }

  const snap = await db
    .collection("pa-jobs")
    .where("wekruitCollaborationStatus", "==", "collaborated")
    .get()

  const allMatching: PublicCollabJob[] = []
  const companyIdMap = new Map<string, string>()
  const synthesizedIds: string[] = []
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>
    const storedRb = d.recruiterBoard as RecruiterBoardPayload | undefined
    const rb: RecruiterBoardPayload = storedRb ?? synthesizeRecruiterBoardPayload(d)
    if (!storedRb) synthesizedIds.push(doc.id)
    if (Boolean(rb.active) !== wantActive) continue

    const updatedAtIso = extractJobUpdatedAt(rb, d)
    if (sinceMs !== null) {
      if (updatedAtIso === null) continue
      const updatedMs = Date.parse(updatedAtIso)
      if (Number.isNaN(updatedMs) || updatedMs <= sinceMs) continue
    }

    const publicId = typeof d.publicId === "string" ? d.publicId : undefined
    // Admin path: keep real Firestore doc id so admin operations resolve
    // against the same id used elsewhere in the dashboard. Non-admin: use
    // the opaque publicId; fall back to doc id only if the migration
    // hasn't run yet on this doc.
    const jobIdForCaller = options.isAdmin
      ? doc.id
      : (publicId ?? doc.id)

    const recruiterBoardForCaller: RecruiterBoardPayload = rb

    const companyRaw = String(d.companyName ?? d.company ?? "")
    let revealedCompany = recruiterBoardForCaller.label.company
    if (companyRaw) {
      const oldLabel = recruiterBoardForCaller.label.company ?? ""
      const sepIdx = oldLabel.indexOf(" · ")
      const description = sepIdx >= 0 ? oldLabel.slice(sepIdx) : ""
      revealedCompany = companyRaw + description
    }
    // Strip the raw stored priority before spreading — it carries admin-only
    // `note`/`emailAudience`. Re-add only the recruiter-safe sanitized slice
    // (omitted entirely for normal/unranked roles).
    const { priority: rawPriority, ...boardWithoutPriority } = recruiterBoardForCaller
    const priority = publicRecruiterBoardPriority(rawPriority)
    const revealedBoard: RecruiterBoardPayload = {
      ...boardWithoutPriority,
      ...(companyRaw ? { label: { ...recruiterBoardForCaller.label, company: revealedCompany } } : {}),
      ...(priority ? { priority } : {}),
    }
    allMatching.push({
      jobId: jobIdForCaller,
      title: String(d.title ?? ""),
      compSummary: typeof d.compSummary === "string" ? d.compSummary : undefined,
      jdBlocks: Array.isArray(d.jdBlocks) ? (d.jdBlocks as JdBlock[]) : [],
      recruiterBoard: revealedBoard,
      updatedAt: updatedAtIso,
    })
    const cid = normalizeCompanyId(companyRaw)
    if (cid) companyIdMap.set(jobIdForCaller, cid)
  }

  // Drift visibility: un-curated collaborated jobs are now surfaced with a
  // synthesized default payload. Log so ops can see which rows still need a
  // real recruiterBoard payload.
  if (synthesizedIds.length > 0) {
    logger.info("recruiter_board.synthesized_default_payload", {
      count: synthesizedIds.length,
      ids: synthesizedIds,
    })
  }

  // Hydrate company website from pa-companies.
  const uniqueCompanyIds = new Set(companyIdMap.values())
  if (uniqueCompanyIds.size > 0) {
    try {
      const refs = Array.from(uniqueCompanyIds).map((id) => db.collection("pa-companies").doc(id))
      const docs = await db.getAll(...refs)
      const domainById = new Map<string, string>()
      for (const d of docs) {
        if (!d.exists) continue
        const data = d.data() as Record<string, unknown> | undefined
        const domain = typeof data?.domain === "string" ? data.domain.trim() : ""
        if (domain) domainById.set(d.id, `https://${domain}`)
      }
      for (const job of allMatching) {
        const cid = companyIdMap.get(job.jobId)
        const website = cid ? domainById.get(cid) : undefined
        if (website) job.companyWebsite = website
      }
    } catch (e) {
      logger.warn("pa-companies hydration failed, continuing without websites", { error: String(e) })
    }
  }

  // Priority first (urgent → paused, ranked floats up), then the curated
  // sortOrder as the stable tiebreak.
  allMatching.sort((a, b) => {
    const pa = priorityScore(a.recruiterBoard.priority)
    const pb = priorityScore(b.recruiterBoard.priority)
    if (pa !== pb) return pa - pb
    return a.recruiterBoard.sortOrder - b.recruiterBoard.sortOrder
  })

  const total = allMatching.length
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  let limit = options.limit === undefined
    ? total - offset // no explicit limit -> return everything left
    : Math.max(0, Math.floor(options.limit))
  // Clamp explicit limits to MAX_LIMIT. When the caller passes no limit we
  // already used `total - offset`, so the clamp here is only for callers that
  // ask for more than the cap.
  if (options.limit !== undefined && limit > MAX_LIMIT) limit = MAX_LIMIT

  const pageEnd = offset + limit
  const jobs = allMatching.slice(offset, pageEnd)
  const nextOffset = pageEnd < total ? pageEnd : null

  return { jobs, total, nextOffset }
}

function parseQueryString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function parseQueryInt(value: unknown): { ok: true; value: number } | { ok: false } {
  const raw = parseQueryString(value)
  if (raw === undefined) return { ok: false }
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) return { ok: false }
  return { ok: true, value: parsed }
}

export const paCollabJobsList = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }

    const limitParsed = parseQueryInt(req.query.limit)
    const offsetParsed = parseQueryInt(req.query.offset)
    if (req.query.limit !== undefined && !limitParsed.ok) {
      res.status(400).json({ ok: false, reason: "invalid_limit" })
      return
    }
    if (req.query.offset !== undefined && !offsetParsed.ok) {
      res.status(400).json({ ok: false, reason: "invalid_offset" })
      return
    }
    const limit = limitParsed.ok
      ? Math.min(Math.max(1, limitParsed.value), MAX_LIMIT)
      : DEFAULT_LIMIT
    const offset = offsetParsed.ok ? Math.max(0, offsetParsed.value) : 0

    const since = parseQueryString(req.query.since)
    const statusRaw = parseQueryString(req.query.status)?.toLowerCase()
    let status: "open" | "filled" = "open"
    if (statusRaw !== undefined) {
      if (statusRaw !== "open" && statusRaw !== "filled") {
        res.status(400).json({ ok: false, reason: "invalid_status" })
        return
      }
      status = statusRaw
    }

    try {
      const isAdmin = await isHiringBoardAdmin(req)
      const { jobs, total, nextOffset } = await fetchCollabJobs(getFirestore(), {
        isAdmin,
        status,
        since,
        limit,
        offset,
      })
      // Admin payloads contain real company identity — never cache on a
      // shared/CDN layer. Anonymous payloads are safe to cache (60s).
      if (isAdmin) {
        res.set("Cache-Control", "private, max-age=0, no-store")
      } else {
        res.set("Cache-Control", "public, max-age=60, s-maxage=60")
      }
      const body: CollabJobsListResponse = { ok: true, jobs, total, nextOffset }
      res.status(200).json(body)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.startsWith("invalid_since:")) {
        res.status(400).json({ ok: false, reason: "invalid_since" })
        return
      }
      logger.error("paCollabJobsList_failed", { error: message })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// paCollabJobsListSchema — frozen JSON Schema for the list response shape
// ─────────────────────────────────────────────────────────────────────────────

const COLLAB_JOBS_LIST_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://wekruit.com/schemas/collab-jobs-list-response.json",
  title: "CollabJobsListResponse",
  description:
    "Response from GET paCollabJobsList. `total` ignores offset/limit. `nextOffset` is null on the final page.",
  type: "object",
  required: ["ok", "jobs", "total", "nextOffset"],
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", const: true },
    total: { type: "integer", minimum: 0 },
    nextOffset: { type: ["integer", "null"], minimum: 0 },
    jobs: {
      type: "array",
      items: {
        type: "object",
        required: ["jobId", "title", "jdBlocks", "recruiterBoard", "updatedAt"],
        properties: {
          jobId: { type: "string" },
          title: { type: "string" },
          compSummary: { type: "string" },
          updatedAt: { type: ["string", "null"], format: "date-time" },
          jdBlocks: {
            type: "array",
            items: {
              type: "object",
              required: ["heading", "body"],
              properties: {
                heading: { type: "string" },
                body: { type: "string" },
                kind: { type: "string", enum: ["list", "prose"] },
              },
            },
          },
          recruiterBoard: {
            type: "object",
            required: ["active", "sortOrder", "label", "culture", "checklist"],
            properties: {
              active: { type: "boolean" },
              sortOrder: { type: "number" },
              interviewProcess: { type: "string" },
              priority: {
                type: "object",
                required: ["tier"],
                properties: {
                  tier: { type: "string", enum: ["urgent", "high", "normal", "paused"] },
                  rank: { type: ["number", "null"] },
                },
              },
              submitFields: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "label", "kind"],
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                    kind: { type: "string", enum: ["url", "text"] },
                    required: { type: "boolean" },
                    placeholder: { type: "string" },
                  },
                },
              },
              label: {
                type: "object",
                required: ["company", "companyCode", "location", "pills"],
                properties: {
                  company: { type: "string" },
                  companyCode: { type: "string" },
                  location: { type: "string" },
                  pills: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["text"],
                      properties: {
                        text: { type: "string" },
                        tone: { type: "string", enum: ["warm", "cool", "neutral"] },
                      },
                    },
                  },
                },
              },
              culture: {
                type: "object",
                required: ["bet", "bullets"],
                properties: {
                  bet: { type: "string" },
                  bullets: { type: "array", items: { type: "string" } },
                },
              },
              checklist: {
                type: "object",
                required: ["groups"],
                properties: {
                  groups: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["kind", "heading", "items"],
                      properties: {
                        kind: { type: "string", enum: ["hard", "fit", "bonus", "anti"] },
                        heading: { type: "string" },
                        items: {
                          type: "array",
                          items: {
                            type: "object",
                            required: ["id", "text"],
                            properties: {
                              id: { type: "string" },
                              text: { type: "string" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
})

export const paCollabJobsListSchema = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY, invoker: "public" },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    // The schema is frozen at deploy time, so it's safe to cache long.
    res.set("Cache-Control", "public, max-age=3600, s-maxage=3600")
    res.status(200).json(COLLAB_JOBS_LIST_SCHEMA)
  },
)

export const paRecruiterInviteCodeCreate = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY, ...ADMIN_INVITE_ENDPOINT_SCALE, secrets: [...MAILGUN_SECRETS, PA_ADMIN_TOKEN_SECRET] },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const adminEmail = await hiringBoardAdminEmail(req)
    if (!adminEmail) {
      res.status(403).json({ ok: false, reason: "forbidden" })
      return
    }
    const validated = validateInviteCodeCreate(req.body)
    if (!validated.ok) {
      res.status(400).json({ ok: false, reason: validated.reason })
      return
    }

    const db = getFirestore()
    const requestedCode = validated.value.code
    for (let attempt = 0; attempt < 5; attempt++) {
      const inviteCode = requestedCode ?? generateRecruiterInviteCode()
      const normalizedCode = normalizeRecruiterInviteCode(inviteCode)
      const codeHash = hashRecruiterInviteCode(normalizedCode)
      const ref = db.collection(RECRUITER_INVITE_CODES_COLLECTION).doc(codeHash)
      const label = validated.value.label ?? validated.value.recruiterEmail ?? null
      try {
        await ref.create(buildRecruiterInviteCodeDoc({
          inviteCodeId: codeHash,
          inviteCode: normalizedCode,
          label,
          recruiterEmail: validated.value.recruiterEmail ?? null,
          sendEmail: validated.value.sendEmail,
          expiresAt: validated.value.expiresAt ?? null,
          createdByEmail: adminEmail,
        }))
        let inviteEmailStatus: "not_requested" | "sent" = "not_requested"
        let inviteEmailMessageId: string | undefined
        if (validated.value.sendEmail && validated.value.recruiterEmail) {
          const inviteEmail = await sendRecruiterInviteEmailForCode(ref, {
            recruiterEmail: validated.value.recruiterEmail,
            inviteCode: normalizedCode,
            expiresAt: validated.value.expiresAt ?? null,
          })
          if (!inviteEmail.ok) {
            res.set("Cache-Control", "private, max-age=0, no-store")
            res.status(inviteEmail.status).json({
              ok: false,
              reason: inviteEmail.reason,
              inviteCodeId: codeHash,
              codePreview: maskRecruiterInviteCode(normalizedCode),
              recruiterEmail: validated.value.recruiterEmail,
              emailStatus: "failed",
            })
            return
          }
          inviteEmailStatus = "sent"
          inviteEmailMessageId = inviteEmail.messageId
        }
        res.set("Cache-Control", "private, max-age=0, no-store")
        res.status(200).json({
          ok: true,
          inviteCode: normalizedCode,
          inviteCodeId: codeHash,
          codePreview: maskRecruiterInviteCode(normalizedCode),
          maxUses: validated.value.maxUses,
          expiresAt: validated.value.expiresAt ?? null,
          recruiterEmail: validated.value.recruiterEmail ?? null,
          inviteUrl: recruiterInviteUrl(normalizedCode, validated.value.recruiterEmail),
          emailStatus: inviteEmailStatus,
          emailMessageId: inviteEmailMessageId,
        })
        return
      } catch (err) {
        const message = String(err)
        const alreadyExists = message.includes("ALREADY_EXISTS") || message.includes("already exists")
        if (alreadyExists && !requestedCode) continue
        logger.warn("paRecruiterInviteCodeCreate_failed", { error: message, adminEmail })
        res.status(alreadyExists ? 409 : 500).json({
          ok: false,
          reason: alreadyExists ? "invite_code_exists" : "internal_error",
        })
        return
      }
    }
    res.status(500).json({ ok: false, reason: "code_generation_collision" })
  },
)

export const paRecruiterInviteCodeResend = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY, ...ADMIN_INVITE_ENDPOINT_SCALE, secrets: [...MAILGUN_SECRETS, PA_ADMIN_TOKEN_SECRET] },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const adminEmail = await hiringBoardAdminEmail(req)
    if (!adminEmail) {
      res.status(403).json({ ok: false, reason: "forbidden" })
      return
    }
    const validated = validateInviteCodeResend(req.body)
    if (!validated.ok) {
      res.status(400).json({ ok: false, reason: validated.reason })
      return
    }

    const result = await resendRecruiterInviteCodeEmail(getFirestore(), {
      inviteCodeId: validated.value.inviteCodeId,
      adminEmail,
    })
    res.set("Cache-Control", "private, max-age=0, no-store")
    if (!result.ok) {
      res.status(result.status).json({ ok: false, reason: result.reason })
      return
    }
    res.status(200).json({
      ok: true,
      inviteCodeId: result.inviteCodeId,
      recruiterEmail: result.recruiterEmail,
      emailStatus: result.emailStatus,
      emailMessageId: result.emailMessageId,
    })
  },
)

export const paRecruiterInviteCodeReplace = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const adminEmail = await hiringBoardAdminEmail(req)
    if (!adminEmail) {
      res.status(403).json({ ok: false, reason: "forbidden" })
      return
    }
    const validated = validateInviteCodeReplace(req.body)
    if (!validated.ok) {
      res.status(400).json({ ok: false, reason: validated.reason })
      return
    }

    const db = getFirestore()
    const oldRef = db.collection(RECRUITER_INVITE_CODES_COLLECTION).doc(validated.value.inviteCodeId)
    const oldSnap = await oldRef.get()
    if (!oldSnap.exists) {
      res.status(404).json({ ok: false, reason: "invite_code_not_found" })
      return
    }
    const oldData = oldSnap.data() as Record<string, unknown>
    const rawOldCode = typeof oldData.inviteCode === "string" ? oldData.inviteCode.trim() : ""
    if (isNonEmptyString(rawOldCode)) {
      res.status(409).json({ ok: false, reason: "invite_code_already_visible" })
      return
    }
    if (!inviteCodeUsable(oldData, Date.now())) {
      res.status(409).json({ ok: false, reason: "invite_code_not_usable" })
      return
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const inviteCode = generateRecruiterInviteCode()
      const normalizedCode = normalizeRecruiterInviteCode(inviteCode)
      const inviteCodeId = hashRecruiterInviteCode(normalizedCode)
      const newRef = db.collection(RECRUITER_INVITE_CODES_COLLECTION).doc(inviteCodeId)
      const replacementExpiresAt = coerceToIso(oldData.expiresAt) ?? defaultRecruiterInviteCodeExpiresAt()
      try {
        const batch = db.batch()
        batch.create(newRef, buildRecruiterInviteCodeDoc({
          inviteCodeId,
          inviteCode: normalizedCode,
          label: typeof oldData.label === "string" ? oldData.label : null,
          recruiterEmail: typeof oldData.recruiterEmail === "string" ? oldData.recruiterEmail : null,
          expiresAt: replacementExpiresAt,
          createdByEmail: adminEmail,
          replacesInviteCodeId: validated.value.inviteCodeId,
        }))
        batch.set(oldRef, {
          active: false,
          replacedByInviteCodeId: inviteCodeId,
          replacedAt: FieldValue.serverTimestamp(),
          replacedByEmail: adminEmail,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true })
        await batch.commit()
        res.set("Cache-Control", "private, max-age=0, no-store")
        res.status(200).json({
          ok: true,
          inviteCode: normalizedCode,
          inviteCodeId,
          codePreview: maskRecruiterInviteCode(normalizedCode),
          maxUses: 1,
          expiresAt: replacementExpiresAt,
          replacedInviteCodeId: validated.value.inviteCodeId,
        })
        return
      } catch (err) {
        const message = String(err)
        const alreadyExists = message.includes("ALREADY_EXISTS") || message.includes("already exists")
        if (alreadyExists) continue
        logger.warn("paRecruiterInviteCodeReplace_failed", {
          error: message,
          adminEmail,
          inviteCodeId: validated.value.inviteCodeId,
        })
        res.status(500).json({ ok: false, reason: "internal_error" })
        return
      }
    }
    res.status(500).json({ ok: false, reason: "code_generation_collision" })
  },
)

export const paRecruiterInviteCodeRestore = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const adminEmail = await hiringBoardAdminEmail(req)
    if (!adminEmail) {
      res.status(403).json({ ok: false, reason: "forbidden" })
      return
    }
    const validated = validateInviteCodeRestore(req.body)
    if (!validated.ok) {
      res.status(400).json({ ok: false, reason: validated.reason })
      return
    }

    const { inviteCodeId, inviteCode } = validated.value
    const expectedId = hashRecruiterInviteCode(inviteCode)
    if (expectedId !== inviteCodeId) {
      res.status(400).json({ ok: false, reason: "code_does_not_match_row" })
      return
    }

    const ref = getFirestore().collection(RECRUITER_INVITE_CODES_COLLECTION).doc(inviteCodeId)
    const snap = await ref.get()
    if (!snap.exists) {
      res.status(404).json({ ok: false, reason: "invite_code_not_found" })
      return
    }
    const data = snap.data() as Record<string, unknown>
    if (!inviteCodeUsable(data, Date.now())) {
      res.status(409).json({ ok: false, reason: "invite_code_not_usable" })
      return
    }
    const rawOldCode = typeof data.inviteCode === "string" ? data.inviteCode.trim() : ""
    if (isNonEmptyString(rawOldCode) && normalizeRecruiterInviteCode(rawOldCode) !== inviteCode) {
      res.status(409).json({ ok: false, reason: "invite_code_already_visible" })
      return
    }

    await ref.set({
      inviteCode,
      codePreview: maskRecruiterInviteCode(inviteCode),
      restoredByEmail: adminEmail,
      restoredAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })

    res.set("Cache-Control", "private, max-age=0, no-store")
    res.status(200).json({
      ok: true,
      inviteCode,
      inviteCodeId,
      codePreview: maskRecruiterInviteCode(inviteCode),
      maxUses: typeof data.maxUses === "number" ? data.maxUses : 1,
      expiresAt: coerceToIso(data.expiresAt) ?? null,
    })
  },
)

export const paRecruiterAccess = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const identity = await recruiterIdentityFromFirebaseBearer(req)
    if (!identity) {
      res.status(401).json({ ok: false, reason: "firebase_auth_required" })
      return
    }
    const validated = validateRecruiterRegistration(req.body)
    if (!validated.ok) {
      res.status(400).json({ ok: false, reason: validated.reason })
      return
    }
    try {
      const recruiter = await registerRecruiterAccess(getFirestore(), identity, validated.value)
      if (!recruiter) {
        res.status(403).json({ ok: false, reason: "invalid_or_expired_invite_code" })
        return
      }
      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({ ok: true, recruiterId: recruiter.recruiterId, recruiter })
    } catch (err) {
      const reason = String(err).includes("email_mismatch") ? "email_mismatch" : "internal_error"
      logger.error("paRecruiterAccess_failed", { error: String(err), uid: identity.uid })
      res.status(reason === "email_mismatch" ? 403 : 500).json({ ok: false, reason })
    }
  },
)

export const paRecruiterMe = onRequest(
  // First call of every recruiter session. minInstances:1 keeps one warm so a
  // cold start can't surface as a transient profile-load failure on the client.
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY, minInstances: 1 },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    try {
      const recruiter = await authenticateRecruiter(getFirestore(), req)
      if (!recruiter) {
        res.status(401).json({ ok: false, reason: "unauthorized" })
        return
      }
      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({ ok: true, recruiterId: recruiter.recruiterId, recruiter })
    } catch (err) {
      // A transient Firestore/auth error must be observable (it previously
      // surfaced as an unlogged 500) and return a clean body the client retries.
      logger.error("paRecruiterMe_failed", { error: String(err) })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

export const paRecruiterNotificationsList = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const recruiter = await authenticateRecruiter(getFirestore(), req)
    if (!recruiter) {
      res.status(401).json({ ok: false, reason: "unauthorized" })
      return
    }
    try {
      const snap = await getFirestore()
        .collection(RECRUITER_NOTIFICATIONS_COLLECTION)
        .where("recruiterId", "==", recruiter.recruiterId)
        .limit(100)
        .get()
      const notifications = snap.docs
        .map(publicRecruiterNotification)
        .sort((a, b) => (Date.parse(b.createdAt ?? "") || 0) - (Date.parse(a.createdAt ?? "") || 0))
      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({ ok: true, notifications })
    } catch (err) {
      logger.error("paRecruiterNotificationsList_failed", { error: String(err), recruiterId: recruiter.recruiterId })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

export const paRecruiterNotificationsRead = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const db = getFirestore()
    const recruiter = await authenticateRecruiter(db, req)
    if (!recruiter) {
      res.status(401).json({ ok: false, reason: "unauthorized" })
      return
    }
    const validated = validateRecruiterNotificationsReadInput(req.body)
    if (!validated.ok) {
      res.status(400).json({ ok: false, reason: validated.reason })
      return
    }
    try {
      const refs = []
      if (validated.value.all) {
        const snap = await db
          .collection(RECRUITER_NOTIFICATIONS_COLLECTION)
          .where("recruiterId", "==", recruiter.recruiterId)
          .limit(100)
          .get()
        refs.push(...snap.docs.filter((doc) => !doc.data().readAt).map((doc) => doc.ref))
      } else {
        for (const id of validated.value.notificationIds) {
          const ref = db.collection(RECRUITER_NOTIFICATIONS_COLLECTION).doc(id)
          const snap = await ref.get()
          if (!snap.exists) continue
          if ((snap.data() as Record<string, unknown>).recruiterId !== recruiter.recruiterId) continue
          refs.push(ref)
        }
      }
      const batch = db.batch()
      for (const ref of refs) {
        batch.set(ref, {
          readAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true })
      }
      if (refs.length > 0) await batch.commit()
      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({ ok: true, updated: refs.length })
    } catch (err) {
      logger.error("paRecruiterNotificationsRead_failed", { error: String(err), recruiterId: recruiter.recruiterId })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

/**
 * Sheet-model checklist cell values. Legacy clients send booleans; they are
 * coerced on input (`true` → `"yes"`, `false` → dropped) and the string map is
 * what gets persisted. Scoring counts `"strong"` and `"yes"` as checked;
 * `"partial"` and `"no"` do not count.
 */
export const CHECKLIST_CELL_LEVELS = ["strong", "yes", "partial", "no"] as const

export type ChecklistCellLevel = (typeof CHECKLIST_CELL_LEVELS)[number]

function isChecklistCellLevel(v: unknown): v is ChecklistCellLevel {
  return typeof v === "string" && (CHECKLIST_CELL_LEVELS as readonly string[]).includes(v)
}

/**
 * Coerces a caller-provided checklist map into the canonical string-level map.
 * Accepts legacy booleans (`true` → `"yes"`, `false` → dropped) alongside the
 * four string levels; anything else rejects the payload.
 */
export function coerceSubmissionChecklistInput(raw: unknown):
  | { ok: true; value: Record<string, ChecklistCellLevel> }
  | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "missing_checklist" }
  }
  const cleaned: Record<string, ChecklistCellLevel> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length > 200) return { ok: false, reason: "invalid_checklist_key" }
    if (v === false) continue
    if (v === true) {
      cleaned[k] = "yes"
      continue
    }
    if (isChecklistCellLevel(v)) {
      cleaned[k] = v
      continue
    }
    return { ok: false, reason: "invalid_checklist_value" }
  }
  return { ok: true, value: cleaned }
}

/**
 * Lenient coercion for checklist maps already stored on Firestore docs
 * (pre-sheet docs persisted booleans). Never throws; invalid entries and
 * legacy `false` values are dropped.
 */
export function coerceStoredSubmissionChecklist(raw: unknown): Record<string, ChecklistCellLevel> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, ChecklistCellLevel> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || !k || k.length > 200) continue
    if (v === true) {
      out[k] = "yes"
      continue
    }
    if (isChecklistCellLevel(v)) out[k] = v
  }
  return out
}

/**
 * Candidate "core cell" columns of the recruiter sheet. Optional free-text
 * strings, trimmed, capped at 300 chars; stored under `candidate.*` next to
 * the original name/email/link identity fields.
 */
export const CANDIDATE_CORE_CELL_FIELDS = [
  "currentCompany",
  "location",
  "workAuthorization",
  "employmentStatus",
  "compensationExpectation",
  "noticePeriod",
  "interviewAvailability",
] as const

export type CandidateCoreCellField = (typeof CANDIDATE_CORE_CELL_FIELDS)[number]

const CANDIDATE_CORE_CELL_MAX_LENGTH = 300

interface RecruiterSubmissionListItem {
  id: string
  submissionId?: string
  sourcedCandidateId?: string
  jobId?: string
  inboundJobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  candidate?: {
    name?: string
    email?: string
    link?: string
    linkedinUrl?: string
    resumeUrl?: string
    currentRole?: string
    yoe?: string
    notes?: string
    currentCompany?: string
    location?: string
    workAuthorization?: string
    employmentStatus?: string
    compensationExpectation?: string
    noticePeriod?: string
    interviewAvailability?: string
  }
  /** Sheet-model checklist cells. Stored legacy booleans are coerced (`true` → `"yes"`). */
  checklist?: Record<string, ChecklistCellLevel>
  candidateConsentStatus?: string
  candidateConfirmation?: {
    status?: string
    candidateEmail?: string
    sentAt?: unknown
    lastResentAt?: unknown
    confirmedAt?: unknown
    resendCount?: number
    lastError?: string | null
  }
  score?: SubmissionScore
  submissionMode?: "primary_role" | "single_submission" | "unclassified"
  status?: string
  statusHistory?: RecruiterSubmissionStatusHistoryItem[]
  requestedInfo?: RecruiterSubmissionRequestedInfoItem[]
  extraFields?: Record<string, string>
  recruiterFeedbackNote?: string | null
  recruiterFeedbackRating?: number | null
  recruiterFeedbackReasons?: string[]
  recruiterFeedbackUpdatedByEmail?: string | null
  recruiterFeedbackUpdatedAt?: unknown
  recruiterPayout?: RecruiterSubmissionPayoutPublic
  createdAt?: unknown
  updatedAt?: unknown
}

interface RecruiterSubmissionPayoutPublic {
  status?: string
  amount?: number
  currency?: string
  note?: string | null
  updatedByEmail?: string | null
  updatedAt?: unknown
}

export interface RecruiterSubmissionStatusHistoryItem {
  status: string
  by?: string
  atIso?: string
  note?: string
  rating?: number
  reasons?: string[]
}

function sanitizeSubmissionFeedbackRating(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null
}

function sanitizeSubmissionFeedbackReasons(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => /^[a-z0-9_:-]{1,80}$/i.test(item))
    .slice(0, 12)
}

function timestampMs(value: unknown): number {
  const iso = coerceToIso(value)
  return iso ? Date.parse(iso) || 0 : 0
}

export function sanitizeSubmissionStatusHistory(raw: unknown): RecruiterSubmissionStatusHistoryItem[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry): RecruiterSubmissionStatusHistoryItem | null => {
      if (!entry || typeof entry !== "object") return null
      const record = entry as Record<string, unknown>
      const status = typeof record.status === "string" ? record.status.trim() : ""
      if (!status || status.length > 80) return null
      const by = typeof record.by === "string" ? record.by.trim().slice(0, 80) : undefined
      const atIso = typeof record.atIso === "string" && !Number.isNaN(Date.parse(record.atIso))
        ? new Date(record.atIso).toISOString()
        : undefined
      const note = typeof record.note === "string" ? record.note.trim().slice(0, 1000) : undefined
      const rating = sanitizeSubmissionFeedbackRating(record.rating)
      const reasons = sanitizeSubmissionFeedbackReasons(record.reasons)
      return {
        status,
        ...(by ? { by } : {}),
        ...(atIso ? { atIso } : {}),
        ...(note ? { note } : {}),
        ...(rating ? { rating } : {}),
        ...(reasons.length ? { reasons } : {}),
      }
    })
    .filter((entry): entry is RecruiterSubmissionStatusHistoryItem => entry !== null)
    .slice(-20)
}

export interface RecruiterSubmissionRequestedInfoItem {
  message: string
  at?: string
  by?: string
}

export function sanitizeSubmissionRequestedInfo(raw: unknown): RecruiterSubmissionRequestedInfoItem[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry): RecruiterSubmissionRequestedInfoItem | null => {
      if (!entry || typeof entry !== "object") return null
      const record = entry as Record<string, unknown>
      const message = typeof record.message === "string" ? record.message.trim().slice(0, 1000) : ""
      if (!message) return null
      const at = typeof record.at === "string" && !Number.isNaN(Date.parse(record.at))
        ? new Date(record.at).toISOString()
        : undefined
      const by = typeof record.by === "string" ? record.by.trim().slice(0, 80) : undefined
      return {
        message,
        ...(at ? { at } : {}),
        ...(by ? { by } : {}),
      }
    })
    .filter((entry): entry is RecruiterSubmissionRequestedInfoItem => entry !== null)
    .slice(-20)
}

const SUBMISSION_CANDIDATE_PUBLIC_FIELDS = [
  "name",
  "email",
  "link",
  "linkedinUrl",
  "resumeUrl",
  "currentRole",
  "yoe",
  "notes",
  ...CANDIDATE_CORE_CELL_FIELDS,
] as const

function sanitizeSubmissionCandidate(raw: unknown): RecruiterSubmissionListItem["candidate"] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const data = raw as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const key of SUBMISSION_CANDIDATE_PUBLIC_FIELDS) {
    const value = typeof data[key] === "string" ? (data[key] as string).trim() : ""
    if (value) out[key] = value
  }
  return Object.keys(out).length ? out as RecruiterSubmissionListItem["candidate"] : undefined
}

function sanitizeSubmissionExtraFields(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const k = key.trim()
    if (!k || k.length > 120) continue
    if (typeof value !== "string") continue
    const v = value.trim().slice(0, 500)
    if (v) out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

export function publicRecruiterSubmission(d: { id: string; data: () => Record<string, unknown> }): RecruiterSubmissionListItem {
  const data = d.data()
  return {
    id: d.id,
    submissionId: typeof data.submissionId === "string" ? data.submissionId : undefined,
    sourcedCandidateId: typeof data.sourcedCandidateId === "string" ? data.sourcedCandidateId : undefined,
    jobId: typeof data.jobId === "string" ? data.jobId : undefined,
    inboundJobId: typeof data.inboundJobId === "string" ? data.inboundJobId : undefined,
    jobTitleSnapshot: typeof data.jobTitleSnapshot === "string" ? data.jobTitleSnapshot : undefined,
    companyLabelSnapshot: typeof data.companyLabelSnapshot === "string" ? data.companyLabelSnapshot : undefined,
    candidate: sanitizeSubmissionCandidate(data.candidate),
    checklist: coerceStoredSubmissionChecklist(data.checklist),
    candidateConsentStatus: typeof data.candidateConsentStatus === "string" ? data.candidateConsentStatus : undefined,
    candidateConfirmation: publicRecruiterCandidateConfirmation(data.candidateConfirmation),
    score: typeof data.score === "object" && data.score !== null ? data.score as SubmissionScore : undefined,
    submissionMode: data.submissionMode === "primary_role" || data.submissionMode === "single_submission"
      ? data.submissionMode
      : "unclassified",
    status: typeof data.status === "string" ? data.status : "submitted",
    statusHistory: sanitizeSubmissionStatusHistory(data.statusHistory),
    requestedInfo: sanitizeSubmissionRequestedInfo(data.requestedInfo),
    extraFields: sanitizeSubmissionExtraFields(data.extraFields),
    recruiterFeedbackNote: typeof data.recruiterFeedbackNote === "string" ? data.recruiterFeedbackNote : null,
    recruiterFeedbackRating: sanitizeSubmissionFeedbackRating(data.recruiterFeedbackRating),
    recruiterFeedbackReasons: sanitizeSubmissionFeedbackReasons(data.recruiterFeedbackReasons),
    recruiterFeedbackUpdatedByEmail: typeof data.recruiterFeedbackUpdatedByEmail === "string"
      ? data.recruiterFeedbackUpdatedByEmail
      : null,
    recruiterFeedbackUpdatedAt: data.recruiterFeedbackUpdatedAt,
    recruiterPayout: publicRecruiterPayout(data.recruiterPayout),
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  }
}

function publicRecruiterCandidateConfirmation(raw: unknown): RecruiterSubmissionListItem["candidateConfirmation"] | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const data = raw as Record<string, unknown>
  const out: NonNullable<RecruiterSubmissionListItem["candidateConfirmation"]> = {}
  if (typeof data.status === "string") out.status = data.status
  if (typeof data.candidateEmail === "string") out.candidateEmail = data.candidateEmail
  if (data.sentAt !== undefined) out.sentAt = data.sentAt
  if (data.lastResentAt !== undefined) out.lastResentAt = data.lastResentAt
  if (data.confirmedAt !== undefined) out.confirmedAt = data.confirmedAt
  if (typeof data.resendCount === "number") out.resendCount = data.resendCount
  if (typeof data.lastError === "string") out.lastError = data.lastError
  return Object.keys(out).length ? out : undefined
}

function publicRecruiterPayout(raw: unknown): RecruiterSubmissionListItem["recruiterPayout"] | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const data = raw as Record<string, unknown>
  const out: RecruiterSubmissionPayoutPublic = {}
  if (typeof data.status === "string" && /^[a-z0-9_:-]{1,80}$/i.test(data.status.trim())) {
    out.status = data.status.trim()
  }
  if (typeof data.amount === "number" && Number.isFinite(data.amount) && data.amount > 0) {
    out.amount = Math.round(data.amount)
  }
  if (typeof data.currency === "string" && /^[A-Z]{3}$/.test(data.currency.trim().toUpperCase())) {
    out.currency = data.currency.trim().toUpperCase()
  }
  if (typeof data.note === "string") out.note = data.note.trim().slice(0, 500) || null
  if (typeof data.updatedByEmail === "string") out.updatedByEmail = data.updatedByEmail.trim().slice(0, 320)
  if (data.updatedAt !== undefined) out.updatedAt = data.updatedAt
  return Object.keys(out).length ? out : undefined
}

export const RECRUITER_SOURCED_CANDIDATE_STAGES = [
  "sourced",
  "contacted",
  "screened",
  "ready",
  "submitted",
  "archived",
] as const

export type RecruiterSourcedCandidateStage = (typeof RECRUITER_SOURCED_CANDIDATE_STAGES)[number]

export const RECRUITER_CANDIDATE_OUTREACH_STATUSES = [
  "not_contacted",
  "contacted",
  "responded",
  "not_interested",
] as const

export type RecruiterCandidateOutreachStatus = (typeof RECRUITER_CANDIDATE_OUTREACH_STATUSES)[number]

interface RecruiterCandidateOutreach {
  status?: RecruiterCandidateOutreachStatus
  nextFollowUpAt?: string | null
}

interface RecruiterSourcedCandidateInput {
  candidateId?: string
  jobId?: string
  stage: RecruiterSourcedCandidateStage
  candidate: {
    name: string
    email?: string
    link: string
    currentRole?: string
    yoe?: string
    notes?: string
  }
  outreach?: RecruiterCandidateOutreach
  calibrationRequest?: {
    note?: string
  }
}

interface RecruiterSourcedCandidateListItem {
  id: string
  candidateId: string
  recruiterId?: string
  jobId?: string
  inboundJobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  stage: RecruiterSourcedCandidateStage
  candidate?: RecruiterSourcedCandidateInput["candidate"]
  outreach?: RecruiterCandidateOutreach
  calibrationStatus?: string
  calibrationNote?: string | null
  calibrationUpdatedAt?: unknown
  linkedSubmissionId?: string
  submittedAt?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

export const RECRUITER_ROLE_FEEDBACK_DIFFICULTIES = [
  "easy",
  "medium",
  "hard",
  "blocked",
] as const

export type RecruiterRoleFeedbackDifficulty = (typeof RECRUITER_ROLE_FEEDBACK_DIFFICULTIES)[number]

export const RECRUITER_ROLE_FEEDBACK_REASONS = [
  "low_comp",
  "location_mismatch",
  "unclear_requirements",
  "small_candidate_pool",
  "hiring_team_slow",
  "role_too_broad",
  "candidate_interest_low",
  "too_many_recruiters",
  "other",
] as const

export type RecruiterRoleFeedbackReason = (typeof RECRUITER_ROLE_FEEDBACK_REASONS)[number]

export const RECRUITER_ROLE_APPLICATION_STATUSES = [
  "pending",
  "approved",
  "not_approved",
  "withdrawn",
  "rescinded",
] as const

export type RecruiterRoleApplicationStatus = (typeof RECRUITER_ROLE_APPLICATION_STATUSES)[number]

export const RECRUITER_ROLE_APPLICATION_ACTIONS = [
  "apply",
  "withdraw",
] as const

export type RecruiterRoleApplicationAction = (typeof RECRUITER_ROLE_APPLICATION_ACTIONS)[number]

interface RecruiterRoleApplicationInput {
  jobId: string
  action: RecruiterRoleApplicationAction
  pitch?: string
  anonymizeCandidates: boolean
  preparedCandidateIds: string[]
}

interface RecruiterRoleApplicationListItem {
  id: string
  applicationId?: string
  recruiterId?: string
  recruiterEmail?: string
  jobId?: string
  inboundJobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  status: RecruiterRoleApplicationStatus
  pitch?: string | null
  anonymizeCandidates?: boolean
  preparedCandidateIds?: string[]
  preparedCandidateCount?: number
  adminNote?: string | null
  reviewedByEmail?: string | null
  reviewedAt?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

interface RecruiterRoleFeedbackInput {
  jobId: string
  difficulty: RecruiterRoleFeedbackDifficulty
  reasons: RecruiterRoleFeedbackReason[]
  note?: string
}

interface RecruiterRoleFeedbackListItem {
  id: string
  recruiterId?: string
  recruiterEmail?: string
  jobId?: string
  inboundJobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  difficulty: RecruiterRoleFeedbackDifficulty
  reasons: RecruiterRoleFeedbackReason[]
  note?: string | null
  createdAt?: unknown
  updatedAt?: unknown
}

interface RecruiterRoleQuestionInput {
  jobId: string
  question: string
}

interface RecruiterRoleQuestionListItem {
  id: string
  questionId?: string
  recruiterId?: string
  recruiterEmail?: string
  jobId?: string
  inboundJobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  question?: string
  status?: "open" | "answered"
  answer?: string | null
  answeredByEmail?: string | null
  answeredAt?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

export interface RecruiterRoleIntelligenceJobAlias {
  jobId: string
  aliases: string[]
}

export interface RecruiterRoleIntelligenceReasonCount {
  reason: RecruiterRoleFeedbackReason
  count: number
}

export interface RecruiterRoleIntelligencePipelinePreviewItem {
  id: string
  source: "sourced" | "submission"
  stage: string
  status: string | null
  candidateLabel: string
  candidateHeadline: string | null
  candidateSignal: string | null
  recruiterScope: "mine" | "market"
  anonymized: boolean
  updatedAt: string | null
}

export interface RecruiterRoleIntelligenceItem {
  jobId: string
  sourcedCount: number
  readyCount: number
  submissionCount: number
  pendingCount: number
  advancedCount: number
  rejectedCount: number
  duplicateCount: number
  recruiterCount: number
  openQuestionCount: number
  answeredQuestionCount: number
  lastActivityAt: string | null
  feedback: {
    total: number
    easy: number
    medium: number
    hard: number
    blocked: number
    topReasons: RecruiterRoleIntelligenceReasonCount[]
  }
  my: {
    sourcedCount: number
    readyCount: number
    submissionCount: number
    pendingCount: number
  }
  pipelinePreview: RecruiterRoleIntelligencePipelinePreviewItem[]
}

export interface RecruiterRoleIntelligenceAggregateInput {
  sourcedCandidates: Record<string, unknown>[]
  submissions: Record<string, unknown>[]
  feedback: Record<string, unknown>[]
  questions: Record<string, unknown>[]
  applications: Record<string, unknown>[]
}

export function normalizeRecruiterCandidateLink(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ""
  try {
    const url = new URL(trimmed)
    const host = url.hostname.toLowerCase().replace(/^www\./, "")
    const path = url.pathname.replace(/\/+$/, "").toLowerCase()
    return `${host}${path}`
  } catch {
    return trimmed.toLowerCase().replace(/\s+/g, "")
  }
}

export function hashRecruiterCandidateLink(raw: string): string {
  return createHash("sha256").update(normalizeRecruiterCandidateLink(raw)).digest("hex")
}

export function normalizeRecruiterCandidateEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

export function hashRecruiterCandidateEmail(raw: string): string {
  return createHash("sha256").update(normalizeRecruiterCandidateEmail(raw)).digest("hex")
}

function validRecruiterCandidateEmail(raw: string): boolean {
  const email = normalizeRecruiterCandidateEmail(raw)
  return email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function sanitizeOptionalString(v: unknown, max: number): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== "string") return undefined
  const trimmed = v.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, max)
}

export function canonicalizeRecruiterLinkedInProfileUrl(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return null
  }
  let candidate = trimmed
  if (/^\/\//.test(candidate)) {
    candidate = `https:${candidate}`
  } else if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`
  }
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  if (!/(^|\.)linkedin\.com$/.test(host)) return null
  let path = parsed.pathname
  const localeMatch = /^\/[a-z]{2,3}\/in\//i.exec(path)
  if (localeMatch) path = path.slice(localeMatch[0].length - "/in/".length)
  const match = /^\/in\/([A-Za-z0-9\-_%]+)\/?$/.exec(path)
  if (!match) return null
  return `https://linkedin.com/in/${match[1]!.toLowerCase()}`
}

export function validateRecruiterSourcedCandidateInput(input: unknown):
  | { ok: true; value: RecruiterSourcedCandidateInput }
  | { ok: false; reason: string } {
  if (!input || typeof input !== "object") return { ok: false, reason: "missing_body" }
  const b = input as Record<string, unknown>
  const candidateId = sanitizeOptionalString(b.candidateId, 120)
  if (candidateId && !/^[A-Za-z0-9_.:-]{1,120}$/.test(candidateId)) return { ok: false, reason: "invalid_candidate_id" }
  let jobId: string | undefined
  if (b.jobId !== undefined && b.jobId !== null && b.jobId !== "") {
    if (typeof b.jobId !== "string") return { ok: false, reason: "invalid_jobId" }
    const trimmedJobId = b.jobId.trim()
    if (trimmedJobId) {
      if (trimmedJobId.length > 200) return { ok: false, reason: "jobId_too_long" }
      jobId = trimmedJobId
    }
  }
  const stage = typeof b.stage === "string" && RECRUITER_SOURCED_CANDIDATE_STAGES.includes(b.stage as RecruiterSourcedCandidateStage)
    ? b.stage as RecruiterSourcedCandidateStage
    : "sourced"

  const c = b.candidate as Record<string, unknown> | undefined
  if (!c || typeof c !== "object") return { ok: false, reason: "missing_candidate" }
  if (!isNonEmptyString(c.name)) return { ok: false, reason: "missing_candidate_name" }
  if (!isNonEmptyString(c.link)) return { ok: false, reason: "missing_candidate_link" }
  if (c.name.length > 200) return { ok: false, reason: "candidate_name_too_long" }
  if (c.link.length > 2000) return { ok: false, reason: "candidate_link_too_long" }
  const canonicalCandidateLink = canonicalizeRecruiterLinkedInProfileUrl(c.link)
  if (!canonicalCandidateLink) return { ok: false, reason: "candidate_linkedin_url_required" }
  if (c.email !== undefined && c.email !== null && c.email !== "") {
    if (typeof c.email !== "string" || !validRecruiterCandidateEmail(c.email)) {
      return { ok: false, reason: "invalid_candidate_email" }
    }
  }
  for (const k of ["currentRole", "yoe", "notes"] as const) {
    if (c[k] !== undefined && typeof c[k] !== "string") return { ok: false, reason: `invalid_${k}` }
    if (typeof c[k] === "string" && (c[k] as string).length > 4000) return { ok: false, reason: `${k}_too_long` }
  }

  let outreach: RecruiterSourcedCandidateInput["outreach"]
  if (b.outreach !== undefined) {
    if (!b.outreach || typeof b.outreach !== "object") {
      return { ok: false, reason: "invalid_outreach" }
    }
    const o = b.outreach as Record<string, unknown>
    let status: RecruiterCandidateOutreachStatus | undefined
    if (o.status !== undefined && o.status !== null && o.status !== "") {
      if (
        typeof o.status !== "string" ||
        !RECRUITER_CANDIDATE_OUTREACH_STATUSES.includes(o.status as RecruiterCandidateOutreachStatus)
      ) {
        return { ok: false, reason: "invalid_outreach_status" }
      }
      status = o.status as RecruiterCandidateOutreachStatus
    }

    let nextFollowUpAt: string | null | undefined
    if (o.nextFollowUpAt !== undefined) {
      if (o.nextFollowUpAt === null || o.nextFollowUpAt === "") {
        nextFollowUpAt = null
      } else if (typeof o.nextFollowUpAt === "string") {
        if (o.nextFollowUpAt.length > 120) return { ok: false, reason: "next_follow_up_at_too_long" }
        const parsed = Date.parse(o.nextFollowUpAt)
        if (!Number.isFinite(parsed)) return { ok: false, reason: "invalid_next_follow_up_at" }
        nextFollowUpAt = new Date(parsed).toISOString()
      } else {
        return { ok: false, reason: "invalid_next_follow_up_at" }
      }
    }

    outreach = {
      ...(status ? { status } : {}),
      ...(nextFollowUpAt !== undefined ? { nextFollowUpAt } : {}),
    }
  }

  let calibrationRequest: RecruiterSourcedCandidateInput["calibrationRequest"]
  if (b.calibrationRequest !== undefined) {
    if (!b.calibrationRequest || typeof b.calibrationRequest !== "object") {
      return { ok: false, reason: "invalid_calibration_request" }
    }
    const request = b.calibrationRequest as Record<string, unknown>
    if (request.note !== undefined && typeof request.note !== "string") {
      return { ok: false, reason: "invalid_calibration_note" }
    }
    calibrationRequest = {
      note: sanitizeOptionalString(request.note, 1200),
    }
  }
  if (calibrationRequest && !jobId) {
    return { ok: false, reason: "calibration_requires_job" }
  }

  const candidate: RecruiterSourcedCandidateInput["candidate"] = {
    name: c.name.trim(),
    link: canonicalCandidateLink,
  }
  const candidateEmail = typeof c.email === "string" ? normalizeRecruiterCandidateEmail(c.email) : ""
  const currentRole = sanitizeOptionalString(c.currentRole, 4000)
  const yoe = sanitizeOptionalString(c.yoe, 4000)
  const notes = sanitizeOptionalString(c.notes, 4000)
  if (candidateEmail) candidate.email = candidateEmail
  if (currentRole) candidate.currentRole = currentRole
  if (yoe) candidate.yoe = yoe
  if (notes) candidate.notes = notes

  return {
    ok: true,
    value: {
      candidateId,
      ...(jobId ? { jobId } : {}),
      stage,
      candidate,
      ...(outreach ? { outreach } : {}),
      ...(calibrationRequest ? { calibrationRequest } : {}),
    },
  }
}

function publicRecruiterCandidateOutreach(raw: unknown): RecruiterCandidateOutreach | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const data = raw as Record<string, unknown>
  const status = typeof data.status === "string" &&
    RECRUITER_CANDIDATE_OUTREACH_STATUSES.includes(data.status as RecruiterCandidateOutreachStatus)
    ? data.status as RecruiterCandidateOutreachStatus
    : undefined
  const nextFollowUpAt = typeof data.nextFollowUpAt === "string"
    ? data.nextFollowUpAt
    : data.nextFollowUpAt === null
      ? null
      : undefined
  if (!status && nextFollowUpAt === undefined) return undefined
  return {
    ...(status ? { status } : {}),
    ...(nextFollowUpAt !== undefined ? { nextFollowUpAt } : {}),
  }
}

function publicRecruiterSourcedCandidate(
  d: { id: string; data: () => Record<string, unknown> | undefined },
): RecruiterSourcedCandidateListItem {
  const data = d.data() ?? {}
  const stage = typeof data.stage === "string" && RECRUITER_SOURCED_CANDIDATE_STAGES.includes(data.stage as RecruiterSourcedCandidateStage)
    ? data.stage as RecruiterSourcedCandidateStage
    : "sourced"
  return {
    id: d.id,
    candidateId: typeof data.candidateId === "string" ? data.candidateId : d.id,
    recruiterId: typeof data.recruiterId === "string" ? data.recruiterId : undefined,
    jobId: typeof data.jobId === "string" ? data.jobId : undefined,
    inboundJobId: typeof data.inboundJobId === "string" ? data.inboundJobId : undefined,
    jobTitleSnapshot: typeof data.jobTitleSnapshot === "string" ? data.jobTitleSnapshot : undefined,
    companyLabelSnapshot: typeof data.companyLabelSnapshot === "string" ? data.companyLabelSnapshot : undefined,
    stage,
    candidate: typeof data.candidate === "object" && data.candidate !== null
      ? data.candidate as RecruiterSourcedCandidateInput["candidate"]
      : undefined,
    outreach: publicRecruiterCandidateOutreach(data.outreach),
    calibrationStatus: typeof data.calibrationStatus === "string" ? data.calibrationStatus : undefined,
    calibrationNote: typeof data.calibrationNote === "string" ? data.calibrationNote : null,
    calibrationUpdatedAt: data.calibrationUpdatedAt,
    linkedSubmissionId: typeof data.linkedSubmissionId === "string" ? data.linkedSubmissionId : undefined,
    submittedAt: data.submittedAt,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  }
}

function recruiterRoleApplicationId(recruiterId: string, realJobId: string): string {
  return createHash("sha256").update(`${recruiterId}:${realJobId}`).digest("hex").slice(0, 40)
}

export function validateRecruiterRoleApplicationInput(input: unknown):
  | { ok: true; value: RecruiterRoleApplicationInput }
  | { ok: false; reason: string } {
  if (!input || typeof input !== "object") return { ok: false, reason: "missing_body" }
  const b = input as Record<string, unknown>
  if (!isNonEmptyString(b.jobId)) return { ok: false, reason: "missing_jobId" }
  if (b.jobId.length > 200) return { ok: false, reason: "jobId_too_long" }
  const action = typeof b.action === "string" && RECRUITER_ROLE_APPLICATION_ACTIONS.includes(b.action as RecruiterRoleApplicationAction)
    ? b.action as RecruiterRoleApplicationAction
    : "apply"
  let pitch: string | undefined
  if (b.pitch !== undefined && b.pitch !== null) {
    if (typeof b.pitch !== "string") return { ok: false, reason: "invalid_pitch" }
    pitch = b.pitch.trim()
    if (pitch.length > 2000) return { ok: false, reason: "pitch_too_long" }
  }
  if (action === "apply" && (!pitch || pitch.length < 20)) {
    return { ok: false, reason: "pitch_too_short" }
  }
  const anonymizeCandidates = b.anonymizeCandidates === true
  const preparedRaw = b.preparedCandidateIds === undefined ? [] : b.preparedCandidateIds
  if (!Array.isArray(preparedRaw)) return { ok: false, reason: "invalid_prepared_candidate_ids" }
  const preparedCandidateIds: string[] = []
  for (const raw of preparedRaw) {
    if (typeof raw !== "string") return { ok: false, reason: "invalid_prepared_candidate_ids" }
    const id = raw.trim()
    if (!id || id.length > 160 || !/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) {
      return { ok: false, reason: "invalid_prepared_candidate_ids" }
    }
    if (!preparedCandidateIds.includes(id)) preparedCandidateIds.push(id)
  }
  if (preparedCandidateIds.length > 10) return { ok: false, reason: "too_many_prepared_candidates" }
  return {
    ok: true,
    value: {
      jobId: b.jobId.trim(),
      action,
      ...(pitch ? { pitch } : {}),
      anonymizeCandidates,
      preparedCandidateIds,
    },
  }
}

function publicRecruiterRoleApplication(
  d: { id: string; data: () => Record<string, unknown> | undefined },
): RecruiterRoleApplicationListItem {
  const data = d.data() ?? {}
  const status = typeof data.status === "string" &&
    RECRUITER_ROLE_APPLICATION_STATUSES.includes(data.status as RecruiterRoleApplicationStatus)
    ? data.status as RecruiterRoleApplicationStatus
    : "pending"
  const preparedCandidateIds = Array.isArray(data.preparedCandidateIds)
    ? data.preparedCandidateIds.filter((id): id is string => typeof id === "string")
    : []
  return {
    id: d.id,
    applicationId: typeof data.applicationId === "string" ? data.applicationId : d.id,
    recruiterId: typeof data.recruiterId === "string" ? data.recruiterId : undefined,
    recruiterEmail: typeof data.recruiterEmail === "string" ? data.recruiterEmail : undefined,
    jobId: typeof data.jobId === "string" ? data.jobId : undefined,
    inboundJobId: typeof data.inboundJobId === "string" ? data.inboundJobId : undefined,
    jobTitleSnapshot: typeof data.jobTitleSnapshot === "string" ? data.jobTitleSnapshot : undefined,
    companyLabelSnapshot: typeof data.companyLabelSnapshot === "string" ? data.companyLabelSnapshot : undefined,
    status,
    pitch: typeof data.pitch === "string" ? data.pitch : null,
    anonymizeCandidates: data.anonymizeCandidates === true,
    preparedCandidateIds,
    preparedCandidateCount: typeof data.preparedCandidateCount === "number" ? data.preparedCandidateCount : preparedCandidateIds.length,
    adminNote: typeof data.adminNote === "string" ? data.adminNote : null,
    reviewedByEmail: typeof data.reviewedByEmail === "string" ? data.reviewedByEmail : null,
    reviewedAt: data.reviewedAt,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  }
}

export function validateRecruiterRoleFeedbackInput(input: unknown):
  | { ok: true; value: RecruiterRoleFeedbackInput }
  | { ok: false; reason: string } {
  if (!input || typeof input !== "object") return { ok: false, reason: "missing_body" }
  const b = input as Record<string, unknown>
  if (!isNonEmptyString(b.jobId)) return { ok: false, reason: "missing_jobId" }
  if (b.jobId.length > 200) return { ok: false, reason: "jobId_too_long" }
  if (
    typeof b.difficulty !== "string" ||
    !RECRUITER_ROLE_FEEDBACK_DIFFICULTIES.includes(b.difficulty as RecruiterRoleFeedbackDifficulty)
  ) {
    return { ok: false, reason: "invalid_difficulty" }
  }

  const reasonsRaw = b.reasons === undefined ? [] : b.reasons
  if (!Array.isArray(reasonsRaw)) return { ok: false, reason: "invalid_reasons" }
  const reasons: RecruiterRoleFeedbackReason[] = []
  for (const raw of reasonsRaw) {
    if (
      typeof raw !== "string" ||
      !RECRUITER_ROLE_FEEDBACK_REASONS.includes(raw as RecruiterRoleFeedbackReason)
    ) {
      return { ok: false, reason: "invalid_reasons" }
    }
    const reason = raw as RecruiterRoleFeedbackReason
    if (!reasons.includes(reason)) reasons.push(reason)
  }
  if (reasons.length > 6) return { ok: false, reason: "too_many_reasons" }

  let note: string | undefined
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== "string") return { ok: false, reason: "invalid_note" }
    note = b.note.trim()
    if (note.length > 2000) return { ok: false, reason: "note_too_long" }
    if (!note) note = undefined
  }

  return {
    ok: true,
    value: {
      jobId: b.jobId.trim(),
      difficulty: b.difficulty as RecruiterRoleFeedbackDifficulty,
      reasons,
      note,
    },
  }
}

function publicRecruiterRoleFeedback(
  d: { id: string; data: () => Record<string, unknown> | undefined },
): RecruiterRoleFeedbackListItem {
  const data = d.data() ?? {}
  const difficulty = typeof data.difficulty === "string" &&
    RECRUITER_ROLE_FEEDBACK_DIFFICULTIES.includes(data.difficulty as RecruiterRoleFeedbackDifficulty)
    ? data.difficulty as RecruiterRoleFeedbackDifficulty
    : "medium"
  const reasons = Array.isArray(data.reasons)
    ? data.reasons.filter((reason): reason is RecruiterRoleFeedbackReason =>
      typeof reason === "string" &&
      RECRUITER_ROLE_FEEDBACK_REASONS.includes(reason as RecruiterRoleFeedbackReason),
    )
    : []
  return {
    id: d.id,
    recruiterId: typeof data.recruiterId === "string" ? data.recruiterId : undefined,
    recruiterEmail: typeof data.recruiterEmail === "string" ? data.recruiterEmail : undefined,
    jobId: typeof data.jobId === "string" ? data.jobId : undefined,
    inboundJobId: typeof data.inboundJobId === "string" ? data.inboundJobId : undefined,
    jobTitleSnapshot: typeof data.jobTitleSnapshot === "string" ? data.jobTitleSnapshot : undefined,
    companyLabelSnapshot: typeof data.companyLabelSnapshot === "string" ? data.companyLabelSnapshot : undefined,
    difficulty,
    reasons,
    note: typeof data.note === "string" ? data.note : null,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  }
}

export function validateRecruiterRoleQuestionInput(input: unknown):
  | { ok: true; value: RecruiterRoleQuestionInput }
  | { ok: false; reason: string } {
  if (!input || typeof input !== "object") return { ok: false, reason: "missing_body" }
  const b = input as Record<string, unknown>
  if (!isNonEmptyString(b.jobId)) return { ok: false, reason: "missing_jobId" }
  if (b.jobId.length > 200) return { ok: false, reason: "jobId_too_long" }
  if (typeof b.question !== "string") return { ok: false, reason: "missing_question" }
  const question = b.question.trim()
  if (question.length < 8) return { ok: false, reason: "question_too_short" }
  if (question.length > 2000) return { ok: false, reason: "question_too_long" }
  return { ok: true, value: { jobId: b.jobId.trim(), question } }
}

function publicRecruiterRoleQuestion(
  d: { id: string; data: () => Record<string, unknown> | undefined },
): RecruiterRoleQuestionListItem {
  const data = d.data() ?? {}
  const status = data.status === "answered" ? "answered" : "open"
  return {
    id: d.id,
    questionId: typeof data.questionId === "string" ? data.questionId : d.id,
    recruiterId: typeof data.recruiterId === "string" ? data.recruiterId : undefined,
    recruiterEmail: typeof data.recruiterEmail === "string" ? data.recruiterEmail : undefined,
    jobId: typeof data.jobId === "string" ? data.jobId : undefined,
    inboundJobId: typeof data.inboundJobId === "string" ? data.inboundJobId : undefined,
    jobTitleSnapshot: typeof data.jobTitleSnapshot === "string" ? data.jobTitleSnapshot : undefined,
    companyLabelSnapshot: typeof data.companyLabelSnapshot === "string" ? data.companyLabelSnapshot : undefined,
    question: typeof data.question === "string" ? data.question : undefined,
    status,
    answer: typeof data.answer === "string" ? data.answer : null,
    answeredByEmail: typeof data.answeredByEmail === "string" ? data.answeredByEmail : null,
    answeredAt: data.answeredAt,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  }
}

function rowMatchesRoleAliases(row: Record<string, unknown>, aliases: Set<string>): boolean {
  const jobId = typeof row.jobId === "string" ? row.jobId.trim() : ""
  const inboundJobId = typeof row.inboundJobId === "string" ? row.inboundJobId.trim() : ""
  return Boolean((jobId && aliases.has(jobId)) || (inboundJobId && aliases.has(inboundJobId)))
}

function rowRecruiterId(row: Record<string, unknown>): string {
  return typeof row.recruiterId === "string" ? row.recruiterId.trim() : ""
}

function isPendingSubmissionStatus(status: unknown): boolean {
  return status === undefined || status === null || (typeof status === "string" && RECRUITER_PENDING_SUBMISSION_STATUSES.includes(status))
}

function isAdvancedSubmissionStatus(status: unknown): boolean {
  return typeof status === "string" && RECRUITER_ADVANCED_SUBMISSION_STATUSES.includes(status)
}

function isReadySourcedStage(stage: unknown): boolean {
  return stage === "ready" || stage === "submitted"
}

function latestActivityIso(rows: Record<string, unknown>[]): string | null {
  let latest = 0
  for (const row of rows) {
    latest = Math.max(latest, timestampMs(row.updatedAt), timestampMs(row.createdAt), timestampMs(row.recruiterFeedbackUpdatedAt))
  }
  return latest ? new Date(latest).toISOString() : null
}

const RECRUITER_ROLE_PIPELINE_PREVIEW_LIMIT = 6

function safePipelineText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return ""
  return value
    .trim()
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link]")
    .replace(/\blinkedin\.com\/\S+/gi, "[link]")
    .replace(/\s+/g, " ")
    .slice(0, maxLength)
}

function pipelineCandidate(row: Record<string, unknown>): {
  name: string
  currentRole: string
  yoe: string
  notes: string
} {
  const candidate = typeof row.candidate === "object" && row.candidate !== null
    ? row.candidate as Record<string, unknown>
    : {}
  return {
    name: safePipelineText(candidate.name, 80),
    currentRole: safePipelineText(candidate.currentRole, 90),
    yoe: safePipelineText(candidate.yoe, 36),
    notes: safePipelineText(candidate.notes, 160),
  }
}

function recruiterAnonymizesRoleCandidates(applications: Record<string, unknown>[], recruiterId: string): boolean {
  if (!recruiterId) return false
  return applications.some((row) => {
    const status = typeof row.status === "string" ? row.status : ""
    return rowRecruiterId(row) === recruiterId &&
      row.anonymizeCandidates === true &&
      status !== "withdrawn" &&
      status !== "rescinded"
  })
}

function pipelineIdentityKey(row: Record<string, unknown>, source: RecruiterRoleIntelligencePipelinePreviewItem["source"], index: number): string {
  for (const key of ["candidateLinkKey", "candidateEmailKey", "sourcedCandidateId", "candidateId", "submissionId"]) {
    const value = typeof row[key] === "string" ? row[key].trim() : ""
    if (value) return value
  }
  return `${source}:${index}`
}

function pipelinePublicId(row: Record<string, unknown>, source: RecruiterRoleIntelligencePipelinePreviewItem["source"], index: number): string {
  const preferredKeys = source === "submission"
    ? ["submissionId", "sourcedCandidateId"]
    : ["candidateId", "linkedSubmissionId"]
  for (const key of preferredKeys) {
    const value = typeof row[key] === "string" ? row[key].trim() : ""
    if (value) return `${source}:${value}`
  }
  return `${source}:${index}`
}

function pipelineActivityMs(row: Record<string, unknown>): number {
  return Math.max(
    timestampMs(row.updatedAt),
    timestampMs(row.submittedAt),
    timestampMs(row.createdAt),
    timestampMs(row.recruiterFeedbackUpdatedAt),
  )
}

function buildRecruiterRolePipelinePreview(
  sourced: Record<string, unknown>[],
  submissions: Record<string, unknown>[],
  applications: Record<string, unknown>[],
  recruiterId: string,
): RecruiterRoleIntelligencePipelinePreviewItem[] {
  type InternalPreview = RecruiterRoleIntelligencePipelinePreviewItem & {
    identityKey: string
    activityMs: number
    sourceRank: number
  }
  const viewerHidesMarketBackground = recruiterAnonymizesRoleCandidates(applications, recruiterId)
  const rows: InternalPreview[] = []

  const pushRow = (
    row: Record<string, unknown>,
    source: RecruiterRoleIntelligencePipelinePreviewItem["source"],
    index: number,
  ) => {
    if (source === "sourced" && row.stage === "archived") return
    const ownerRecruiterId = rowRecruiterId(row)
    const mine = ownerRecruiterId === recruiterId
    const ownerHidesBackground = !mine && recruiterAnonymizesRoleCandidates(applications, ownerRecruiterId)
    const anonymized = !mine && (viewerHidesMarketBackground || ownerHidesBackground)
    const candidate = pipelineCandidate(row)
    const stage = source === "sourced"
      ? safePipelineText(row.stage, 40) || "sourced"
      : "submitted"
    const status = source === "submission"
      ? safePipelineText(row.status, 40) || "submitted"
      : null
    const backgroundParts = [candidate.currentRole, candidate.yoe ? `${candidate.yoe} exp` : ""].filter(Boolean)
    const candidateHeadline = anonymized
      ? "Background hidden by recruiter privacy setting."
      : backgroundParts.join(" · ") || (mine ? candidate.notes : "Shared background context")
    const candidateSignal = anonymized
      ? "Only stage and status are visible."
      : mine
        ? candidate.notes || "Your saved context is visible to you."
        : "Background only; identity, email, and links stay hidden."

    rows.push({
      id: pipelinePublicId(row, source, index),
      source,
      stage,
      status,
      candidateLabel: mine
        ? candidate.name || "Your candidate"
        : anonymized
          ? "Anonymized candidate"
          : candidate.currentRole || "Market candidate",
      candidateHeadline: candidateHeadline || null,
      candidateSignal: candidateSignal || null,
      recruiterScope: mine ? "mine" : "market",
      anonymized,
      updatedAt: coerceToIso(row.updatedAt ?? row.submittedAt ?? row.createdAt ?? row.recruiterFeedbackUpdatedAt),
      identityKey: pipelineIdentityKey(row, source, index),
      activityMs: pipelineActivityMs(row),
      sourceRank: source === "submission" ? 2 : 1,
    })
  }

  sourced.forEach((row, index) => pushRow(row, "sourced", index))
  submissions.forEach((row, index) => pushRow(row, "submission", index))

  const byIdentity = new Map<string, InternalPreview>()
  for (const row of rows) {
    const existing = byIdentity.get(row.identityKey)
    if (!existing || row.sourceRank > existing.sourceRank || (row.sourceRank === existing.sourceRank && row.activityMs > existing.activityMs)) {
      byIdentity.set(row.identityKey, row)
    }
  }

  return [...byIdentity.values()]
    .sort((a, b) => b.activityMs - a.activityMs || b.sourceRank - a.sourceRank || a.id.localeCompare(b.id))
    .slice(0, RECRUITER_ROLE_PIPELINE_PREVIEW_LIMIT)
    .map(({ identityKey: _identityKey, activityMs: _activityMs, sourceRank: _sourceRank, ...row }) => row)
}

export function buildRecruiterRoleIntelligence(
  jobs: RecruiterRoleIntelligenceJobAlias[],
  recruiterId: string,
  input: RecruiterRoleIntelligenceAggregateInput,
): RecruiterRoleIntelligenceItem[] {
  return jobs.map((job) => {
    const aliases = new Set([job.jobId, ...job.aliases].map((id) => id.trim()).filter(Boolean))
    const sourced = input.sourcedCandidates.filter((row) => rowMatchesRoleAliases(row, aliases))
    const submissions = input.submissions.filter((row) => rowMatchesRoleAliases(row, aliases))
    const feedbackRows = input.feedback.filter((row) => rowMatchesRoleAliases(row, aliases))
    const questions = input.questions.filter((row) => rowMatchesRoleAliases(row, aliases))
    const applications = input.applications.filter((row) => rowMatchesRoleAliases(row, aliases))
    const recruiters = new Set<string>()
    for (const row of [...sourced, ...submissions, ...feedbackRows, ...questions, ...applications]) {
      const id = rowRecruiterId(row)
      if (id) recruiters.add(id)
    }

    const reasonCounts = new Map<RecruiterRoleFeedbackReason, number>()
    const feedback = {
      total: feedbackRows.length,
      easy: 0,
      medium: 0,
      hard: 0,
      blocked: 0,
      topReasons: [] as RecruiterRoleIntelligenceReasonCount[],
    }
    for (const row of feedbackRows) {
      if (row.difficulty === "easy") feedback.easy += 1
      else if (row.difficulty === "hard") feedback.hard += 1
      else if (row.difficulty === "blocked") feedback.blocked += 1
      else feedback.medium += 1
      const reasons = Array.isArray(row.reasons) ? row.reasons : []
      for (const rawReason of reasons) {
        if (!RECRUITER_ROLE_FEEDBACK_REASONS.includes(rawReason as RecruiterRoleFeedbackReason)) continue
        const reason = rawReason as RecruiterRoleFeedbackReason
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1)
      }
    }
    feedback.topReasons = [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
      .slice(0, 4)

    const mySourced = sourced.filter((row) => rowRecruiterId(row) === recruiterId)
    const mySubmissions = submissions.filter((row) => rowRecruiterId(row) === recruiterId)

    return {
      jobId: job.jobId,
      sourcedCount: sourced.filter((row) => row.stage !== "archived").length,
      readyCount: sourced.filter((row) => isReadySourcedStage(row.stage)).length,
      submissionCount: submissions.length,
      pendingCount: submissions.filter((row) => isPendingSubmissionStatus(row.status)).length,
      advancedCount: submissions.filter((row) => isAdvancedSubmissionStatus(row.status)).length,
      rejectedCount: submissions.filter((row) => row.status === "rejected").length,
      duplicateCount: submissions.filter((row) => row.status === "duplicate").length,
      recruiterCount: recruiters.size,
      openQuestionCount: questions.filter((row) => row.status !== "answered").length,
      answeredQuestionCount: questions.filter((row) => row.status === "answered").length,
      lastActivityAt: latestActivityIso([...sourced, ...submissions, ...feedbackRows, ...questions, ...applications]),
      feedback,
      my: {
        sourcedCount: mySourced.filter((row) => row.stage !== "archived").length,
        readyCount: mySourced.filter((row) => isReadySourcedStage(row.stage)).length,
        submissionCount: mySubmissions.length,
        pendingCount: mySubmissions.filter((row) => isPendingSubmissionStatus(row.status)).length,
      },
      pipelinePreview: buildRecruiterRolePipelinePreview(sourced, submissions, applications, recruiterId),
    }
  })
}

export const paRecruiterRoleApplicationsList = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const db = getFirestore()
    const recruiter = await authenticateRecruiter(db, req)
    if (!recruiter) {
      res.status(401).json({ ok: false, reason: "unauthorized" })
      return
    }
    try {
      const snap = await db
        .collection(RECRUITER_ROLE_APPLICATIONS_COLLECTION)
        .where("recruiterId", "==", recruiter.recruiterId)
        .limit(300)
        .get()
      const applications = snap.docs
        .map(publicRecruiterRoleApplication)
        .sort((a, b) => timestampMs(b.updatedAt ?? b.createdAt) - timestampMs(a.updatedAt ?? a.createdAt))
      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({ ok: true, recruiter, applications })
    } catch (err) {
      logger.error("paRecruiterRoleApplicationsList_failed", { error: String(err), recruiterId: recruiter.recruiterId })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

export const paRecruiterRoleApplicationSave = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const db = getFirestore()
    const recruiter = await authenticateRecruiter(db, req)
    if (!recruiter) {
      res.status(401).json({ ok: false, reason: "unauthorized" })
      return
    }
    const validated = validateRecruiterRoleApplicationInput(req.body)
    if (!validated.ok) {
      res.status(400).json({ ok: false, reason: validated.reason })
      return
    }
    const payload = validated.value

    try {
      const realJobId = await resolvePublicIdToDocId(db, payload.jobId)
      if (!realJobId) {
        res.status(404).json({ ok: false, reason: "job_not_found" })
        return
      }
      const jobSnap = await db.collection("pa-jobs").doc(realJobId).get()
      if (!jobSnap.exists) {
        res.status(404).json({ ok: false, reason: "job_not_found" })
        return
      }
      const jobData = jobSnap.data() as Record<string, unknown>
      const rb = jobData.recruiterBoard as RecruiterBoardPayload | undefined
      if (jobData.wekruitCollaborationStatus !== "collaborated" || !rb || rb.active !== true) {
        res.status(403).json({ ok: false, reason: "job_not_active_on_board" })
        return
      }

      const applicationId = recruiterRoleApplicationId(recruiter.recruiterId, realJobId)
      const ref = db.collection(RECRUITER_ROLE_APPLICATIONS_COLLECTION).doc(applicationId)
      const existing = await ref.get()

      if (payload.action === "withdraw") {
        if (!existing.exists) {
          res.status(404).json({ ok: false, reason: "application_not_found" })
          return
        }
        await ref.set({
          status: "withdrawn",
          withdrawnAt: FieldValue.serverTimestamp(),
          statusHistory: FieldValue.arrayUnion({
            status: "withdrawn",
            by: "recruiter",
            recruiterEmail: recruiter.email,
            atIso: new Date().toISOString(),
          }),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true })
        const saved = await ref.get()
        res.set("Cache-Control", "private, max-age=0, no-store")
        res.status(200).json({ ok: true, application: publicRecruiterRoleApplication(saved) })
        return
      }

      const existingAppsSnap = await db
        .collection(RECRUITER_ROLE_APPLICATIONS_COLLECTION)
        .where("recruiterId", "==", recruiter.recruiterId)
        .limit(200)
        .get()
      let pendingCount = 0
      let approvedCount = 0
      for (const docSnap of existingAppsSnap.docs) {
        if (docSnap.id === applicationId) continue
        const status = docSnap.data().status
        if (status === "pending") pendingCount++
        if (status === "approved") approvedCount++
      }
      if (pendingCount >= 3) {
        res.status(403).json({ ok: false, reason: "pending_application_limit_reached" })
        return
      }
      if (approvedCount >= 10) {
        res.status(403).json({ ok: false, reason: "approved_role_limit_reached" })
        return
      }

      let preparedCandidateCount = 0
      for (const candidateId of payload.preparedCandidateIds) {
        const candidateSnap = await db.collection(RECRUITER_SOURCED_CANDIDATES_COLLECTION).doc(candidateId).get()
        if (!candidateSnap.exists) {
          res.status(400).json({ ok: false, reason: "invalid_prepared_candidate" })
          return
        }
        const candidate = candidateSnap.data() as Record<string, unknown>
        if (candidate.recruiterId !== recruiter.recruiterId) {
          res.status(400).json({ ok: false, reason: "invalid_prepared_candidate" })
          return
        }
        const candidateJobId = typeof candidate.jobId === "string" ? candidate.jobId : ""
        const candidateInboundJobId = typeof candidate.inboundJobId === "string" ? candidate.inboundJobId : ""
        const candidateAlreadyAssigned = Boolean(candidateJobId || candidateInboundJobId)
        if (
          candidateAlreadyAssigned &&
          candidateJobId !== realJobId &&
          candidateInboundJobId !== payload.jobId
        ) {
          res.status(400).json({ ok: false, reason: "prepared_candidate_wrong_role" })
          return
        }
        preparedCandidateCount++
      }

      await ref.set({
        applicationId,
        recruiterId: recruiter.recruiterId,
        recruiterEmail: recruiter.email,
        jobId: realJobId,
        inboundJobId: payload.jobId,
        jobTitleSnapshot: String(jobData.title ?? ""),
        companyLabelSnapshot: rb.label.company,
        status: "pending",
        pitch: payload.pitch ?? null,
        anonymizeCandidates: payload.anonymizeCandidates,
        preparedCandidateIds: payload.preparedCandidateIds,
        preparedCandidateCount,
        statusHistory: FieldValue.arrayUnion({
          status: "pending",
          by: "recruiter",
          recruiterEmail: recruiter.email,
          atIso: new Date().toISOString(),
          note: "Applied to recruit",
        }),
        updatedAt: FieldValue.serverTimestamp(),
        ...(existing.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      }, { merge: true })
      const saved = await ref.get()
      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({ ok: true, application: publicRecruiterRoleApplication(saved) })
    } catch (err) {
      logger.error("paRecruiterRoleApplicationSave_failed", { error: String(err), recruiterId: recruiter.recruiterId })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

export const paRecruiterSourcedCandidatesList = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const db = getFirestore()
    const recruiter = await authenticateRecruiter(db, req)
    if (!recruiter) {
      res.status(401).json({ ok: false, reason: "unauthorized" })
      return
    }
    try {
      const snap = await db
        .collection(RECRUITER_SOURCED_CANDIDATES_COLLECTION)
        .where("recruiterId", "==", recruiter.recruiterId)
        .limit(300)
        .get()
      const candidates = snap.docs
        .map(publicRecruiterSourcedCandidate)
        .sort((a, b) => timestampMs(b.updatedAt ?? b.createdAt) - timestampMs(a.updatedAt ?? a.createdAt))
      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({ ok: true, recruiter, candidates })
    } catch (err) {
      logger.error("paRecruiterSourcedCandidatesList_failed", { error: String(err), recruiterId: recruiter.recruiterId })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

export const paRecruiterSourcedCandidateSave = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const db = getFirestore()
    const recruiter = await authenticateRecruiter(db, req)
    if (!recruiter) {
      res.status(401).json({ ok: false, reason: "unauthorized" })
      return
    }
    const validated = validateRecruiterSourcedCandidateInput(req.body)
    if (!validated.ok) {
      res.status(400).json({ ok: false, reason: validated.reason })
      return
    }
    const payload = validated.value

    try {
      let realJobId: string | null = null
      let jobData: Record<string, unknown> | null = null
      let rb: RecruiterBoardPayload | null = null
      if (payload.jobId) {
        realJobId = await resolvePublicIdToDocId(db, payload.jobId)
        if (!realJobId) {
          res.status(404).json({ ok: false, reason: "job_not_found" })
          return
        }
        const jobSnap = await db.collection("pa-jobs").doc(realJobId).get()
        if (!jobSnap.exists) {
          res.status(404).json({ ok: false, reason: "job_not_found" })
          return
        }
        jobData = jobSnap.data() as Record<string, unknown>
        rb = (jobData.recruiterBoard as RecruiterBoardPayload | undefined) ?? null
        if (jobData.wekruitCollaborationStatus !== "collaborated" || !rb || rb.active !== true) {
          res.status(403).json({ ok: false, reason: "job_not_active_on_board" })
          return
        }
      }

      const candidateLinkKey = hashRecruiterCandidateLink(payload.candidate.link)
      const candidateEmailKey = payload.candidate.email
        ? hashRecruiterCandidateEmail(payload.candidate.email)
        : null
      let candidateId = payload.candidateId
      let ref = candidateId
        ? db.collection(RECRUITER_SOURCED_CANDIDATES_COLLECTION).doc(candidateId)
        : null
      let existing = ref ? await ref.get() : null

      const candidateMatches = await db
        .collection(RECRUITER_SOURCED_CANDIDATES_COLLECTION)
        .where("candidateLinkKey", "==", candidateLinkKey)
        .limit(25)
        .get()

      for (const match of candidateMatches.docs) {
        const data = match.data()
        const matchJobId = typeof data.jobId === "string" ? data.jobId : ""
        const matchInboundJobId = typeof data.inboundJobId === "string" ? data.inboundJobId : ""
        const sameCandidateScope = realJobId
          ? matchJobId === realJobId || matchInboundJobId === payload.jobId
          : !matchJobId && !matchInboundJobId
        if (!sameCandidateScope) continue
        if (data.recruiterId !== recruiter.recruiterId) {
          if (!realJobId) continue
          res.status(409).json({ ok: false, reason: "candidate_already_sourced_for_role" })
          return
        }
        if (!candidateId) {
          candidateId = match.id
          ref = match.ref
          existing = match
          break
        }
      }
      if (candidateEmailKey) {
        const emailMatches = await db
          .collection(RECRUITER_SOURCED_CANDIDATES_COLLECTION)
          .where("candidateEmailKey", "==", candidateEmailKey)
          .limit(25)
          .get()

        for (const match of emailMatches.docs) {
          const data = match.data()
          const matchJobId = typeof data.jobId === "string" ? data.jobId : ""
          const matchInboundJobId = typeof data.inboundJobId === "string" ? data.inboundJobId : ""
          const sameCandidateScope = realJobId
            ? matchJobId === realJobId || matchInboundJobId === payload.jobId
            : !matchJobId && !matchInboundJobId
          if (!sameCandidateScope) continue
          if (data.recruiterId !== recruiter.recruiterId) {
            if (!realJobId) continue
            res.status(409).json({ ok: false, reason: "candidate_already_sourced_for_role" })
            return
          }
          if (!candidateId) {
            candidateId = match.id
            ref = match.ref
            existing = match
            break
          }
        }
      }

      candidateId = candidateId || randomUUID()
      ref = ref || db.collection(RECRUITER_SOURCED_CANDIDATES_COLLECTION).doc(candidateId)
      existing = existing || await ref.get()
      if (existing.exists) {
        const existingRecruiterId = existing.data()?.recruiterId
        if (existingRecruiterId !== recruiter.recruiterId) {
          res.status(403).json({ ok: false, reason: "candidate_belongs_to_another_recruiter" })
          return
        }
      }
      if (realJobId) {
        const candidateConflict = await findRecruiterCandidateIdentityConflict(db, {
          realJobId,
          recruiterId: recruiter.recruiterId,
          candidateLinkKey,
          candidateEmailKey,
          ignoreSourcedCandidateId: candidateId,
        })
        if (candidateConflict) {
          res.status(409).json({ ok: false, reason: candidateConflict.reason })
          return
        }
      }
      const existingData = existing.exists ? existing.data() as Record<string, unknown> : {}
      const existingHasRole =
        typeof existingData.jobId === "string" ||
        typeof existingData.inboundJobId === "string"
      const rolePatch = realJobId && jobData && rb
        ? {
            jobId: realJobId,
            inboundJobId: payload.jobId,
            jobTitleSnapshot: String(jobData.title ?? ""),
            companyLabelSnapshot: rb.label.company,
            candidateScope: "role",
          }
        : existingHasRole
          ? {}
          : { candidateScope: "global" }

      const calibrationPatch = payload.calibrationRequest
        ? {
            calibrationStatus: "calibration_requested",
            calibrationNote: payload.calibrationRequest.note ?? null,
            calibrationUpdatedAt: FieldValue.serverTimestamp(),
            calibrationRequestedByEmail: recruiter.email,
            calibrationHistory: FieldValue.arrayUnion({
              stage: payload.stage,
              calibrationStatus: "calibration_requested",
              note: payload.calibrationRequest.note ?? null,
              by: "recruiter",
              recruiterEmail: recruiter.email,
              atIso: new Date().toISOString(),
            }),
          }
        : {}

      await ref.set({
        candidateId,
        recruiterId: recruiter.recruiterId,
        recruiterEmail: recruiter.email,
        ...rolePatch,
        candidateLinkKey,
        ...(candidateEmailKey ? { candidateEmailKey } : {}),
        stage: payload.stage,
        candidate: payload.candidate,
        ...(payload.outreach ? { outreach: payload.outreach } : {}),
        ...calibrationPatch,
        updatedAt: FieldValue.serverTimestamp(),
        ...(existing.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      }, { merge: true })
      const saved = await ref.get()
      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({ ok: true, candidate: publicRecruiterSourcedCandidate(saved) })
    } catch (err) {
      logger.error("paRecruiterSourcedCandidateSave_failed", { error: String(err), recruiterId: recruiter.recruiterId })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

export const paRecruiterRoleFeedbackList = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const db = getFirestore()
    const recruiter = await authenticateRecruiter(db, req)
    if (!recruiter) {
      res.status(401).json({ ok: false, reason: "unauthorized" })
      return
    }
    try {
      const snap = await db
        .collection(RECRUITER_ROLE_FEEDBACK_COLLECTION)
        .where("recruiterId", "==", recruiter.recruiterId)
        .limit(300)
        .get()
      const feedback = snap.docs
        .map(publicRecruiterRoleFeedback)
        .sort((a, b) => timestampMs(b.updatedAt ?? b.createdAt) - timestampMs(a.updatedAt ?? a.createdAt))
      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({ ok: true, recruiter, feedback })
    } catch (err) {
      logger.error("paRecruiterRoleFeedbackList_failed", { error: String(err), recruiterId: recruiter.recruiterId })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

export const paRecruiterRoleFeedbackSave = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const db = getFirestore()
    const recruiter = await authenticateRecruiter(db, req)
    if (!recruiter) {
      res.status(401).json({ ok: false, reason: "unauthorized" })
      return
    }
    const validated = validateRecruiterRoleFeedbackInput(req.body)
    if (!validated.ok) {
      res.status(400).json({ ok: false, reason: validated.reason })
      return
    }
    const payload = validated.value

    try {
      const realJobId = await resolvePublicIdToDocId(db, payload.jobId)
      if (!realJobId) {
        res.status(404).json({ ok: false, reason: "job_not_found" })
        return
      }
      const jobSnap = await db.collection("pa-jobs").doc(realJobId).get()
      if (!jobSnap.exists) {
        res.status(404).json({ ok: false, reason: "job_not_found" })
        return
      }
      const jobData = jobSnap.data() as Record<string, unknown>
      const rb = jobData.recruiterBoard as RecruiterBoardPayload | undefined
      if (jobData.wekruitCollaborationStatus !== "collaborated" || !rb || rb.active !== true) {
        res.status(403).json({ ok: false, reason: "job_not_active_on_board" })
        return
      }

      const feedbackId = createHash("sha256")
        .update(`${recruiter.recruiterId}:${realJobId}`)
        .digest("hex")
        .slice(0, 40)
      const ref = db.collection(RECRUITER_ROLE_FEEDBACK_COLLECTION).doc(feedbackId)
      const existing = await ref.get()
      await ref.set({
        feedbackId,
        recruiterId: recruiter.recruiterId,
        recruiterEmail: recruiter.email,
        jobId: realJobId,
        inboundJobId: payload.jobId,
        jobTitleSnapshot: String(jobData.title ?? ""),
        companyLabelSnapshot: rb.label.company,
        difficulty: payload.difficulty,
        reasons: payload.reasons,
        note: payload.note ?? null,
        updatedAt: FieldValue.serverTimestamp(),
        ...(existing.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      }, { merge: true })
      const saved = await ref.get()
      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({ ok: true, feedback: publicRecruiterRoleFeedback(saved) })
    } catch (err) {
      logger.error("paRecruiterRoleFeedbackSave_failed", { error: String(err), recruiterId: recruiter.recruiterId })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

export const paRecruiterRoleQuestionsList = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const db = getFirestore()
    const recruiter = await authenticateRecruiter(db, req)
    if (!recruiter) {
      res.status(401).json({ ok: false, reason: "unauthorized" })
      return
    }
    try {
      const snap = await db
        .collection(RECRUITER_ROLE_QUESTIONS_COLLECTION)
        .where("recruiterId", "==", recruiter.recruiterId)
        .limit(300)
        .get()
      const questions = snap.docs
        .map(publicRecruiterRoleQuestion)
        .sort((a, b) => timestampMs(b.updatedAt ?? b.createdAt) - timestampMs(a.updatedAt ?? a.createdAt))
      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({ ok: true, recruiter, questions })
    } catch (err) {
      logger.error("paRecruiterRoleQuestionsList_failed", { error: String(err), recruiterId: recruiter.recruiterId })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

export const paRecruiterRoleIntelligenceList = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const db = getFirestore()
    const recruiter = await authenticateRecruiter(db, req)
    if (!recruiter) {
      res.status(401).json({ ok: false, reason: "unauthorized" })
      return
    }

    try {
      const [jobSnap, sourcedSnap, submissionSnap, feedbackSnap, questionSnap, applicationSnap] = await Promise.all([
        db.collection("pa-jobs").where("wekruitCollaborationStatus", "==", "collaborated").limit(500).get(),
        db.collection(RECRUITER_SOURCED_CANDIDATES_COLLECTION).limit(1000).get(),
        db.collection(RECRUITER_SUBMISSIONS_COLLECTION).limit(1000).get(),
        db.collection(RECRUITER_ROLE_FEEDBACK_COLLECTION).limit(1000).get(),
        db.collection(RECRUITER_ROLE_QUESTIONS_COLLECTION).limit(1000).get(),
        db.collection(RECRUITER_ROLE_APPLICATIONS_COLLECTION).limit(1000).get(),
      ])
      const jobs = jobSnap.docs
        .map((doc): RecruiterRoleIntelligenceJobAlias | null => {
          const data = doc.data() as Record<string, unknown>
          const rb = data.recruiterBoard as RecruiterBoardPayload | undefined
          if (!rb || rb.active !== true) return null
          const publicId = typeof data.publicId === "string" ? data.publicId.trim() : ""
          const jobId = publicId || doc.id
          return {
            jobId,
            aliases: [doc.id, jobId].filter((id, index, arr) => id && arr.indexOf(id) === index),
          }
        })
        .filter((job): job is RecruiterRoleIntelligenceJobAlias => job !== null)
      const intelligence = buildRecruiterRoleIntelligence(jobs, recruiter.recruiterId, {
        sourcedCandidates: sourcedSnap.docs.map((doc) => doc.data()),
        submissions: submissionSnap.docs.map((doc) => doc.data()),
        feedback: feedbackSnap.docs.map((doc) => doc.data()),
        questions: questionSnap.docs.map((doc) => doc.data()),
        applications: applicationSnap.docs.map((doc) => doc.data()),
      })
      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({ ok: true, recruiter, intelligence })
    } catch (err) {
      logger.error("paRecruiterRoleIntelligenceList_failed", { error: String(err), recruiterId: recruiter.recruiterId })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

export const paRecruiterRoleQuestionCreate = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const db = getFirestore()
    const recruiter = await authenticateRecruiter(db, req)
    if (!recruiter) {
      res.status(401).json({ ok: false, reason: "unauthorized" })
      return
    }
    const validated = validateRecruiterRoleQuestionInput(req.body)
    if (!validated.ok) {
      res.status(400).json({ ok: false, reason: validated.reason })
      return
    }
    const payload = validated.value

    try {
      const realJobId = await resolvePublicIdToDocId(db, payload.jobId)
      if (!realJobId) {
        res.status(404).json({ ok: false, reason: "job_not_found" })
        return
      }
      const jobSnap = await db.collection("pa-jobs").doc(realJobId).get()
      if (!jobSnap.exists) {
        res.status(404).json({ ok: false, reason: "job_not_found" })
        return
      }
      const jobData = jobSnap.data() as Record<string, unknown>
      const rb = jobData.recruiterBoard as RecruiterBoardPayload | undefined
      if (jobData.wekruitCollaborationStatus !== "collaborated" || !rb || rb.active !== true) {
        res.status(403).json({ ok: false, reason: "job_not_active_on_board" })
        return
      }

      const questionId = randomUUID()
      const ref = db.collection(RECRUITER_ROLE_QUESTIONS_COLLECTION).doc(questionId)
      await ref.create({
        questionId,
        recruiterId: recruiter.recruiterId,
        recruiterEmail: recruiter.email,
        jobId: realJobId,
        inboundJobId: payload.jobId,
        jobTitleSnapshot: String(jobData.title ?? ""),
        companyLabelSnapshot: rb.label.company,
        question: payload.question,
        status: "open",
        answer: null,
        answeredByEmail: null,
        answeredAt: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })
      const saved = await ref.get()
      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({ ok: true, question: publicRecruiterRoleQuestion(saved) })
    } catch (err) {
      logger.error("paRecruiterRoleQuestionCreate_failed", { error: String(err), recruiterId: recruiter.recruiterId })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

export const paRecruiterSubmissionGet = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const submissionId = typeof req.query.submissionId === "string" ? req.query.submissionId.trim() : ""
    if (!submissionId || submissionId.length > 200) {
      res.status(400).json({ ok: false, reason: "missing_submission_id" })
      return
    }

    const identity = await recruiterIdentityFromFirebaseBearer(req)
    if (!identity) {
      res.status(401).json({ ok: false, reason: "unauthorized" })
      return
    }

    const db = getFirestore()
    try {
      const snap = await db.collection(RECRUITER_SUBMISSIONS_COLLECTION).doc(submissionId).get()
      if (!snap.exists) {
        res.status(404).json({ ok: false, reason: "not_found" })
        return
      }
      const data = snap.data() as Record<string, unknown>
      const isAdmin = identity.email.endsWith(HIRING_BOARD_ADMIN_EMAIL_DOMAIN)
      const isOwner = typeof data.recruiterId === "string" && data.recruiterId === identity.uid
      if (!isAdmin && !isOwner) {
        res.status(403).json({ ok: false, reason: "forbidden" })
        return
      }
      const submission = publicRecruiterSubmission({ id: snap.id, data: () => snap.data() as Record<string, unknown> })
      const comments = await db
        .collection(RECRUITER_SUBMISSIONS_COLLECTION)
        .doc(submissionId)
        .collection("comments")
        .orderBy("createdAt", "asc")
        .limit(200)
        .get()
      const commentsList = comments.docs.map(publicRecruiterSubmissionComment)

      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({ ok: true, submission, comments: commentsList })
    } catch (err) {
      logger.error("paRecruiterSubmissionGet_failed", { error: String(err), submissionId })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

export const paRecruiterSubmissionsList = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const db = getFirestore()
    const recruiter = await authenticateRecruiter(db, req)
    if (!recruiter) {
      res.status(401).json({ ok: false, reason: "unauthorized" })
      return
    }

    try {
      const byRecruiter = await db
        .collection(RECRUITER_SUBMISSIONS_COLLECTION)
        .where("recruiterId", "==", recruiter.recruiterId)
        .limit(200)
        .get()

      const merged = new Map<string, RecruiterSubmissionListItem>()
      for (const doc of byRecruiter.docs) {
        merged.set(doc.id, publicRecruiterSubmission(doc))
      }
      const submissions = [...merged.values()]
        .sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt))
        .slice(0, 200)

      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({ ok: true, recruiter, submissions })
    } catch (err) {
      logger.error("paRecruiterSubmissionsList_failed", { error: String(err), recruiterId: recruiter.recruiterId })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

export const paRecruiterPreferencesUpdate = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const db = getFirestore()
    const recruiter = await authenticateRecruiter(db, req)
    if (!recruiter) {
      res.status(401).json({ ok: false, reason: "unauthorized" })
      return
    }
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {}
    const prefsBody = body.notificationPreferences && typeof body.notificationPreferences === "object"
      ? body.notificationPreferences as Record<string, unknown>
      : null
    const workspacePrefsBody = body.workspacePreferences && typeof body.workspacePreferences === "object"
      ? body.workspacePreferences as Record<string, unknown>
      : null
    const legalEntityNameUpdate = typeof body.legalEntityName === "string" ? body.legalEntityName.trim() : undefined
    const tosAcceptedUpdate = body.tosAccepted === true ? true : undefined
    if (!prefsBody && !workspacePrefsBody && legalEntityNameUpdate === undefined && tosAcceptedUpdate === undefined) {
      res.status(400).json({ ok: false, reason: "missing_preferences_update" })
      return
    }
    if (legalEntityNameUpdate !== undefined && legalEntityNameUpdate.length > 300) {
      res.status(400).json({ ok: false, reason: "legal_entity_name_too_long" })
      return
    }
    const notificationPreferencesResult = prefsBody
      ? mergeRecruiterNotificationPreferences(recruiter.notificationPreferences, prefsBody)
      : { ok: true as const, value: recruiter.notificationPreferences }
    if (!notificationPreferencesResult.ok) {
      res.status(400).json({ ok: false, reason: notificationPreferencesResult.reason })
      return
    }
    const workspacePreferencesResult = workspacePrefsBody
      ? validateRecruiterWorkspacePreferences(workspacePrefsBody)
      : { ok: true as const, value: recruiter.workspacePreferences }
    if (!workspacePreferencesResult.ok) {
      res.status(400).json({ ok: false, reason: workspacePreferencesResult.reason })
      return
    }
    const notificationPreferences = notificationPreferencesResult.value
    const workspacePreferences = workspacePreferencesResult.value
    const updateDoc: Record<string, unknown> = {
      notificationPreferences,
      workspacePreferences,
      lastSeenAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }
    if (legalEntityNameUpdate !== undefined) updateDoc.legalEntityName = legalEntityNameUpdate
    if (tosAcceptedUpdate) updateDoc.tosAcceptedAt = new Date().toISOString()
    await db.collection(RECRUITER_USERS_COLLECTION).doc(recruiter.recruiterId).set(updateDoc, { merge: true })
    const updatedRecruiter = {
      ...recruiter,
      notificationPreferences,
      workspacePreferences,
      ...(legalEntityNameUpdate !== undefined ? { legalEntityName: legalEntityNameUpdate } : {}),
      ...(tosAcceptedUpdate ? { tosAcceptedAt: new Date().toISOString() } : {}),
    }
    res.set("Cache-Control", "private, max-age=0, no-store")
    res.status(200).json({
      ok: true,
      recruiter: updatedRecruiter,
    })
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// paRecruiterSubmission — public POST
// ─────────────────────────────────────────────────────────────────────────────

interface SubmissionPayload {
  jobId: string
  sourcedCandidateId?: string
  submitter: { name: string; email: string }
  candidate: {
    name: string
    email?: string
    link: string
    linkedinUrl?: string
    resumeUrl?: string
    currentRole?: string
    yoe?: string
    notes?: string
    currentCompany?: string
    location?: string
    workAuthorization?: string
    employmentStatus?: string
    compensationExpectation?: string
    noticePeriod?: string
    interviewAvailability?: string
  }
  checklist: Record<string, ChecklistCellLevel>
  /** Per-job custom submit fields, keyed by `recruiterBoard.submitFields[].id`. */
  extraFields?: Record<string, string>
  /** Recruiter self-flag of background pillars (school/gpa/degree/company). Advisory. */
  candidateBackground?: Record<string, "strong" | "weak">
  candidateConsent: true
  /** Caller hint: which surface produced this submission. Tracked verbatim. */
  source?: string
}

interface CandidateConfirmationResendInput {
  submissionId: string
}

interface RecruiterCandidateIdentityCheckInput {
  jobId: string
  candidate: {
    email?: string
    link: string
  }
}

/** Allowed values for `source` in the request body. */
const ALLOWED_SUBMISSION_SOURCES = new Set(["hiring-board", "api", "unknown"])
/** Pattern for the `Idempotency-Key` header. Mirrors Stripe's rules. */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,200}$/

function recruiterPrimaryRoleMatches(
  recruiter: RecruiterProfilePublic | null,
  inboundJobId: string,
  realJobId: string,
): boolean {
  if (!recruiter) return false
  return recruiter.workspacePreferences.primaryRoleIds.includes(inboundJobId) ||
    recruiter.workspacePreferences.primaryRoleIds.includes(realJobId)
}

async function recruiterApprovedForRole(
  db: Firestore,
  recruiter: RecruiterProfilePublic | null,
  inboundJobId: string,
  realJobId: string,
): Promise<boolean> {
  if (!recruiter) return false
  if (recruiterPrimaryRoleMatches(recruiter, inboundJobId, realJobId)) return true
  const applicationId = recruiterRoleApplicationId(recruiter.recruiterId, realJobId)
  const snap = await db.collection(RECRUITER_ROLE_APPLICATIONS_COLLECTION).doc(applicationId).get()
  if (!snap.exists) return false
  return snap.data()?.status === "approved"
}

async function recentSingleSubmissionCount(
  db: Firestore,
  recruiter: RecruiterProfilePublic,
  weekStartMs: number,
): Promise<number> {
  const snap = await db
    .collection(RECRUITER_SUBMISSIONS_COLLECTION)
    .where("recruiterId", "==", recruiter.recruiterId)
    .limit(200)
    .get()
  let count = 0
  for (const doc of snap.docs) {
    const data = doc.data()
    const createdMs = timestampMs(data.createdAt)
    if (!createdMs || createdMs < weekStartMs) continue
    if (data.submissionMode === "primary_role") continue
    const inboundJobId = typeof data.inboundJobId === "string" ? data.inboundJobId : ""
    const realJobId = typeof data.jobId === "string" ? data.jobId : ""
    if (recruiterPrimaryRoleMatches(recruiter, inboundJobId, realJobId)) continue
    count += 1
  }
  return count
}

export interface RecruiterCandidateIdentityConflictInput {
  realJobId: string
  recruiterId?: string | null
  candidateLinkKey: string
  candidateEmailKey?: string | null
  ignoreSourcedCandidateId?: string | null
}

export interface RecruiterCandidateIdentityDoc {
  id: string
  collection: "submissions" | "sourced"
  data: Record<string, unknown>
}

export function validateRecruiterCandidateIdentityCheckInput(input: unknown):
  | { ok: true; value: RecruiterCandidateIdentityCheckInput }
  | { ok: false; reason: string } {
  if (!input || typeof input !== "object") return { ok: false, reason: "missing_body" }
  const b = input as Record<string, unknown>
  if (!isNonEmptyString(b.jobId)) return { ok: false, reason: "missing_jobId" }
  if (b.jobId.length > 200) return { ok: false, reason: "jobId_too_long" }
  const c = b.candidate as Record<string, unknown> | undefined
  if (!c || typeof c !== "object") return { ok: false, reason: "missing_candidate" }
  if (!isNonEmptyString(c.link)) return { ok: false, reason: "missing_candidate_link" }
  if (c.link.length > 2000) return { ok: false, reason: "candidate_link_too_long" }
  const canonicalCandidateLink = canonicalizeRecruiterLinkedInProfileUrl(c.link)
  if (!canonicalCandidateLink) return { ok: false, reason: "candidate_linkedin_url_required" }
  const candidateEmail = typeof c.email === "string" ? normalizeRecruiterCandidateEmail(c.email) : ""
  if (c.email !== undefined && c.email !== null && c.email !== "" && !validRecruiterCandidateEmail(String(c.email))) {
    return { ok: false, reason: "invalid_candidate_email" }
  }
  return {
    ok: true,
    value: {
      jobId: b.jobId.trim(),
      candidate: {
        link: canonicalCandidateLink,
        ...(candidateEmail ? { email: candidateEmail } : {}),
      },
    },
  }
}

export function recruiterCandidateIdentityConflictForRole(
  input: RecruiterCandidateIdentityConflictInput,
  docs: RecruiterCandidateIdentityDoc[],
): { reason: "candidate_already_submitted_for_role" | "candidate_already_sourced_for_role"; docId: string } | null {
  for (const doc of docs) {
    const data = doc.data
    if (data.jobId !== input.realJobId) continue
    const linkMatches = data.candidateLinkKey === input.candidateLinkKey
    const emailMatches = Boolean(input.candidateEmailKey && data.candidateEmailKey === input.candidateEmailKey)
    if (!linkMatches && !emailMatches) continue
    if (doc.collection === "submissions") {
      const sourcedCandidateId = typeof data.sourcedCandidateId === "string" ? data.sourcedCandidateId : ""
      if (input.ignoreSourcedCandidateId && sourcedCandidateId === input.ignoreSourcedCandidateId) continue
      return { reason: "candidate_already_submitted_for_role", docId: doc.id }
    }
    const owner = typeof data.recruiterId === "string" ? data.recruiterId : null
    const linkedSubmissionId = typeof data.linkedSubmissionId === "string" ? data.linkedSubmissionId.trim() : ""
    if (linkedSubmissionId) {
      if (input.ignoreSourcedCandidateId && doc.id === input.ignoreSourcedCandidateId && owner === input.recruiterId) continue
      return { reason: "candidate_already_submitted_for_role", docId: doc.id }
    }
    if (owner && owner !== input.recruiterId) {
      return { reason: "candidate_already_sourced_for_role", docId: doc.id }
    }
  }
  return null
}

async function findRecruiterCandidateIdentityConflict(
  db: Firestore,
  input: RecruiterCandidateIdentityConflictInput,
): Promise<ReturnType<typeof recruiterCandidateIdentityConflictForRole>> {
  const docs = new Map<string, RecruiterCandidateIdentityDoc>()
  const collect = async (
    collectionName: string,
    collectionKind: RecruiterCandidateIdentityDoc["collection"],
    field: "candidateLinkKey" | "candidateEmailKey",
    value?: string | null,
  ) => {
    if (!value) return
    const snap = await db.collection(collectionName).where(field, "==", value).limit(25).get()
    for (const doc of snap.docs) {
      docs.set(`${collectionKind}:${doc.id}`, {
        id: doc.id,
        collection: collectionKind,
        data: doc.data(),
      })
    }
  }

  await Promise.all([
    collect(RECRUITER_SUBMISSIONS_COLLECTION, "submissions", "candidateLinkKey", input.candidateLinkKey),
    collect(RECRUITER_SUBMISSIONS_COLLECTION, "submissions", "candidateEmailKey", input.candidateEmailKey),
    collect(RECRUITER_SOURCED_CANDIDATES_COLLECTION, "sourced", "candidateLinkKey", input.candidateLinkKey),
    collect(RECRUITER_SOURCED_CANDIDATES_COLLECTION, "sourced", "candidateEmailKey", input.candidateEmailKey),
  ])

  return recruiterCandidateIdentityConflictForRole(input, [...docs.values()])
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0
}

export function validateSubmission(input: unknown):
  | { ok: true; value: SubmissionPayload }
  | { ok: false; reason: string } {
  if (!input || typeof input !== "object") return { ok: false, reason: "missing_body" }
  const b = input as Record<string, unknown>
  if (!isNonEmptyString(b.jobId)) return { ok: false, reason: "missing_jobId" }
  if (b.jobId.length > 200) return { ok: false, reason: "jobId_too_long" }
  let sourcedCandidateId: string | undefined
  if (b.sourcedCandidateId !== undefined && b.sourcedCandidateId !== null && b.sourcedCandidateId !== "") {
    if (typeof b.sourcedCandidateId !== "string") return { ok: false, reason: "invalid_sourced_candidate_id" }
    sourcedCandidateId = b.sourcedCandidateId.trim()
    if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(sourcedCandidateId)) return { ok: false, reason: "invalid_sourced_candidate_id" }
  }

  const s = b.submitter as Record<string, unknown> | undefined
  if (!s || typeof s !== "object") return { ok: false, reason: "missing_submitter" }
  if (!isNonEmptyString(s.name)) return { ok: false, reason: "missing_submitter_name" }
  if (!isNonEmptyString(s.email)) return { ok: false, reason: "missing_submitter_email" }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) return { ok: false, reason: "invalid_email" }
  if (s.name.length > 200 || s.email.length > 320) return { ok: false, reason: "submitter_too_long" }

  const c = b.candidate as Record<string, unknown> | undefined
  if (!c || typeof c !== "object") return { ok: false, reason: "missing_candidate" }
  if (!isNonEmptyString(c.name)) return { ok: false, reason: "missing_candidate_name" }
  if (!isNonEmptyString(c.link)) return { ok: false, reason: "missing_candidate_link" }
  if (c.name.length > 200) return { ok: false, reason: "candidate_name_too_long" }
  if (c.link.length > 2000) return { ok: false, reason: "candidate_link_too_long" }
  const candidateEmail = typeof c.email === "string" ? normalizeRecruiterCandidateEmail(c.email) : ""
  if (c.email !== undefined && c.email !== null && c.email !== "" && !validRecruiterCandidateEmail(String(c.email))) {
    return { ok: false, reason: "invalid_candidate_email" }
  }
  for (const k of ["currentRole", "yoe", "notes"] as const) {
    if (c[k] !== undefined && typeof c[k] !== "string") return { ok: false, reason: `invalid_${k}` }
    if (typeof c[k] === "string" && (c[k] as string).length > 4000) return { ok: false, reason: `${k}_too_long` }
  }
  for (const k of CANDIDATE_CORE_CELL_FIELDS) {
    if (c[k] !== undefined && c[k] !== null && typeof c[k] !== "string") return { ok: false, reason: `invalid_${k}` }
    if (typeof c[k] === "string" && (c[k] as string).length > CANDIDATE_CORE_CELL_MAX_LENGTH) {
      return { ok: false, reason: `${k}_too_long` }
    }
  }
  // Candidate LinkedIn is the identity URL. It can arrive as top-level
  // `candidateLinkedinUrl`, nested `candidate.linkedinUrl`, or the legacy
  // `candidate.link` field. Resume URLs remain separate evidence links.
  const optionalCandidateUrl = (raw: unknown, field: string):
    | { ok: true; value?: string }
    | { ok: false; reason: string } => {
    if (raw === undefined || raw === null || raw === "") return { ok: true }
    if (typeof raw !== "string") return { ok: false, reason: `invalid_${field}` }
    const trimmed = raw.trim()
    if (!trimmed) return { ok: true }
    if (trimmed.length > 500) return { ok: false, reason: `${field}_too_long` }
    return { ok: true, value: trimmed }
  }
  const explicitLinkedInRaw = b.candidateLinkedinUrl ?? c.linkedinUrl
  const linkedinUrl = optionalCandidateUrl(explicitLinkedInRaw, "candidate_linkedin_url")
  if (!linkedinUrl.ok) return linkedinUrl
  const canonicalLinkedIn = canonicalizeRecruiterLinkedInProfileUrl(linkedinUrl.value ?? c.link)
  if (!canonicalLinkedIn) {
    return {
      ok: false,
      reason: linkedinUrl.value ? "invalid_candidate_linkedin_url" : "candidate_linkedin_url_required",
    }
  }
  const resumeUrl = optionalCandidateUrl(b.candidateResumeUrl ?? c.resumeUrl, "candidate_resume_url")
  if (!resumeUrl.ok) return resumeUrl

  const checklistResult = coerceSubmissionChecklistInput(b.checklist)
  if (!checklistResult.ok) return checklistResult
  const cleanedChecklist = checklistResult.value

  // Optional per-job extra fields. Values are trimmed strings keyed by the
  // job's `recruiterBoard.submitFields[].id`. Required/url/unknown-key rules
  // are applied against the job config in `resolveSubmissionExtraFields`.
  let extraFields: Record<string, string> | undefined
  if (b.extraFields !== undefined && b.extraFields !== null) {
    if (typeof b.extraFields !== "object" || Array.isArray(b.extraFields)) {
      return { ok: false, reason: "invalid_extra_fields" }
    }
    const cleanedExtraFields: Record<string, string> = {}
    for (const [k, v] of Object.entries(b.extraFields as Record<string, unknown>)) {
      const key = typeof k === "string" ? k.trim() : ""
      if (!key || key.length > 120) return { ok: false, reason: "invalid_extra_fields" }
      if (typeof v !== "string") return { ok: false, reason: "invalid_extra_fields" }
      const value = v.trim()
      if (value.length > 500) return { ok: false, reason: "extra_field_too_long" }
      if (value) cleanedExtraFields[key] = value
    }
    if (Object.keys(cleanedExtraFields).length > 0) extraFields = cleanedExtraFields
  }

  // Optional recruiter self-flag of the background pillars (school/gpa/degree/
  // company). Advisory only — fully lenient, never rejects a submission. Unknown
  // keys/values are dropped silently.
  let candidateBackground: Record<string, "strong" | "weak"> | undefined
  if (b.candidateBackground && typeof b.candidateBackground === "object" && !Array.isArray(b.candidateBackground)) {
    const allowedPillars = new Set(["school", "gpa", "degree", "company"])
    const cleanedBg: Record<string, "strong" | "weak"> = {}
    for (const [k, v] of Object.entries(b.candidateBackground as Record<string, unknown>)) {
      if (allowedPillars.has(k) && (v === "strong" || v === "weak")) cleanedBg[k] = v
    }
    if (Object.keys(cleanedBg).length > 0) candidateBackground = cleanedBg
  }

  // Optional `source` hint. Unknown strings are rejected so audit data stays
  // closed-vocab; missing values default to "unknown" downstream.
  let source: string | undefined = undefined
  if (b.source !== undefined) {
    if (typeof b.source !== "string") return { ok: false, reason: "invalid_source" }
    const trimmed = b.source.trim()
    if (trimmed.length === 0) {
      source = undefined
    } else if (!ALLOWED_SUBMISSION_SOURCES.has(trimmed)) {
      return { ok: false, reason: "invalid_source" }
    } else {
      source = trimmed
    }
  }
  // No candidate consent gate: submitting a candidate on the recruiter platform
  // IS the consent (recruiter-asserted). WeKruit never contacts candidates, so we
  // never block a submission on a candidateConsent flag. Stored as true downstream.
  if (!candidateEmail) return { ok: false, reason: "missing_candidate_email" }

  const currentRole = sanitizeOptionalString(c.currentRole, 4000)
  const yoe = sanitizeOptionalString(c.yoe, 4000)
  const notes = sanitizeOptionalString(c.notes, 4000)
  const currentCompany = sanitizeOptionalString(c.currentCompany, CANDIDATE_CORE_CELL_MAX_LENGTH)
  const location = sanitizeOptionalString(c.location, CANDIDATE_CORE_CELL_MAX_LENGTH)
  const workAuthorization = sanitizeOptionalString(c.workAuthorization, CANDIDATE_CORE_CELL_MAX_LENGTH)
  const employmentStatus = sanitizeOptionalString(c.employmentStatus, CANDIDATE_CORE_CELL_MAX_LENGTH)
  const compensationExpectation = sanitizeOptionalString(c.compensationExpectation, CANDIDATE_CORE_CELL_MAX_LENGTH)
  const noticePeriod = sanitizeOptionalString(c.noticePeriod, CANDIDATE_CORE_CELL_MAX_LENGTH)
  const interviewAvailability = sanitizeOptionalString(c.interviewAvailability, CANDIDATE_CORE_CELL_MAX_LENGTH)

  return {
    ok: true,
    value: {
      jobId: b.jobId,
      ...(sourcedCandidateId ? { sourcedCandidateId } : {}),
      submitter: {
        name: s.name.trim(),
        email: (s.email as string).trim().toLowerCase(),
      },
      candidate: {
        name: (c.name as string).trim(),
        ...(candidateEmail ? { email: candidateEmail } : {}),
        link: canonicalLinkedIn,
        linkedinUrl: canonicalLinkedIn,
        ...(resumeUrl.value ? { resumeUrl: resumeUrl.value } : {}),
        ...(currentRole ? { currentRole } : {}),
        ...(yoe ? { yoe } : {}),
        ...(notes ? { notes } : {}),
        ...(currentCompany ? { currentCompany } : {}),
        ...(location ? { location } : {}),
        ...(workAuthorization ? { workAuthorization } : {}),
        ...(employmentStatus ? { employmentStatus } : {}),
        ...(compensationExpectation ? { compensationExpectation } : {}),
        ...(noticePeriod ? { noticePeriod } : {}),
        ...(interviewAvailability ? { interviewAvailability } : {}),
      },
      checklist: cleanedChecklist,
      ...(extraFields ? { extraFields } : {}),
      ...(candidateBackground ? { candidateBackground } : {}),
      candidateConsent: true,
      source,
    },
  }
}

export function sanitizeRecruiterSubmitFields(raw: unknown): RecruiterBoardSubmitField[] {
  if (!Array.isArray(raw)) return []
  const fields: RecruiterBoardSubmitField[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const f = entry as Record<string, unknown>
    const id = typeof f.id === "string" ? f.id.trim() : ""
    if (!id || id.length > 120 || seen.has(id)) continue
    seen.add(id)
    const label = typeof f.label === "string" ? f.label.trim() : ""
    const placeholder = typeof f.placeholder === "string" ? f.placeholder.trim() : ""
    fields.push({
      id,
      label: label || id,
      kind: f.kind === "url" ? "url" : "text",
      ...(f.required === true ? { required: true } : {}),
      ...(placeholder ? { placeholder } : {}),
    })
  }
  return fields
}

/**
 * Applies the job's `recruiterBoard.submitFields` config to caller-provided
 * `extraFields`. Unknown keys are dropped silently; required fields must be
 * present and non-empty; `url` fields must parse as a URL (scheme optional —
 * `https://` is prepended when missing and the stored value keeps it).
 */
export function resolveSubmissionExtraFields(
  submitFields: RecruiterBoardSubmitField[],
  extraFields: Record<string, string> | undefined,
): { ok: true; value: Record<string, string> | null } | { ok: false; reason: string } {
  const provided = extraFields ?? {}
  const resolved: Record<string, string> = {}
  for (const field of submitFields) {
    const raw = typeof provided[field.id] === "string" ? provided[field.id]!.trim() : ""
    if (!raw) {
      if (field.required === true) return { ok: false, reason: `missing_extra_field_${field.id}` }
      continue
    }
    if (raw.length > 500) return { ok: false, reason: `extra_field_too_long_${field.id}` }
    if (field.kind === "url") {
      const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
      try {
        new URL(candidate)
      } catch {
        return { ok: false, reason: `invalid_extra_field_url_${field.id}` }
      }
      resolved[field.id] = candidate
    } else {
      resolved[field.id] = raw
    }
  }
  return { ok: true, value: Object.keys(resolved).length ? resolved : null }
}

export function validateCandidateConfirmationResendInput(input: unknown):
  | { ok: true; value: CandidateConfirmationResendInput }
  | { ok: false; reason: string } {
  if (!input || typeof input !== "object") return { ok: false, reason: "missing_body" }
  const b = input as Record<string, unknown>
  if (!isNonEmptyString(b.submissionId)) return { ok: false, reason: "missing_submission_id" }
  const submissionId = b.submissionId.trim()
  if (!IDEMPOTENCY_KEY_RE.test(submissionId)) return { ok: false, reason: "invalid_submission_id" }
  return { ok: true, value: { submissionId } }
}

export interface SubmissionScore {
  hardChecked: number
  hardTotal: number
  fitChecked: number
  fitTotal: number
  bonusChecked: number
  bonusTotal: number
  antiChecked: number
  antiTotal: number
}

/**
 * True when a checklist cell value counts toward the score. Legacy boolean
 * `true` and the `"strong"` / `"yes"` levels count; `"partial"` / `"no"` /
 * `false` / absent do not.
 */
export function checklistCellChecked(value: unknown): boolean {
  return value === true || value === "strong" || value === "yes"
}

export function computeSubmissionScore(
  groups: RecruiterBoardChecklistGroup[],
  checklist: Record<string, boolean | string>,
): SubmissionScore {
  const score: SubmissionScore = {
    hardChecked: 0, hardTotal: 0,
    fitChecked: 0, fitTotal: 0,
    bonusChecked: 0, bonusTotal: 0,
    antiChecked: 0, antiTotal: 0,
  }
  for (const g of groups) {
    for (const item of g.items) {
      const checked = checklistCellChecked(checklist[item.id])
      switch (g.kind) {
        case "hard":  score.hardTotal++;  if (checked) score.hardChecked++;  break
        case "fit":   score.fitTotal++;   if (checked) score.fitChecked++;   break
        case "bonus": score.bonusTotal++; if (checked) score.bonusChecked++; break
        case "anti":  score.antiTotal++;  if (checked) score.antiChecked++;  break
      }
    }
  }
  return score
}

// ─────────────────────────────────────────────────────────────────────────────
// paRecruiterSubmissionUpdate — owning recruiter edits the sheet row
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Statuses in which the owning recruiter may still edit the row. Once the
 * candidate reaches "With client" (or any later/terminal state) the row locks
 * and edits return 409 `row_locked`.
 */
export const RECRUITER_EDITABLE_SUBMISSION_STATUSES = [
  "submitted",
  "new",
  "reviewing",
  "wekruit_interview",
] as const

/**
 * Candidate fields the owning recruiter may edit after submission. Identity
 * fields (name/email/link) are deliberately NOT editable — they feed the
 * candidate dedup keys and the double-opt-in confirmation email.
 * `max` mirrors the create-path limits; `reasonKey` mirrors the create-path
 * validation reason vocabulary.
 */
const EDITABLE_SUBMISSION_CANDIDATE_FIELDS: ReadonlyArray<{ field: string; max: number; reasonKey: string }> = [
  { field: "linkedinUrl", max: 500, reasonKey: "candidate_linkedin_url" },
  { field: "resumeUrl", max: 500, reasonKey: "candidate_resume_url" },
  { field: "currentRole", max: 4000, reasonKey: "currentRole" },
  { field: "yoe", max: 4000, reasonKey: "yoe" },
  { field: "notes", max: 4000, reasonKey: "notes" },
  ...CANDIDATE_CORE_CELL_FIELDS.map((field) => ({
    field,
    max: CANDIDATE_CORE_CELL_MAX_LENGTH,
    reasonKey: field,
  })),
]

export interface RecruiterSubmissionUpdateInput {
  submissionId: string
  /** Editable candidate fields only; trimmed. `""` clears the stored field. */
  candidate?: Record<string, string>
  /** Coerced string-level map. Merged over the stored map; score recomputed. */
  checklist?: Record<string, ChecklistCellLevel>
  /** Full replacement, re-validated against the job's submitFields config. */
  extraFields?: Record<string, string>
}

export function validateRecruiterSubmissionUpdateInput(input: unknown):
  | { ok: true; value: RecruiterSubmissionUpdateInput }
  | { ok: false; reason: string } {
  if (!input || typeof input !== "object") return { ok: false, reason: "missing_body" }
  const b = input as Record<string, unknown>
  if (!isNonEmptyString(b.submissionId)) return { ok: false, reason: "missing_submission_id" }
  const submissionId = b.submissionId.trim()
  if (!IDEMPOTENCY_KEY_RE.test(submissionId)) return { ok: false, reason: "invalid_submission_id" }

  let candidate: Record<string, string> | undefined
  if (b.candidate !== undefined && b.candidate !== null) {
    if (typeof b.candidate !== "object" || Array.isArray(b.candidate)) {
      return { ok: false, reason: "invalid_candidate" }
    }
    const c = b.candidate as Record<string, unknown>
    const cleaned: Record<string, string> = {}
    for (const { field, max, reasonKey } of EDITABLE_SUBMISSION_CANDIDATE_FIELDS) {
      if (c[field] === undefined) continue
      if (c[field] === null) {
        cleaned[field] = ""
        continue
      }
      if (typeof c[field] !== "string") return { ok: false, reason: `invalid_${reasonKey}` }
      const raw = c[field] as string
      if (raw.length > max) return { ok: false, reason: `${reasonKey}_too_long` }
      cleaned[field] = raw.trim()
    }
    if (Object.keys(cleaned).length > 0) candidate = cleaned
  }

  let checklist: Record<string, ChecklistCellLevel> | undefined
  if (b.checklist !== undefined && b.checklist !== null) {
    if (typeof b.checklist !== "object" || Array.isArray(b.checklist)) {
      return { ok: false, reason: "invalid_checklist" }
    }
    const coerced = coerceSubmissionChecklistInput(b.checklist)
    if (!coerced.ok) return coerced
    checklist = coerced.value
  }

  let extraFields: Record<string, string> | undefined
  if (b.extraFields !== undefined && b.extraFields !== null) {
    if (typeof b.extraFields !== "object" || Array.isArray(b.extraFields)) {
      return { ok: false, reason: "invalid_extra_fields" }
    }
    const cleanedExtraFields: Record<string, string> = {}
    for (const [k, v] of Object.entries(b.extraFields as Record<string, unknown>)) {
      const key = typeof k === "string" ? k.trim() : ""
      if (!key || key.length > 120) return { ok: false, reason: "invalid_extra_fields" }
      if (typeof v !== "string") return { ok: false, reason: "invalid_extra_fields" }
      const value = v.trim()
      if (value.length > 500) return { ok: false, reason: "extra_field_too_long" }
      if (value) cleanedExtraFields[key] = value
    }
    extraFields = cleanedExtraFields
  }

  if (!candidate && !checklist && extraFields === undefined) {
    return { ok: false, reason: "missing_update" }
  }

  return {
    ok: true,
    value: {
      submissionId,
      ...(candidate ? { candidate } : {}),
      ...(checklist ? { checklist } : {}),
      ...(extraFields !== undefined ? { extraFields } : {}),
    },
  }
}

/**
 * Applies a validated recruiter edit to one owned submission row.
 *
 *   - Only the OWNING recruiter (`submission.recruiterId === recruiter.recruiterId`)
 *     may edit → 403 `forbidden` otherwise.
 *   - Editable only while `status ∈ RECRUITER_EDITABLE_SUBMISSION_STATUSES` →
 *     409 `row_locked` otherwise.
 *   - `checklist` merges over the stored (coerced) map and the score is
 *     recomputed against the job's current checklist groups.
 *   - `extraFields` is re-validated against the job's submitFields config with
 *     the same rules as create (required/url/unknown-key).
 *   - Candidate edits merge per-field; `""` clears the field. The whole
 *     `candidate` map is rewritten via `update()` so cleared keys actually
 *     disappear (set+merge would deep-merge them back).
 *   - Stamps `lastEditedAt` + `lastEditedBy: "recruiter"`.
 */
export async function applyRecruiterSubmissionUpdate(
  db: Firestore,
  recruiter: RecruiterProfilePublic,
  input: RecruiterSubmissionUpdateInput,
): Promise<
  | { ok: true; submission: RecruiterSubmissionListItem }
  | { ok: false; status: 400 | 403 | 404 | 409; reason: string }
> {
  const submissionRef = db.collection(RECRUITER_SUBMISSIONS_COLLECTION).doc(input.submissionId)
  const snap = await submissionRef.get()
  if (!snap.exists) return { ok: false, status: 404, reason: "submission_not_found" }
  const data = (snap.data() ?? {}) as Record<string, unknown>
  if (data.recruiterId !== recruiter.recruiterId) return { ok: false, status: 403, reason: "forbidden" }
  const status = typeof data.status === "string" && data.status.trim() ? data.status.trim() : "submitted"
  if (!(RECRUITER_EDITABLE_SUBMISSION_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, status: 409, reason: "row_locked" }
  }

  const update: Record<string, unknown> = {}

  if (input.candidate) {
    const storedCandidate = data.candidate && typeof data.candidate === "object" && !Array.isArray(data.candidate)
      ? { ...(data.candidate as Record<string, unknown>) }
      : {}
    for (const [field, value] of Object.entries(input.candidate)) {
      if (value === "") delete storedCandidate[field]
      else storedCandidate[field] = value
    }
    update.candidate = storedCandidate
  }

  let recruiterBoard: RecruiterBoardPayload | undefined
  if (input.checklist || input.extraFields !== undefined) {
    const jobId = typeof data.jobId === "string" ? data.jobId : ""
    const jobSnap = jobId ? await db.collection("pa-jobs").doc(jobId).get() : null
    const jobData = jobSnap?.exists ? jobSnap.data() as Record<string, unknown> : null
    recruiterBoard = jobData?.recruiterBoard as RecruiterBoardPayload | undefined
    if (!recruiterBoard) return { ok: false, status: 404, reason: "job_not_found" }
  }

  if (input.checklist) {
    const mergedChecklist = { ...coerceStoredSubmissionChecklist(data.checklist), ...input.checklist }
    const groups = Array.isArray(recruiterBoard?.checklist?.groups) ? recruiterBoard.checklist.groups : []
    update.checklist = mergedChecklist
    update.score = computeSubmissionScore(groups, mergedChecklist)
  }

  if (input.extraFields !== undefined) {
    const extraFieldsResult = resolveSubmissionExtraFields(
      sanitizeRecruiterSubmitFields(recruiterBoard?.submitFields),
      input.extraFields,
    )
    if (!extraFieldsResult.ok) return { ok: false, status: 400, reason: extraFieldsResult.reason }
    update.extraFields = extraFieldsResult.value ?? {}
  }

  if (Object.keys(update).length === 0) return { ok: false, status: 400, reason: "missing_update" }

  update.lastEditedAt = FieldValue.serverTimestamp()
  update.lastEditedBy = "recruiter"
  update.updatedAt = FieldValue.serverTimestamp()
  await submissionRef.update(update)

  const fresh = await submissionRef.get()
  return {
    ok: true,
    submission: publicRecruiterSubmission({
      id: input.submissionId,
      data: () => (fresh.data() ?? {}) as Record<string, unknown>,
    }),
  }
}

export const paRecruiterSubmissionUpdate = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const db = getFirestore()
    const recruiter = await authenticateRecruiter(db, req)
    if (!recruiter) {
      res.status(401).json({ ok: false, reason: "unauthorized" })
      return
    }
    const validated = validateRecruiterSubmissionUpdateInput(req.body)
    if (!validated.ok) {
      res.status(400).json({ ok: false, reason: validated.reason })
      return
    }
    try {
      const result = await applyRecruiterSubmissionUpdate(db, recruiter, validated.value)
      if (!result.ok) {
        res.status(result.status).json({ ok: false, reason: result.reason })
        return
      }
      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({ ok: true, submission: result.submission })
    } catch (err) {
      logger.error("paRecruiterSubmissionUpdate_failed", {
        error: String(err),
        recruiterId: recruiter.recruiterId,
        submissionId: validated.value.submissionId,
      })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// Submission comments — recruiter↔WeKruit thread per sheet row
// ─────────────────────────────────────────────────────────────────────────────

const RECRUITER_SUBMISSION_COMMENTS_SUBCOLLECTION = "comments"
const RECRUITER_SUBMISSION_COMMENT_MAX_LENGTH = 4000
const RECRUITER_SUBMISSION_COMMENT_LIST_LIMIT = 200

export interface RecruiterSubmissionCommentListItem {
  id: string
  message: string
  by: "recruiter" | "wekruit"
  authorName: string
  authorEmail?: string
  at: string | null
}

export function publicRecruiterSubmissionComment(
  d: { id: string; data: () => Record<string, unknown> | undefined },
): RecruiterSubmissionCommentListItem | null {
  const data = d.data() ?? {}
  const message = typeof data.message === "string" ? data.message.trim() : ""
  const by = data.by === "recruiter" || data.by === "wekruit" ? data.by : null
  if (!message || !by) return null
  const authorEmail = typeof data.authorEmail === "string" ? data.authorEmail.trim() : ""
  return {
    id: d.id,
    message,
    by,
    authorName: typeof data.authorName === "string" && data.authorName.trim()
      ? data.authorName.trim()
      : (by === "wekruit" ? "WeKruit" : "Recruiter"),
    ...(authorEmail ? { authorEmail } : {}),
    at: coerceToIso(data.at),
  }
}

export function validateRecruiterSubmissionCommentAddInput(input: unknown):
  | { ok: true; value: { submissionId: string; message: string } }
  | { ok: false; reason: string } {
  if (!input || typeof input !== "object") return { ok: false, reason: "missing_body" }
  const b = input as Record<string, unknown>
  if (!isNonEmptyString(b.submissionId)) return { ok: false, reason: "missing_submission_id" }
  const submissionId = b.submissionId.trim()
  if (!IDEMPOTENCY_KEY_RE.test(submissionId)) return { ok: false, reason: "invalid_submission_id" }
  if (typeof b.message !== "string" || !b.message.trim()) return { ok: false, reason: "missing_message" }
  if (b.message.length > RECRUITER_SUBMISSION_COMMENT_MAX_LENGTH) return { ok: false, reason: "message_too_long" }
  return { ok: true, value: { submissionId, message: b.message.trim() } }
}

async function loadOwnedRecruiterSubmission(
  db: Firestore,
  recruiter: RecruiterProfilePublic,
  submissionId: string,
): Promise<
  | { ok: true; ref: DocumentReference; data: Record<string, unknown> }
  | { ok: false; status: 403 | 404; reason: string }
> {
  const ref = db.collection(RECRUITER_SUBMISSIONS_COLLECTION).doc(submissionId)
  const snap = await ref.get()
  if (!snap.exists) return { ok: false, status: 404, reason: "submission_not_found" }
  const data = (snap.data() ?? {}) as Record<string, unknown>
  if (data.recruiterId !== recruiter.recruiterId) return { ok: false, status: 403, reason: "forbidden" }
  return { ok: true, ref: ref as DocumentReference, data }
}

export async function listRecruiterSubmissionComments(
  db: Firestore,
  recruiter: RecruiterProfilePublic,
  submissionId: string,
): Promise<
  | { ok: true; comments: RecruiterSubmissionCommentListItem[] }
  | { ok: false; status: 403 | 404; reason: string }
> {
  const owned = await loadOwnedRecruiterSubmission(db, recruiter, submissionId)
  if (!owned.ok) return owned
  const snap = await owned.ref.collection(RECRUITER_SUBMISSION_COMMENTS_SUBCOLLECTION).get()
  const comments = snap.docs
    .map((doc) => publicRecruiterSubmissionComment(doc))
    .filter((comment): comment is RecruiterSubmissionCommentListItem => comment !== null)
    .sort((a, b) => timestampMs(a.at) - timestampMs(b.at))
    .slice(0, RECRUITER_SUBMISSION_COMMENT_LIST_LIMIT)
  return { ok: true, comments }
}

export async function addRecruiterSubmissionComment(
  db: Firestore,
  recruiter: RecruiterProfilePublic,
  input: { submissionId: string; message: string },
  nowIso = new Date().toISOString(),
): Promise<
  | { ok: true; comment: RecruiterSubmissionCommentListItem }
  | { ok: false; status: 403 | 404; reason: string }
> {
  const owned = await loadOwnedRecruiterSubmission(db, recruiter, input.submissionId)
  if (!owned.ok) return owned
  const commentId = randomUUID()
  const commentDoc = {
    message: input.message,
    by: "recruiter" as const,
    authorName: recruiter.name || recruiter.email,
    authorEmail: recruiter.email,
    at: nowIso,
  }
  await owned.ref.collection(RECRUITER_SUBMISSION_COMMENTS_SUBCOLLECTION).doc(commentId).set(commentDoc)
  return {
    ok: true,
    comment: { id: commentId, ...commentDoc },
  }
}

export const paRecruiterSubmissionCommentsList = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const db = getFirestore()
    const recruiter = await authenticateRecruiter(db, req)
    if (!recruiter) {
      res.status(401).json({ ok: false, reason: "unauthorized" })
      return
    }
    const submissionId = parseQueryString(req.query.submissionId) ?? ""
    if (!submissionId) {
      res.status(400).json({ ok: false, reason: "missing_submission_id" })
      return
    }
    if (!IDEMPOTENCY_KEY_RE.test(submissionId)) {
      res.status(400).json({ ok: false, reason: "invalid_submission_id" })
      return
    }
    try {
      const result = await listRecruiterSubmissionComments(db, recruiter, submissionId)
      if (!result.ok) {
        res.status(result.status).json({ ok: false, reason: result.reason })
        return
      }
      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({ ok: true, comments: result.comments })
    } catch (err) {
      logger.error("paRecruiterSubmissionCommentsList_failed", {
        error: String(err),
        recruiterId: recruiter.recruiterId,
        submissionId,
      })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

export const paRecruiterSubmissionCommentAdd = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const db = getFirestore()
    const recruiter = await authenticateRecruiter(db, req)
    if (!recruiter) {
      res.status(401).json({ ok: false, reason: "unauthorized" })
      return
    }
    const validated = validateRecruiterSubmissionCommentAddInput(req.body)
    if (!validated.ok) {
      res.status(400).json({ ok: false, reason: validated.reason })
      return
    }
    try {
      const result = await addRecruiterSubmissionComment(db, recruiter, validated.value)
      if (!result.ok) {
        res.status(result.status).json({ ok: false, reason: result.reason })
        return
      }
      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({ ok: true, comment: result.comment })
    } catch (err) {
      logger.error("paRecruiterSubmissionCommentAdd_failed", {
        error: String(err),
        recruiterId: recruiter.recruiterId,
        submissionId: validated.value.submissionId,
      })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

interface RecruiterRoleNotificationEmailInput {
  recruiterName: string
  roleTitle: string
  companyLabel: string
  location: string
  roleUrl: string
}

interface RecruiterInviteEmailInput {
  recruiterEmail: string
  inviteCode: string
  expiresAt?: string | null
}

interface RecruiterSubmissionUpdateEmailInput {
  title: string
  body: string
  roleTitle?: string
  companyLabel?: string
  actionUrl?: string
}

export function shouldNotifyRecruitersForRoleRelease(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): boolean {
  const isReleased = (data: Record<string, unknown> | null | undefined): boolean => {
    const rb = data?.recruiterBoard as RecruiterBoardPayload | undefined
    return data?.wekruitCollaborationStatus === "collaborated" && rb?.active === true
  }
  return !isReleased(before) && isReleased(after)
}

export function composeRecruiterRoleNotificationEmail(
  input: RecruiterRoleNotificationEmailInput,
): { subject: string; text: string; html: string } {
  const subject = `New WeKruit role: ${input.roleTitle}`
  const text = [
    `Hi ${input.recruiterName || "there"},`,
    "",
    "A new WeKruit collab role is open for recruiter submissions.",
    "",
    `Role: ${input.roleTitle}`,
    `Company: ${input.companyLabel}`,
    `Location: ${input.location}`,
    "",
    `Open the role and submit candidates: ${input.roleUrl}`,
    "",
    "You can turn off new-role emails in your WeKruit recruiter settings.",
  ].join("\n")
  const html = [
    `<p>Hi ${escapeHtml(input.recruiterName || "there")},</p>`,
    "<p>A new WeKruit collab role is open for recruiter submissions.</p>",
    "<ul>",
    `<li><b>Role:</b> ${escapeHtml(input.roleTitle)}</li>`,
    `<li><b>Company:</b> ${escapeHtml(input.companyLabel)}</li>`,
    `<li><b>Location:</b> ${escapeHtml(input.location)}</li>`,
    "</ul>",
    `<p><a href="${escapeHtml(input.roleUrl)}">Open the role and submit candidates</a></p>`,
    "<p style=\"color:#666;font-size:12px\">You can turn off new-role emails in your WeKruit recruiter settings.</p>",
  ].join("")
  return { subject, text, html }
}

export function recruiterInviteUrl(inviteCode: string, recruiterEmail?: string | null): string {
  const url = new URL(`${RECRUITER_PUBLIC_BASE_URL}/recruiters`)
  url.searchParams.set("code", inviteCode)
  if (recruiterEmail) url.searchParams.set("email", recruiterEmail)
  return url.toString()
}

export function recruiterEmailInviteUrl(recruiterEmail: string): string {
  const url = new URL(`${RECRUITER_PUBLIC_BASE_URL}/recruiters`)
  url.searchParams.set("invite", "1")
  url.searchParams.set("email", recruiterEmail)
  return url.toString()
}

export function composeRecruiterInviteEmail(
  input: RecruiterInviteEmailInput,
): { subject: string; text: string; html: string } {
  const expiresLine = input.expiresAt ? `This invite expires at ${input.expiresAt}.` : ""
  const subject = "Your WeKruit recruiter invite"
  const acceptUrl = recruiterEmailInviteUrl(input.recruiterEmail)
  const text = [
    "Hi there,",
    "",
    "WeKruit invited you to submit roles and candidates in the recruiter workspace.",
    "",
    `Accept your invite: ${acceptUrl}`,
    "",
    "Sign in with Google using this email address and your workspace opens:",
    input.recruiterEmail,
    "",
    "If the button doesn't work, go to the recruiter site and sign in with this Google account.",
    ...(expiresLine ? [expiresLine] : []),
    "After you sign in, your Google account becomes your recruiter account.",
  ].join("\n")
  const html = [
    "<p>Hi there,</p>",
    "<p>WeKruit invited you to submit roles and candidates in the recruiter workspace.</p>",
    `<p><a href="${escapeHtml(acceptUrl)}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Accept your invite</a></p>`,
    `<p>Sign in with Google as <b>${escapeHtml(input.recruiterEmail)}</b> and your workspace opens.</p>`,
    `<p style="color:#666;font-size:12px">If the button doesn't work, go to the recruiter site and sign in with this Google account.${expiresLine ? ` ${escapeHtml(expiresLine)}` : ""} After you sign in, your Google account becomes your recruiter account.</p>`,
  ].join("")
  return { subject, text, html }
}

export function composeRecruiterSubmissionUpdateEmail(
  input: RecruiterSubmissionUpdateEmailInput,
): { subject: string; text: string; html: string } {
  const subject = input.title.startsWith("WeKruit") ? input.title : `WeKruit update: ${input.title}`
  const context = [input.roleTitle, input.companyLabel].filter(Boolean).join(" · ")
  const text = [
    "Hi there,",
    "",
    input.title,
    context,
    input.body,
    "",
    input.actionUrl ? `Open the recruiter workspace: ${input.actionUrl}` : `Open the recruiter workspace: ${RECRUITER_PUBLIC_BASE_URL}/recruiters?tab=submissions`,
  ].filter((line) => line !== "").join("\n")
  const html = [
    "<p>Hi there,</p>",
    `<p><b>${escapeHtml(input.title)}</b></p>`,
    context ? `<p>${escapeHtml(context)}</p>` : "",
    input.body ? `<p>${escapeHtml(input.body)}</p>` : "",
    `<p><a href="${escapeHtml(input.actionUrl ?? `${RECRUITER_PUBLIC_BASE_URL}/recruiters?tab=submissions`)}">Open the recruiter workspace</a></p>`,
  ].join("")
  return { subject, text, html }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

interface RecruiterMailgunConfig {
  apiKey: string
  domain: string
  from: string
  region: "us" | "eu"
}

function recruiterMailgunConfigFromEnv(): RecruiterMailgunConfig | null {
  const apiKey = (process.env.MAILGUN_API_KEY ?? "").trim()
  const domain = (process.env.MAILGUN_DOMAIN ?? "").trim()
  if (!apiKey || !domain) return null
  const from = (process.env.MAILGUN_FROM ?? "").trim() || `WeKruit <claire@${domain}>`
  const region = process.env.MAILGUN_REGION === "eu" ? "eu" : "us"
  return { apiKey, domain, from, region }
}

async function sendRecruiterMailgunEmail(
  cfg: RecruiterMailgunConfig,
  input: { to: string; subject: string; text: string; html: string },
): Promise<{ ok: true; messageId?: string } | { ok: false; status: number; raw: string }> {
  const base = cfg.region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net"
  const body = new URLSearchParams()
  body.set("from", cfg.from)
  body.set("to", input.to)
  body.set("subject", input.subject)
  body.set("text", input.text)
  body.set("html", input.html)
  const resp = await fetch(`${base}/v3/${encodeURIComponent(cfg.domain)}/messages`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`api:${cfg.apiKey}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  })
  const raw = await resp.text()
  if (!resp.ok) return { ok: false, status: resp.status, raw }
  try {
    const parsed = JSON.parse(raw) as { id?: string }
    return { ok: true, messageId: parsed.id }
  } catch {
    return { ok: true }
  }
}

async function markInviteEmailFailed(
  inviteRef: DocumentReference,
  reason: string,
  provider?: string,
): Promise<void> {
  await inviteRef.set({
    inviteEmailStatus: "failed",
    inviteEmailProvider: provider ?? null,
    inviteEmailLastError: reason.slice(0, 500),
    inviteEmailFailedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })
}

async function sendRecruiterInviteEmailForCode(
  inviteRef: DocumentReference,
  input: RecruiterInviteEmailInput,
): Promise<{ ok: true; messageId?: string } | { ok: false; reason: string; status: number }> {
  const cfg = recruiterMailgunConfigFromEnv()
  if (!cfg) {
    await markInviteEmailFailed(inviteRef, "mailgun_not_configured")
    return { ok: false, reason: "mailgun_not_configured", status: 503 }
  }
  const emailContent = composeRecruiterInviteEmail(input)
  try {
    const result = await sendRecruiterMailgunEmail(cfg, { to: input.recruiterEmail, ...emailContent })
    if (result.ok) {
      await inviteRef.set({
        inviteEmailStatus: "sent",
        inviteEmailProvider: "mailgun",
        inviteEmailMessageId: result.messageId ?? null,
        inviteEmailSentAt: FieldValue.serverTimestamp(),
        inviteEmailLastError: null,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
      return { ok: true, messageId: result.messageId }
    }
    const reason = `mailgun_${result.status}:${result.raw.slice(0, 300)}`
    await markInviteEmailFailed(inviteRef, reason, "mailgun")
    return { ok: false, reason: "invite_email_failed", status: 502 }
  } catch (err) {
    await markInviteEmailFailed(inviteRef, String(err), "mailgun")
    return { ok: false, reason: "invite_email_failed", status: 500 }
  }
}

type RecruiterInviteEmailSender = (
  inviteRef: DocumentReference,
  input: RecruiterInviteEmailInput,
) => Promise<{ ok: true; messageId?: string } | { ok: false; reason: string; status: number }>

export async function resendRecruiterInviteCodeEmail(
  db: Firestore,
  input: { inviteCodeId: string; adminEmail: string },
  sendInviteEmail: RecruiterInviteEmailSender = sendRecruiterInviteEmailForCode,
): Promise<
  | { ok: true; inviteCodeId: string; recruiterEmail: string; emailStatus: "sent"; emailMessageId?: string }
  | { ok: false; status: number; reason: string }
> {
  const ref = db.collection(RECRUITER_INVITE_CODES_COLLECTION).doc(input.inviteCodeId)
  const snap = await ref.get()
  if (!snap.exists) return { ok: false, status: 404, reason: "invite_code_not_found" }

  const data = snap.data() as Record<string, unknown>
  if (!inviteCodeUsable(data, Date.now())) {
    return { ok: false, status: 409, reason: "invite_code_not_usable" }
  }
  const rawCode = typeof data.inviteCode === "string" ? normalizeRecruiterInviteCode(data.inviteCode) : ""
  if (!isNonEmptyString(rawCode) || hashRecruiterInviteCode(rawCode) !== input.inviteCodeId) {
    return { ok: false, status: 409, reason: "invite_code_not_visible" }
  }
  const recruiterEmail = typeof data.recruiterEmail === "string" ? normalizeRecruiterEmail(data.recruiterEmail) : ""
  if (!validEmail(recruiterEmail)) {
    return { ok: false, status: 409, reason: "missing_recruiter_email" }
  }
  if (data.inviteEmailStatus !== "sent") {
    return { ok: false, status: 409, reason: "invite_email_not_sent" }
  }

  const sent = await sendInviteEmail(ref, {
    recruiterEmail,
    inviteCode: rawCode,
    expiresAt: coerceToIso(data.expiresAt) ?? null,
  })
  if (!sent.ok) return { ok: false, status: sent.status, reason: sent.reason }

  await ref.set({
    inviteEmailLastResentAt: FieldValue.serverTimestamp(),
    inviteEmailLastResentByEmail: input.adminEmail,
    inviteEmailResendCount: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })

  return {
    ok: true,
    inviteCodeId: input.inviteCodeId,
    recruiterEmail,
    emailStatus: "sent",
    emailMessageId: sent.messageId,
  }
}

async function markRecruiterNotificationEmail(
  db: Firestore,
  notificationId: string,
  update: Record<string, unknown>,
): Promise<void> {
  await db.collection(RECRUITER_NOTIFICATIONS_COLLECTION).doc(notificationId).set({
    ...update,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })
}

export async function sendRecruiterSubmissionUpdateEmail(
  db: Firestore,
  notificationId: string,
  input: RecruiterSubmissionUpdateEmailInput & { to?: string; emailOptedOut?: boolean },
): Promise<"sent" | "failed" | "not_configured" | "skipped"> {
  if (input.emailOptedOut) {
    await markRecruiterNotificationEmail(db, notificationId, {
      emailStatus: "skipped",
      emailLastError: "submission_updates_email_disabled",
    })
    return "skipped"
  }
  const to = typeof input.to === "string" ? normalizeRecruiterEmail(input.to) : ""
  if (!to || !validEmail(to)) {
    await markRecruiterNotificationEmail(db, notificationId, {
      emailStatus: "skipped",
      emailLastError: "missing_recruiter_email",
    })
    return "skipped"
  }
  const cfg = recruiterMailgunConfigFromEnv()
  if (!cfg) {
    await markRecruiterNotificationEmail(db, notificationId, {
      emailStatus: "not_configured",
      emailLastError: "mailgun_not_configured",
    })
    return "not_configured"
  }
  const emailContent = composeRecruiterSubmissionUpdateEmail(input)
  try {
    const result = await sendRecruiterMailgunEmail(cfg, { to, ...emailContent })
    if (result.ok) {
      await markRecruiterNotificationEmail(db, notificationId, {
        emailStatus: "sent",
        emailProvider: "mailgun",
        emailMessageId: result.messageId ?? null,
        emailSentAt: FieldValue.serverTimestamp(),
        emailLastError: null,
      })
      return "sent"
    }
    await markRecruiterNotificationEmail(db, notificationId, {
      emailStatus: "failed",
      emailProvider: "mailgun",
      emailLastError: `mailgun_${result.status}:${result.raw.slice(0, 300)}`,
    })
    return "failed"
  } catch (err) {
    await markRecruiterNotificationEmail(db, notificationId, {
      emailStatus: "failed",
      emailProvider: "mailgun",
      emailLastError: String(err).slice(0, 300),
    })
    return "failed"
  }
}

async function notifyRecruitersForReleasedRole(
  db: Firestore,
  jobId: string,
  jobData: Record<string, unknown>,
): Promise<{ created: number; sent: number; skipped: number; failed: number }> {
  const rb = jobData.recruiterBoard as RecruiterBoardPayload | undefined
  if (!rb) return { created: 0, sent: 0, skipped: 0, failed: 0 }
  const publicJobId = typeof jobData.publicId === "string" ? jobData.publicId : jobId
  const roleUrl = `${RECRUITER_PUBLIC_BASE_URL}/recruiters/job/${encodeURIComponent(publicJobId)}`
  const roleTitle = String(jobData.title ?? "New WeKruit role")
  const cfg = recruiterMailgunConfigFromEnv()
  const profiles = await db
    .collection(RECRUITER_USERS_COLLECTION)
    .where("status", "==", "active")
    .limit(500)
    .get()

  let created = 0
  let sent = 0
  let skipped = 0
  let failed = 0
  for (const profileDoc of profiles.docs) {
    const profile = profileDoc.data() as Record<string, unknown>
    const prefs = readNotificationPreferences(profile)
    const email = typeof profile.email === "string" ? profile.email : ""
    if (!email || !prefs.newRolesEmail) {
      skipped++
      continue
    }
    const notificationId = createHash("sha256").update(`new_role:${jobId}:${profileDoc.id}`).digest("hex").slice(0, 40)
    const notificationRef = db.collection(RECRUITER_NOTIFICATIONS_COLLECTION).doc(notificationId)
    try {
      await notificationRef.create({
        notificationId,
        type: "new_role",
        status: "queued",
        recruiterId: profileDoc.id,
        recruiterEmail: email,
        jobId,
        publicJobId,
        roleTitle,
        companyLabel: rb.label.company,
        location: rb.label.location,
        roleUrl,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })
      created++
    } catch (err) {
      const message = String(err)
      if (message.includes("ALREADY_EXISTS") || message.includes("already exists")) {
        skipped++
        continue
      }
      failed++
      logger.error("recruiter_role_notification_create_failed", { error: message, jobId, recruiterId: profileDoc.id })
      continue
    }

    if (!cfg) {
      failed++
      await notificationRef.set({
        status: "failed",
        lastError: "mailgun_not_configured",
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
      continue
    }

    const emailContent = composeRecruiterRoleNotificationEmail({
      recruiterName: typeof profile.name === "string" ? profile.name : "",
      roleTitle,
      companyLabel: rb.label.company,
      location: rb.label.location,
      roleUrl,
    })
    try {
      const result = await sendRecruiterMailgunEmail(cfg, { to: email, ...emailContent })
      if (result.ok) {
        sent++
        await notificationRef.set({
          status: "sent",
          provider: "mailgun",
          messageId: result.messageId ?? null,
          sentAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true })
      } else {
        failed++
        await notificationRef.set({
          status: "failed",
          provider: "mailgun",
          lastError: `mailgun_${result.status}:${result.raw.slice(0, 300)}`,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true })
      }
    } catch (err) {
      failed++
      await notificationRef.set({
        status: "failed",
        provider: "mailgun",
        lastError: String(err).slice(0, 300),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
    }
  }
  return { created, sent, skipped, failed }
}

function eventNotificationId(type: string, entityId: string, eventId: string): string {
  return createHash("sha256").update(`${type}:${entityId}:${eventId}`).digest("hex").slice(0, 40)
}

async function createRecruiterInAppNotification(
  db: Firestore,
  input: {
    type: "candidate_calibration" | "candidate_confirmation" | "payout_update" | "requested_info" | "role_application_decision" | "role_question_answer" | "submission_comment" | "submission_feedback"
    eventId: string
    recruiterId: string
    recruiterEmail?: string
    entityType: "sourced_candidate" | "role_application" | "role_question" | "submission"
    entityId: string
    title: string
    body: string
    jobId?: string
    publicJobId?: string
    roleTitle?: string
    companyLabel?: string
    roleUrl?: string
  },
): Promise<boolean> {
  if (!input.recruiterId) return false
  const notificationId = eventNotificationId(input.type, input.entityId, input.eventId)
  try {
    await db.collection(RECRUITER_NOTIFICATIONS_COLLECTION).doc(notificationId).create({
      notificationId,
      type: input.type,
      status: "in_app",
      recruiterId: input.recruiterId,
      recruiterEmail: input.recruiterEmail ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      title: input.title,
      body: input.body,
      jobId: input.jobId ?? null,
      publicJobId: input.publicJobId ?? input.jobId ?? null,
      roleTitle: input.roleTitle ?? null,
      companyLabel: input.companyLabel ?? null,
      roleUrl: input.roleUrl ?? null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })
    return true
  } catch (err) {
    const message = String(err)
    if (message.includes("ALREADY_EXISTS") || message.includes("already exists")) return false
    throw err
  }
}

function recruiterNotificationRoleUrl(data: Record<string, unknown>): string | undefined {
  const publicJobId =
    typeof data.inboundJobId === "string" && data.inboundJobId.trim()
      ? data.inboundJobId.trim()
      : typeof data.jobId === "string" && data.jobId.trim()
        ? data.jobId.trim()
        : ""
  return publicJobId ? `${RECRUITER_PUBLIC_BASE_URL}/recruiters/job/${encodeURIComponent(publicJobId)}` : undefined
}

function compactNotificationBody(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => typeof part === "string" ? part.trim() : "")
    .filter(Boolean)
    .join(" · ")
    .slice(0, 500)
}

function roleApplicationDecisionNotification(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { title: string; body: string } | null {
  if (!after) return null
  const beforeStatus = typeof before?.status === "string" ? before.status : ""
  const afterStatus = typeof after.status === "string" ? after.status : "pending"
  if (beforeStatus === afterStatus) return null
  if (!["approved", "not_approved", "rescinded"].includes(afterStatus)) return null
  const roleTitle = typeof after.jobTitleSnapshot === "string" && after.jobTitleSnapshot.trim()
    ? after.jobTitleSnapshot.trim()
    : "Role access"
  const statusTitle =
    afterStatus === "approved" ? "Role access approved" :
    afterStatus === "not_approved" ? "Role application not approved" :
    "Role access rescinded"
  const adminNote = typeof after.adminNote === "string" ? after.adminNote : ""
  const body = compactNotificationBody([
    roleTitle,
    adminNote || (afterStatus === "approved"
      ? "You can now work this as an approved role."
      : "Review the note before reapplying or sourcing more candidates."),
  ])
  return { title: statusTitle, body }
}

function candidateCalibrationStatusLabel(status: string): string {
  switch (status) {
    case "good_fit": return "good fit"
    case "bad_fit": return "not a fit"
    case "suggested": return "suggested direction"
    case "not_rated": return "not rated"
    default:
      return status.replace(/_/g, " ")
  }
}

export function candidateCalibrationNotification(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { title: string; body: string } | null {
  if (!before || !after) return null
  const beforeStatus = typeof before.calibrationStatus === "string" ? before.calibrationStatus : "not_rated"
  const afterStatus = typeof after.calibrationStatus === "string" ? after.calibrationStatus : "not_rated"
  const beforeNote = typeof before.calibrationNote === "string" ? before.calibrationNote.trim() : ""
  const afterNote = typeof after.calibrationNote === "string" ? after.calibrationNote.trim() : ""
  const statusChanged = beforeStatus !== afterStatus
  const noteChanged = beforeNote !== afterNote
  if (!statusChanged && !noteChanged) return null
  if (afterStatus === "calibration_requested") return null
  if (beforeStatus !== "calibration_requested" && !afterNote) return null

  const candidate = after.candidate && typeof after.candidate === "object"
    ? after.candidate as Record<string, unknown>
    : {}
  const candidateName = typeof candidate.name === "string" && candidate.name.trim()
    ? candidate.name.trim()
    : "Candidate"
  const roleTitle = typeof after.jobTitleSnapshot === "string" && after.jobTitleSnapshot.trim()
    ? after.jobTitleSnapshot.trim()
    : "Role calibration"
  const body = compactNotificationBody([
    candidateName,
    roleTitle,
    `Calibration: ${candidateCalibrationStatusLabel(afterStatus)}`,
    afterNote,
  ])
  return { title: `WeKruit calibrated ${candidateName}`, body }
}

export function roleQuestionAnswerNotification(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { title: string; body: string } | null {
  if (!before || !after) return null
  const beforeStatus = typeof before.status === "string" ? before.status : "open"
  const afterStatus = typeof after.status === "string" ? after.status : "open"
  const beforeAnswer = typeof before.answer === "string" ? before.answer.trim() : ""
  const afterAnswer = typeof after.answer === "string" ? after.answer.trim() : ""
  if (afterStatus !== "answered" || !afterAnswer) return null
  if (beforeStatus === "answered" && beforeAnswer === afterAnswer) return null

  const roleTitle = typeof after.jobTitleSnapshot === "string" && after.jobTitleSnapshot.trim()
    ? after.jobTitleSnapshot.trim()
    : "Role question"
  const question = typeof after.question === "string" ? after.question.trim() : ""
  const body = compactNotificationBody([
    roleTitle,
    question ? `Q: ${question.slice(0, 180)}` : "",
    `A: ${afterAnswer}`,
  ])
  return { title: "WeKruit answered your role question", body }
}

function recruiterSubmissionStatusLabel(status: string): string {
  switch (status) {
    case "reviewing": return "WeKruit review"
    case "advanced": return "sent to hiring team"
    case "wekruit_interview": return "in a WeKruit interview"
    case "client_review": return "with the client"
    case "interviewing": return "interviewing"
    case "backburner": return "backburner"
    case "offer": return "offer"
    case "hired": return "hired"
    case "rejected": return "not a fit"
    case "duplicate": return "duplicate"
    case "submitted":
    case "new":
    default:
      return "submitted"
  }
}

function submissionStatusTransitionTitle(candidateName: string, status: string): string | null {
  switch (status) {
    case "wekruit_interview": return `${candidateName} is moving to a WeKruit interview`
    case "client_review": return `${candidateName} was sent to the client`
    case "hired": return `${candidateName} was hired — congratulations`
    default:
      return null
  }
}

function feedbackFieldChanged(before: Record<string, unknown> | null, after: Record<string, unknown>): boolean {
  const keys = ["recruiterFeedbackNote", "recruiterFeedbackRating", "recruiterFeedbackUpdatedAt"]
  if (keys.some((key) => JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after[key] ?? null))) return true
  return JSON.stringify(before?.recruiterFeedbackReasons ?? []) !== JSON.stringify(after.recruiterFeedbackReasons ?? [])
}

export function submissionFeedbackNotification(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { title: string; body: string } | null {
  if (!before || !after) return null
  const beforeStatus = typeof before.status === "string" ? before.status : "submitted"
  const afterStatus = typeof after.status === "string" ? after.status : "submitted"
  const statusChanged = beforeStatus !== afterStatus
  const feedbackChanged = feedbackFieldChanged(before, after)
  if (!statusChanged && !feedbackChanged) return null
  const candidate = after.candidate && typeof after.candidate === "object"
    ? after.candidate as Record<string, unknown>
    : {}
  const candidateName = typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : "Candidate"
  const rating = typeof after.recruiterFeedbackRating === "number" ? `${after.recruiterFeedbackRating}/4` : ""
  const reasons = Array.isArray(after.recruiterFeedbackReasons)
    ? after.recruiterFeedbackReasons.filter((reason): reason is string => typeof reason === "string").map((reason) => reason.replace(/_/g, " ")).slice(0, 4).join(", ")
    : ""
  const note = typeof after.recruiterFeedbackNote === "string" ? after.recruiterFeedbackNote : ""
  const transitionTitle = statusChanged ? submissionStatusTransitionTitle(candidateName, afterStatus) : null
  const title = transitionTitle
    ?? (feedbackChanged
      ? `WeKruit feedback for ${candidateName}`
      : `${candidateName} is ${recruiterSubmissionStatusLabel(afterStatus)}`)
  const body = compactNotificationBody([
    typeof after.jobTitleSnapshot === "string" ? after.jobTitleSnapshot : "",
    statusChanged ? `Status: ${recruiterSubmissionStatusLabel(afterStatus)}` : "",
    rating ? `Rating ${rating}` : "",
    reasons,
    note,
  ])
  return { title, body }
}

function submissionRequestedInfoEntries(data: Record<string, unknown> | null): unknown[] {
  return Array.isArray(data?.requestedInfo) ? data.requestedInfo : []
}

function requestedInfoMessage(entry: unknown): string {
  if (typeof entry === "string") return entry.trim()
  if (entry && typeof entry === "object") {
    const e = entry as Record<string, unknown>
    for (const key of ["message", "request", "text", "note"] as const) {
      if (typeof e[key] === "string" && (e[key] as string).trim()) return (e[key] as string).trim()
    }
  }
  return ""
}

export function submissionRequestedInfoNotification(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { title: string; body: string } | null {
  if (!after) return null
  const afterStatus = typeof after.status === "string" ? after.status : "submitted"
  if (afterStatus !== "reviewing") return null
  const beforeEntries = submissionRequestedInfoEntries(before)
  const afterEntries = submissionRequestedInfoEntries(after)
  if (afterEntries.length <= beforeEntries.length) return null
  const candidateName = submissionCandidateName(after)
  const message = requestedInfoMessage(afterEntries[afterEntries.length - 1])
  const body = compactNotificationBody([
    typeof after.jobTitleSnapshot === "string" ? after.jobTitleSnapshot : "",
    message,
    "Reply from the submission tracker to keep this candidate moving.",
  ])
  return { title: `WeKruit needs more info on ${candidateName}`, body }
}

const RECRUITER_SUBMISSION_FEEDBACK_OUTCOMES = [
  "submitted",
  "new",
  "reviewing",
  "advanced",
  "wekruit_interview",
  "client_review",
  "interviewing",
  "backburner",
  "offer",
  "hired",
  "rejected",
  "duplicate",
] as const

type RecruiterSubmissionFeedbackOutcome = (typeof RECRUITER_SUBMISSION_FEEDBACK_OUTCOMES)[number]

interface RecruiterSubmissionFeedbackEvent {
  eventId: string
  kind: "recruiter_submission_feedback"
  actor: "operator"
  jobId: string
  outcome: RecruiterSubmissionFeedbackOutcome
  evidence: Array<{
    source: "admin"
    summary: string
    refId: string
  }>
  payloadRedacted: {
    submissionId: string
    recruiterId: string
    status: RecruiterSubmissionFeedbackOutcome
    previousStatus: RecruiterSubmissionFeedbackOutcome
    statusChanged: boolean
    feedbackChanged: boolean
    rating: number | null
    reasonIds: string[]
    hasFeedbackNote: boolean
    source: "recruiter_board_admin"
  }
  createdAt: string
}

const RECRUITER_ROLE_APPLICATION_DECISION_OUTCOMES = [
  "approved",
  "not_approved",
  "rescinded",
] as const

type RecruiterRoleApplicationDecisionOutcome = (typeof RECRUITER_ROLE_APPLICATION_DECISION_OUTCOMES)[number]

interface RecruiterRoleApplicationDecisionEvent {
  eventId: string
  kind: "recruiter_role_application_decision"
  actor: "operator"
  jobId: string
  outcome: RecruiterRoleApplicationDecisionOutcome
  evidence: Array<{
    source: "admin"
    summary: string
    refId: string
  }>
  payloadRedacted: {
    applicationId: string
    recruiterId: string
    status: RecruiterRoleApplicationDecisionOutcome
    previousStatus: RecruiterRoleApplicationStatus
    statusChanged: boolean
    preparedCandidateCount: number
    anonymizeCandidates: boolean
    adminReviewRecommendation: string | null
    adminReviewQualityScore: number | null
    hasAdminNote: boolean
    source: "recruiter_board_admin"
  }
  createdAt: string
}

interface RecruiterRoleFeedbackEvent {
  eventId: string
  kind: "recruiter_role_feedback"
  actor: "worker"
  jobId: string
  outcome: RecruiterRoleFeedbackDifficulty
  evidence: Array<{
    source: "system"
    summary: string
    refId: string
  }>
  payloadRedacted: {
    feedbackId: string
    recruiterId: string
    difficulty: RecruiterRoleFeedbackDifficulty
    reasonIds: RecruiterRoleFeedbackReason[]
    hasNote: boolean
    source: "recruiter_board"
  }
  createdAt: string
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function auditId(prefix: string, eventId: string): string {
  return `${prefix}_${eventId}`
}

function recruiterSubmissionFeedbackOutcome(
  raw: unknown,
  fallback: RecruiterSubmissionFeedbackOutcome | null = "submitted",
): RecruiterSubmissionFeedbackOutcome | null {
  if (raw === undefined || raw === null || raw === "") return fallback
  return RECRUITER_SUBMISSION_FEEDBACK_OUTCOMES.includes(raw as RecruiterSubmissionFeedbackOutcome)
    ? raw as RecruiterSubmissionFeedbackOutcome
    : null
}

function recruiterSubmissionFeedbackRating(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return null
  return raw >= 1 && raw <= 4 ? raw : null
}

function recruiterSubmissionFeedbackReasons(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const reasons: string[] = []
  for (const item of raw) {
    if (typeof item !== "string") continue
    const reason = item.trim()
    if (!/^[a-z0-9_:-]{1,80}$/i.test(reason) || seen.has(reason)) continue
    seen.add(reason)
    reasons.push(reason)
    if (reasons.length >= 12) break
  }
  return reasons
}

function recruiterSubmissionFeedbackValueChanged(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const keys = ["recruiterFeedbackNote", "recruiterFeedbackRating"]
  if (keys.some((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null))) return true
  return JSON.stringify(before.recruiterFeedbackReasons ?? []) !== JSON.stringify(after.recruiterFeedbackReasons ?? [])
}

function recruiterSubmissionFeedbackEventId(triggerEventId: string): string {
  const safeEventId = triggerEventId.trim().replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120)
  if (safeEventId) return `recruiter_submission_feedback_${safeEventId}`
  return `recruiter_submission_feedback_${createHash("sha256").update(triggerEventId).digest("hex").slice(0, 24)}`
}

function recruiterRoleApplicationDecisionOutcome(raw: unknown): RecruiterRoleApplicationDecisionOutcome | null {
  return RECRUITER_ROLE_APPLICATION_DECISION_OUTCOMES.includes(raw as RecruiterRoleApplicationDecisionOutcome)
    ? raw as RecruiterRoleApplicationDecisionOutcome
    : null
}

function recruiterRoleApplicationStatus(raw: unknown, fallback: RecruiterRoleApplicationStatus = "pending"): RecruiterRoleApplicationStatus | null {
  if (raw === undefined || raw === null || raw === "") return fallback
  return RECRUITER_ROLE_APPLICATION_STATUSES.includes(raw as RecruiterRoleApplicationStatus)
    ? raw as RecruiterRoleApplicationStatus
    : null
}

function recruiterRoleApplicationDecisionEventId(triggerEventId: string): string {
  const safeEventId = triggerEventId.trim().replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120)
  if (safeEventId) return `recruiter_role_application_decision_${safeEventId}`
  return `recruiter_role_application_decision_${createHash("sha256").update(triggerEventId).digest("hex").slice(0, 24)}`
}

function recruiterRoleApplicationDecisionLabel(outcome: RecruiterRoleApplicationDecisionOutcome): string {
  switch (outcome) {
    case "approved": return "approved"
    case "not_approved": return "not approved"
    case "rescinded": return "rescinded"
  }
}

function recruiterRoleApplicationPreparedCandidateCount(data: Record<string, unknown>): number {
  const count = data.preparedCandidateCount
  if (typeof count === "number" && Number.isInteger(count) && count >= 0) return count
  if (!Array.isArray(data.preparedCandidateIds)) return 0
  return data.preparedCandidateIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).length
}

function recruiterRoleApplicationReviewRecommendation(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const recommendation = raw.trim()
  return /^[a-z0-9_:-]{1,80}$/i.test(recommendation) ? recommendation : null
}

function recruiterRoleApplicationReviewQualityScore(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return null
  return raw >= 0 && raw <= 100 ? raw : null
}

export function buildRecruiterRoleApplicationDecisionEvent(input: {
  triggerEventId: string
  applicationId: string
  createdAt: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}): RecruiterRoleApplicationDecisionEvent | null {
  if (!input.before || !input.after) return null
  if (!input.triggerEventId || !input.applicationId) return null

  const beforeStatus = recruiterRoleApplicationStatus(input.before.status)
  const afterStatus = recruiterRoleApplicationDecisionOutcome(input.after.status)
  if (!beforeStatus || !afterStatus) return null
  const statusChanged = beforeStatus !== afterStatus
  if (!statusChanged) return null

  const jobId = typeof input.after.jobId === "string" && input.after.jobId.trim()
    ? input.after.jobId.trim()
    : ""
  const recruiterId = typeof input.after.recruiterId === "string" && input.after.recruiterId.trim()
    ? input.after.recruiterId.trim()
    : ""
  if (!jobId || !recruiterId) return null

  const adminNote = typeof input.after.adminNote === "string" ? input.after.adminNote.trim() : ""

  return {
    eventId: recruiterRoleApplicationDecisionEventId(input.triggerEventId),
    kind: "recruiter_role_application_decision",
    actor: "operator",
    jobId,
    outcome: afterStatus,
    evidence: [{
      source: "admin",
      summary: `Recruiter role application ${recruiterRoleApplicationDecisionLabel(afterStatus)}`,
      refId: input.applicationId,
    }],
    payloadRedacted: {
      applicationId: input.applicationId,
      recruiterId,
      status: afterStatus,
      previousStatus: beforeStatus,
      statusChanged,
      preparedCandidateCount: recruiterRoleApplicationPreparedCandidateCount(input.after),
      anonymizeCandidates: input.after.anonymizeCandidates === true,
      adminReviewRecommendation: recruiterRoleApplicationReviewRecommendation(input.after.adminReviewRecommendation),
      adminReviewQualityScore: recruiterRoleApplicationReviewQualityScore(input.after.adminReviewQualityScore),
      hasAdminNote: Boolean(adminNote),
      source: "recruiter_board_admin",
    },
    createdAt: input.createdAt,
  }
}

export async function writeRecruiterRoleApplicationDecisionEvent(
  db: Firestore,
  event: RecruiterRoleApplicationDecisionEvent,
): Promise<{ event: RecruiterRoleApplicationDecisionEvent; created: boolean }> {
  const ref = db.collection(FEEDBACK_EVENTS_COLLECTION).doc(event.eventId)
  const existing = await ref.get()
  if (existing.exists) {
    const data = existing.data() as RecruiterRoleApplicationDecisionEvent
    if (stableJson(data) !== stableJson(event)) {
      throw new Error(`conflicting_duplicate_event:${FEEDBACK_EVENTS_COLLECTION}/${event.eventId}`)
    }
    return { event: data, created: false }
  }
  await ref.set(event as unknown as Record<string, unknown>)
  await db.collection(AUDIT_EVENTS_COLLECTION).doc(auditId("marketplace_feedback", event.eventId)).set({
    id: auditId("marketplace_feedback", event.eventId),
    action: "marketplace.feedback.append",
    eventId: event.eventId,
    candidateId: null,
    jobId: event.jobId,
    actor: event.actor,
    createdAt: event.createdAt,
  })
  return { event, created: true }
}

function recruiterRoleFeedbackDifficulty(raw: unknown): RecruiterRoleFeedbackDifficulty | null {
  return RECRUITER_ROLE_FEEDBACK_DIFFICULTIES.includes(raw as RecruiterRoleFeedbackDifficulty)
    ? raw as RecruiterRoleFeedbackDifficulty
    : null
}

function recruiterRoleFeedbackReasons(raw: unknown): RecruiterRoleFeedbackReason[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<RecruiterRoleFeedbackReason>()
  const reasons: RecruiterRoleFeedbackReason[] = []
  for (const item of raw) {
    if (!RECRUITER_ROLE_FEEDBACK_REASONS.includes(item as RecruiterRoleFeedbackReason)) continue
    const reason = item as RecruiterRoleFeedbackReason
    if (seen.has(reason)) continue
    seen.add(reason)
    reasons.push(reason)
  }
  return reasons
}

function recruiterRoleFeedbackEventId(triggerEventId: string): string {
  const safeEventId = triggerEventId.trim().replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120)
  if (safeEventId) return `recruiter_role_feedback_${safeEventId}`
  return `recruiter_role_feedback_${createHash("sha256").update(triggerEventId).digest("hex").slice(0, 24)}`
}

function recruiterRoleFeedbackSignal(data: Record<string, unknown> | null): {
  jobId: string
  recruiterId: string
  difficulty: RecruiterRoleFeedbackDifficulty
  reasonIds: RecruiterRoleFeedbackReason[]
  hasNote: boolean
} | null {
  if (!data) return null
  const jobId = typeof data.jobId === "string" && data.jobId.trim() ? data.jobId.trim() : ""
  const recruiterId = typeof data.recruiterId === "string" && data.recruiterId.trim() ? data.recruiterId.trim() : ""
  const difficulty = recruiterRoleFeedbackDifficulty(data.difficulty)
  if (!jobId || !recruiterId || !difficulty) return null
  const note = typeof data.note === "string" ? data.note.trim() : ""
  return {
    jobId,
    recruiterId,
    difficulty,
    reasonIds: recruiterRoleFeedbackReasons(data.reasons),
    hasNote: Boolean(note),
  }
}

function recruiterRoleFeedbackSignalChanged(
  before: ReturnType<typeof recruiterRoleFeedbackSignal>,
  after: NonNullable<ReturnType<typeof recruiterRoleFeedbackSignal>>,
): boolean {
  if (!before) return true
  return stableJson(before) !== stableJson(after)
}

export function buildRecruiterRoleFeedbackEvent(input: {
  triggerEventId: string
  feedbackId: string
  createdAt: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}): RecruiterRoleFeedbackEvent | null {
  if (!input.after) return null
  if (!input.triggerEventId || !input.feedbackId) return null
  const after = recruiterRoleFeedbackSignal(input.after)
  if (!after) return null
  const before = recruiterRoleFeedbackSignal(input.before)
  if (!recruiterRoleFeedbackSignalChanged(before, after)) return null

  return {
    eventId: recruiterRoleFeedbackEventId(input.triggerEventId),
    kind: "recruiter_role_feedback",
    actor: "worker",
    jobId: after.jobId,
    outcome: after.difficulty,
    evidence: [{
      source: "system",
      summary: "Recruiter role feedback submitted",
      refId: input.feedbackId,
    }],
    payloadRedacted: {
      feedbackId: input.feedbackId,
      recruiterId: after.recruiterId,
      difficulty: after.difficulty,
      reasonIds: after.reasonIds,
      hasNote: after.hasNote,
      source: "recruiter_board",
    },
    createdAt: input.createdAt,
  }
}

export async function writeRecruiterRoleFeedbackEvent(
  db: Firestore,
  event: RecruiterRoleFeedbackEvent,
): Promise<{ event: RecruiterRoleFeedbackEvent; created: boolean }> {
  const ref = db.collection(FEEDBACK_EVENTS_COLLECTION).doc(event.eventId)
  const existing = await ref.get()
  if (existing.exists) {
    const data = existing.data() as RecruiterRoleFeedbackEvent
    if (stableJson(data) !== stableJson(event)) {
      throw new Error(`conflicting_duplicate_event:${FEEDBACK_EVENTS_COLLECTION}/${event.eventId}`)
    }
    return { event: data, created: false }
  }
  await ref.set(event as unknown as Record<string, unknown>)
  await db.collection(AUDIT_EVENTS_COLLECTION).doc(auditId("marketplace_feedback", event.eventId)).set({
    id: auditId("marketplace_feedback", event.eventId),
    action: "marketplace.feedback.append",
    eventId: event.eventId,
    candidateId: null,
    jobId: event.jobId,
    actor: event.actor,
    createdAt: event.createdAt,
  })
  return { event, created: true }
}

export function buildRecruiterSubmissionFeedbackEvent(input: {
  triggerEventId: string
  submissionId: string
  createdAt: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}): RecruiterSubmissionFeedbackEvent | null {
  if (!input.before || !input.after) return null
  if (!input.triggerEventId || !input.submissionId) return null
  const jobId = typeof input.after.jobId === "string" && input.after.jobId.trim()
    ? input.after.jobId.trim()
    : ""
  const recruiterId = typeof input.after.recruiterId === "string" && input.after.recruiterId.trim()
    ? input.after.recruiterId.trim()
    : ""
  if (!jobId || !recruiterId) return null

  const beforeStatus = recruiterSubmissionFeedbackOutcome(input.before.status)
  const afterStatus = recruiterSubmissionFeedbackOutcome(input.after.status, null)
  if (!beforeStatus || !afterStatus) return null
  const statusChanged = beforeStatus !== afterStatus
  const changedFeedback = recruiterSubmissionFeedbackValueChanged(input.before, input.after)
  if (!statusChanged && !changedFeedback) return null

  const rating = recruiterSubmissionFeedbackRating(input.after.recruiterFeedbackRating)
  const reasons = recruiterSubmissionFeedbackReasons(input.after.recruiterFeedbackReasons)
  const note = typeof input.after.recruiterFeedbackNote === "string" ? input.after.recruiterFeedbackNote.trim() : ""

  return {
    eventId: recruiterSubmissionFeedbackEventId(input.triggerEventId),
    kind: "recruiter_submission_feedback",
    actor: "operator",
    jobId,
    outcome: afterStatus,
    evidence: [{
      source: "admin",
      summary: `Recruiter submission review updated to ${recruiterSubmissionStatusLabel(afterStatus)}`,
      refId: input.submissionId,
    }],
    payloadRedacted: {
      submissionId: input.submissionId,
      recruiterId,
      status: afterStatus,
      previousStatus: beforeStatus,
      statusChanged,
      feedbackChanged: changedFeedback,
      rating,
      reasonIds: reasons,
      hasFeedbackNote: Boolean(note),
      source: "recruiter_board_admin",
    },
    createdAt: input.createdAt,
  }
}

export async function writeRecruiterSubmissionFeedbackEvent(
  db: Firestore,
  event: RecruiterSubmissionFeedbackEvent,
): Promise<{ event: RecruiterSubmissionFeedbackEvent; created: boolean }> {
  const ref = db.collection(FEEDBACK_EVENTS_COLLECTION).doc(event.eventId)
  const existing = await ref.get()
  if (existing.exists) {
    const data = existing.data() as RecruiterSubmissionFeedbackEvent
    if (stableJson(data) !== stableJson(event)) {
      throw new Error(`conflicting_duplicate_event:${FEEDBACK_EVENTS_COLLECTION}/${event.eventId}`)
    }
    return { event: data, created: false }
  }
  await ref.set(event as unknown as Record<string, unknown>)
  await db.collection(AUDIT_EVENTS_COLLECTION).doc(auditId("marketplace_feedback", event.eventId)).set({
    id: auditId("marketplace_feedback", event.eventId),
    action: "marketplace.feedback.append",
    eventId: event.eventId,
    candidateId: null,
    jobId: event.jobId,
    actor: event.actor,
    createdAt: event.createdAt,
  })
  return { event, created: true }
}

function submissionCandidateName(data: Record<string, unknown>): string {
  const candidate = data.candidate && typeof data.candidate === "object"
    ? data.candidate as Record<string, unknown>
    : {}
  return typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : "Candidate"
}

function submissionCandidateEmail(data: Record<string, unknown>): string {
  const confirmation = data.candidateConfirmation && typeof data.candidateConfirmation === "object"
    ? data.candidateConfirmation as Record<string, unknown>
    : {}
  const candidate = data.candidate && typeof data.candidate === "object"
    ? data.candidate as Record<string, unknown>
    : {}
  if (typeof confirmation.candidateEmail === "string" && confirmation.candidateEmail.trim()) {
    return confirmation.candidateEmail.trim()
  }
  if (typeof candidate.email === "string" && candidate.email.trim()) return candidate.email.trim()
  return ""
}

function submissionConfirmationStatus(data: Record<string, unknown> | null): string {
  const confirmation = data?.candidateConfirmation && typeof data.candidateConfirmation === "object"
    ? data.candidateConfirmation as Record<string, unknown>
    : {}
  return typeof confirmation.status === "string" ? confirmation.status.trim() : ""
}

export function candidateConfirmationNotification(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { title: string; body: string } | null {
  if (!before || !after) return null
  const beforeConsent = typeof before.candidateConsentStatus === "string" ? before.candidateConsentStatus : ""
  const afterConsent = typeof after.candidateConsentStatus === "string" ? after.candidateConsentStatus : ""
  const beforeConfirmation = submissionConfirmationStatus(before)
  const afterConfirmation = submissionConfirmationStatus(after)
  if (beforeConsent === afterConsent && beforeConfirmation === afterConfirmation) return null

  const candidateName = submissionCandidateName(after)
  const candidateEmail = submissionCandidateEmail(after)
  const roleTitle = typeof after.jobTitleSnapshot === "string" && after.jobTitleSnapshot.trim()
    ? after.jobTitleSnapshot.trim()
    : "Recruiter submission"
  const confirmation = after.candidateConfirmation && typeof after.candidateConfirmation === "object"
    ? after.candidateConfirmation as Record<string, unknown>
    : {}
  const lastError = typeof confirmation.lastError === "string" ? confirmation.lastError.trim() : ""

  if (afterConsent === "candidate_confirmed" || afterConfirmation === "confirmed") {
    return {
      title: `Candidate confirmed ${candidateName}`,
      body: compactNotificationBody([
        roleTitle,
        candidateEmail || candidateName,
        "Candidate confirmed consent for this recruiter submission.",
      ]),
    }
  }

  if (afterConsent === "confirmation_email_failed" || afterConfirmation === "email_failed") {
    return {
      title: "Candidate confirmation needs attention",
      body: compactNotificationBody([
        roleTitle,
        candidateEmail || candidateName,
        "Confirmation email failed. Resend it from the submission tracker.",
        lastError,
      ]),
    }
  }

  if (afterConsent === "confirmation_email_not_configured" || afterConfirmation === "email_not_configured") {
    return {
      title: "Candidate confirmation email is not configured",
      body: compactNotificationBody([
        roleTitle,
        candidateEmail || candidateName,
        "Configure candidate confirmation email before relying on consent tracking.",
      ]),
    }
  }

  return null
}

function submissionPayout(data: Record<string, unknown> | null): RecruiterSubmissionPayoutPublic {
  const payout = data?.recruiterPayout && typeof data.recruiterPayout === "object"
    ? data.recruiterPayout as Record<string, unknown>
    : {}
  return {
    status: typeof payout.status === "string" ? payout.status.trim() : "",
    amount: typeof payout.amount === "number" && Number.isFinite(payout.amount) && payout.amount > 0
      ? Math.round(payout.amount)
      : undefined,
    currency: typeof payout.currency === "string" && payout.currency.trim()
      ? payout.currency.trim().toUpperCase()
      : "USD",
    note: typeof payout.note === "string" ? payout.note.trim() : "",
  }
}

function payoutStatusLabel(status: string): string {
  switch (status) {
    case "eligible": return "eligible"
    case "pending_start": return "pending start"
    case "invoice_ready": return "invoice ready"
    case "paid": return "paid"
    case "void": return "void"
    default: return status.replace(/_/g, " ")
  }
}

function formatPayoutAmount(amount?: number, currency = "USD"): string {
  if (!amount) return ""
  const formatted = amount.toLocaleString("en-US")
  return currency === "USD" ? `$${formatted}` : `${currency} ${formatted}`
}

export function payoutUpdateNotification(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { title: string; body: string } | null {
  if (!before || !after) return null
  const beforePayout = submissionPayout(before)
  const afterPayout = submissionPayout(after)
  const beforeKey = JSON.stringify({
    status: beforePayout.status || "",
    amount: beforePayout.amount ?? null,
    currency: beforePayout.currency ?? "USD",
    note: beforePayout.note || "",
  })
  const afterKey = JSON.stringify({
    status: afterPayout.status || "",
    amount: afterPayout.amount ?? null,
    currency: afterPayout.currency ?? "USD",
    note: afterPayout.note || "",
  })
  if (beforeKey === afterKey) return null
  if (!afterPayout.status || afterPayout.status === "none") return null

  const candidateName = submissionCandidateName(after)
  const roleTitle = typeof after.jobTitleSnapshot === "string" && after.jobTitleSnapshot.trim()
    ? after.jobTitleSnapshot.trim()
    : "Recruiter submission"
  const amount = formatPayoutAmount(afterPayout.amount, afterPayout.currency)
  const statusLabel = payoutStatusLabel(afterPayout.status)
  return {
    title: `Payout ${statusLabel} for ${candidateName}`,
    body: compactNotificationBody([
      roleTitle,
      amount,
      `Status: ${statusLabel}`,
      afterPayout.note || undefined,
    ]),
  }
}

export const paRecruiterRoleReleasedNotify = onDocumentWritten(
  {
    document: "pa-jobs/{jobId}",
    region: "us-central1",
    memory: RECRUITER_BOARD_MEMORY,
    secrets: MAILGUN_SECRETS,
  },
  async (event) => {
    const before = event.data?.before.exists ? event.data.before.data() as Record<string, unknown> : null
    const after = event.data?.after.exists ? event.data.after.data() as Record<string, unknown> : null
    if (!shouldNotifyRecruitersForRoleRelease(before, after) || !after) return
    const summary = await notifyRecruitersForReleasedRole(getFirestore(), event.params.jobId, after)
    logger.info("paRecruiterRoleReleasedNotify_done", { jobId: event.params.jobId, ...summary })
  },
)

export const paRecruiterRoleFeedbackSignalWrite = onDocumentWritten(
  {
    document: `${RECRUITER_ROLE_FEEDBACK_COLLECTION}/{feedbackId}`,
    region: "us-central1",
    memory: RECRUITER_BOARD_MEMORY,
  },
  async (event) => {
    const before = event.data?.before.exists ? event.data.before.data() as Record<string, unknown> : null
    const after = event.data?.after.exists ? event.data.after.data() as Record<string, unknown> : null
    const feedbackEvent = buildRecruiterRoleFeedbackEvent({
      triggerEventId: event.id,
      feedbackId: event.params.feedbackId,
      createdAt: new Date().toISOString(),
      before,
      after,
    })
    if (!feedbackEvent) return
    const result = await writeRecruiterRoleFeedbackEvent(getFirestore(), feedbackEvent)
    if (result.created) {
      logger.info("paRecruiterRoleFeedbackSignalWrite_done", {
        feedbackId: event.params.feedbackId,
        eventId: feedbackEvent.eventId,
        jobId: feedbackEvent.jobId,
        outcome: feedbackEvent.outcome,
      })
    }
  },
)

export const paRecruiterRoleApplicationDecisionNotify = onDocumentWritten(
  {
    document: `${RECRUITER_ROLE_APPLICATIONS_COLLECTION}/{applicationId}`,
    region: "us-central1",
    memory: RECRUITER_BOARD_MEMORY,
  },
  async (event) => {
    const before = event.data?.before.exists ? event.data.before.data() as Record<string, unknown> : null
    const after = event.data?.after.exists ? event.data.after.data() as Record<string, unknown> : null
    if (!after) return
    const notification = roleApplicationDecisionNotification(before, after)
    const decisionEvent = buildRecruiterRoleApplicationDecisionEvent({
      triggerEventId: event.id,
      applicationId: event.params.applicationId,
      createdAt: new Date().toISOString(),
      before,
      after,
    })
    if (!notification && !decisionEvent) return
    const recruiterId = typeof after.recruiterId === "string" ? after.recruiterId : ""
    if (!recruiterId) return
    const db = getFirestore()
    if (decisionEvent) {
      const result = await writeRecruiterRoleApplicationDecisionEvent(db, decisionEvent)
      if (result.created) {
        logger.info("paRecruiterRoleApplicationDecisionEvent_done", {
          applicationId: event.params.applicationId,
          eventId: decisionEvent.eventId,
          jobId: decisionEvent.jobId,
          outcome: decisionEvent.outcome,
          recruiterId,
        })
      }
    }
    if (notification) {
      const created = await createRecruiterInAppNotification(db, {
        type: "role_application_decision",
        eventId: event.id,
        recruiterId,
        recruiterEmail: typeof after.recruiterEmail === "string" ? after.recruiterEmail : undefined,
        entityType: "role_application",
        entityId: event.params.applicationId,
        title: notification.title,
        body: notification.body,
        jobId: typeof after.jobId === "string" ? after.jobId : undefined,
        publicJobId: typeof after.inboundJobId === "string" ? after.inboundJobId : undefined,
        roleTitle: typeof after.jobTitleSnapshot === "string" ? after.jobTitleSnapshot : undefined,
        companyLabel: typeof after.companyLabelSnapshot === "string" ? after.companyLabelSnapshot : undefined,
        roleUrl: recruiterNotificationRoleUrl(after),
      })
      if (created) logger.info("paRecruiterRoleApplicationDecisionNotify_done", { applicationId: event.params.applicationId, recruiterId })
    }
  },
)

export const paRecruiterCandidateCalibrationNotify = onDocumentWritten(
  {
    document: `${RECRUITER_SOURCED_CANDIDATES_COLLECTION}/{candidateId}`,
    region: "us-central1",
    memory: RECRUITER_BOARD_MEMORY,
  },
  async (event) => {
    const before = event.data?.before.exists ? event.data.before.data() as Record<string, unknown> : null
    const after = event.data?.after.exists ? event.data.after.data() as Record<string, unknown> : null
    const notification = candidateCalibrationNotification(before, after)
    if (!notification || !after) return
    const recruiterId = typeof after.recruiterId === "string" ? after.recruiterId : ""
    if (!recruiterId) return
    const created = await createRecruiterInAppNotification(getFirestore(), {
      type: "candidate_calibration",
      eventId: event.id,
      recruiterId,
      recruiterEmail: typeof after.recruiterEmail === "string" ? after.recruiterEmail : undefined,
      entityType: "sourced_candidate",
      entityId: event.params.candidateId,
      title: notification.title,
      body: notification.body,
      jobId: typeof after.jobId === "string" ? after.jobId : undefined,
      publicJobId: typeof after.inboundJobId === "string" ? after.inboundJobId : undefined,
      roleTitle: typeof after.jobTitleSnapshot === "string" ? after.jobTitleSnapshot : undefined,
      companyLabel: typeof after.companyLabelSnapshot === "string" ? after.companyLabelSnapshot : undefined,
      roleUrl: recruiterNotificationRoleUrl(after),
    })
    if (created) logger.info("paRecruiterCandidateCalibrationNotify_done", { candidateId: event.params.candidateId, recruiterId })
  },
)

export const paRecruiterRoleQuestionAnswerNotify = onDocumentWritten(
  {
    document: `${RECRUITER_ROLE_QUESTIONS_COLLECTION}/{questionId}`,
    region: "us-central1",
    memory: RECRUITER_BOARD_MEMORY,
  },
  async (event) => {
    const before = event.data?.before.exists ? event.data.before.data() as Record<string, unknown> : null
    const after = event.data?.after.exists ? event.data.after.data() as Record<string, unknown> : null
    const notification = roleQuestionAnswerNotification(before, after)
    if (!notification || !after) return
    const recruiterId = typeof after.recruiterId === "string" ? after.recruiterId : ""
    if (!recruiterId) return
    const created = await createRecruiterInAppNotification(getFirestore(), {
      type: "role_question_answer",
      eventId: event.id,
      recruiterId,
      recruiterEmail: typeof after.recruiterEmail === "string" ? after.recruiterEmail : undefined,
      entityType: "role_question",
      entityId: event.params.questionId,
      title: notification.title,
      body: notification.body,
      jobId: typeof after.jobId === "string" ? after.jobId : undefined,
      publicJobId: typeof after.inboundJobId === "string" ? after.inboundJobId : undefined,
      roleTitle: typeof after.jobTitleSnapshot === "string" ? after.jobTitleSnapshot : undefined,
      companyLabel: typeof after.companyLabelSnapshot === "string" ? after.companyLabelSnapshot : undefined,
      roleUrl: recruiterNotificationRoleUrl(after),
    })
    if (created) logger.info("paRecruiterRoleQuestionAnswerNotify_done", { questionId: event.params.questionId, recruiterId })
  },
)

export const paRecruiterSubmissionFeedbackNotify = onDocumentWritten(
  {
    document: `${RECRUITER_SUBMISSIONS_COLLECTION}/{submissionId}`,
    region: "us-central1",
    memory: RECRUITER_BOARD_MEMORY,
    secrets: MAILGUN_SECRETS,
  },
  async (event) => {
    const before = event.data?.before.exists ? event.data.before.data() as Record<string, unknown> : null
    const after = event.data?.after.exists ? event.data.after.data() as Record<string, unknown> : null
    const feedbackNotification = submissionFeedbackNotification(before, after)
    const feedbackEvent = buildRecruiterSubmissionFeedbackEvent({
      triggerEventId: event.id,
      submissionId: event.params.submissionId,
      createdAt: event.time ?? new Date().toISOString(),
      before,
      after,
    })
    const confirmationNotification = candidateConfirmationNotification(before, after)
    const payoutNotification = payoutUpdateNotification(before, after)
    const requestedInfoNotification = submissionRequestedInfoNotification(before, after)
    // Guard for aiEvaluation-only merges (pa-orchestrator eval trigger): when
    // status is unchanged, no requestedInfo entry was appended, and no
    // feedback/confirmation/payout field moved, every helper above is null
    // and we exit without emailing.
    if ((!feedbackNotification && !feedbackEvent && !confirmationNotification && !payoutNotification && !requestedInfoNotification) || !after) return
    const recruiterId = typeof after.recruiterId === "string" ? after.recruiterId : ""
    if (!recruiterId) return
    const db = getFirestore()
    // Email opt-out lives on the recruiter profile (`pa-recruiter-users` is
    // keyed by the same uid stored as `recruiterId` on the submission).
    // Absent profile/preference defaults to emails ON; the in-app
    // notification doc is written either way.
    let emailOptedOut = false
    try {
      const profileSnap = await db.collection(RECRUITER_USERS_COLLECTION).doc(recruiterId).get()
      const profile = profileSnap.exists ? profileSnap.data() as Record<string, unknown> : null
      emailOptedOut = !recruiterSubmissionUpdateEmailsEnabled(profile)
    } catch (err) {
      logger.error("paRecruiterSubmissionFeedbackNotify_profile_lookup_failed", {
        error: String(err),
        submissionId: event.params.submissionId,
        recruiterId,
      })
    }
    if (feedbackEvent) {
      const result = await writeRecruiterSubmissionFeedbackEvent(db, feedbackEvent)
      if (result.created) {
        logger.info("paRecruiterSubmissionFeedbackEvent_done", {
          submissionId: event.params.submissionId,
          recruiterId,
          eventId: feedbackEvent.eventId,
          outcome: feedbackEvent.outcome,
        })
      }
    }
    const common = {
      eventId: event.id,
      recruiterId,
      recruiterEmail: typeof after.recruiterEmail === "string" ? after.recruiterEmail : undefined,
      entityType: "submission" as const,
      entityId: event.params.submissionId,
      jobId: typeof after.jobId === "string" ? after.jobId : undefined,
      publicJobId: typeof after.inboundJobId === "string" ? after.inboundJobId : undefined,
      roleTitle: typeof after.jobTitleSnapshot === "string" ? after.jobTitleSnapshot : undefined,
      companyLabel: typeof after.companyLabelSnapshot === "string" ? after.companyLabelSnapshot : undefined,
      roleUrl: recruiterNotificationRoleUrl(after),
    }
    if (feedbackNotification) {
      const type = "submission_feedback"
      const created = await createRecruiterInAppNotification(db, {
        ...common,
        type,
        title: feedbackNotification.title,
        body: feedbackNotification.body,
      })
      if (created) {
        const emailStatus = await sendRecruiterSubmissionUpdateEmail(db, eventNotificationId(type, event.params.submissionId, event.id), {
          to: common.recruiterEmail,
          emailOptedOut,
          title: feedbackNotification.title,
          body: feedbackNotification.body,
          roleTitle: common.roleTitle,
          companyLabel: common.companyLabel,
          actionUrl: common.roleUrl ?? `${RECRUITER_PUBLIC_BASE_URL}/recruiters?tab=submissions`,
        })
        logger.info("paRecruiterSubmissionFeedbackNotify_done", {
          submissionId: event.params.submissionId,
          recruiterId,
          emailStatus,
        })
      }
    }
    if (requestedInfoNotification) {
      const type = "requested_info"
      const created = await createRecruiterInAppNotification(db, {
        ...common,
        type,
        title: requestedInfoNotification.title,
        body: requestedInfoNotification.body,
      })
      if (created) {
        const emailStatus = await sendRecruiterSubmissionUpdateEmail(db, eventNotificationId(type, event.params.submissionId, event.id), {
          to: common.recruiterEmail,
          emailOptedOut,
          title: requestedInfoNotification.title,
          body: requestedInfoNotification.body,
          roleTitle: common.roleTitle,
          companyLabel: common.companyLabel,
          actionUrl: common.roleUrl ?? `${RECRUITER_PUBLIC_BASE_URL}/recruiters?tab=submissions`,
        })
        logger.info("paRecruiterSubmissionRequestedInfoNotify_done", {
          submissionId: event.params.submissionId,
          recruiterId,
          emailStatus,
        })
      }
    }
    if (confirmationNotification) {
      const type = "candidate_confirmation"
      const created = await createRecruiterInAppNotification(db, {
        ...common,
        type,
        title: confirmationNotification.title,
        body: confirmationNotification.body,
      })
      if (created) {
        const emailStatus = await sendRecruiterSubmissionUpdateEmail(db, eventNotificationId(type, event.params.submissionId, event.id), {
          to: common.recruiterEmail,
          emailOptedOut,
          title: confirmationNotification.title,
          body: confirmationNotification.body,
          roleTitle: common.roleTitle,
          companyLabel: common.companyLabel,
          actionUrl: common.roleUrl ?? `${RECRUITER_PUBLIC_BASE_URL}/recruiters?tab=submissions`,
        })
        logger.info("paRecruiterSubmissionCandidateConfirmationNotify_done", {
          submissionId: event.params.submissionId,
          recruiterId,
          emailStatus,
        })
      }
    }
    if (payoutNotification) {
      const type = "payout_update"
      const created = await createRecruiterInAppNotification(db, {
        ...common,
        type,
        title: payoutNotification.title,
        body: payoutNotification.body,
      })
      if (created) {
        const emailStatus = await sendRecruiterSubmissionUpdateEmail(db, eventNotificationId(type, event.params.submissionId, event.id), {
          to: common.recruiterEmail,
          emailOptedOut,
          title: payoutNotification.title,
          body: payoutNotification.body,
          roleTitle: common.roleTitle,
          companyLabel: common.companyLabel,
          actionUrl: common.roleUrl ?? `${RECRUITER_PUBLIC_BASE_URL}/recruiters?tab=submissions`,
        })
        logger.info("paRecruiterSubmissionPayoutNotify_done", {
          submissionId: event.params.submissionId,
          recruiterId,
          emailStatus,
        })
      }
    }
  },
)

/**
 * Builds the recruiter-inbox notification for one submission thread comment.
 * WeKruit replies are emailable (subject kept verbatim by
 * `composeRecruiterSubmissionUpdateEmail` because it starts with "WeKruit");
 * the recruiter's own comments produce an in-app doc only.
 */
export function submissionCommentNotification(
  comment: Record<string, unknown> | null,
  submission: Record<string, unknown> | null,
): { title: string; body: string; emailable: boolean } | null {
  if (!comment || !submission) return null
  const by = comment.by === "wekruit" || comment.by === "recruiter" ? comment.by : null
  const message = typeof comment.message === "string" ? comment.message.trim() : ""
  if (!by || !message) return null
  const candidateName = submissionCandidateName(submission)
  const body = compactNotificationBody([
    typeof submission.jobTitleSnapshot === "string" ? submission.jobTitleSnapshot : "",
    message,
  ])
  return {
    title: by === "wekruit" ? `WeKruit replied on ${candidateName}` : `New comment on ${candidateName}`,
    body,
    emailable: by === "wekruit",
  }
}

/**
 * Trigger body for `paRecruiterSubmissionCommentNotify`, extracted so unit
 * tests can drive it with a fake Firestore. `by === "wekruit"` → in-app
 * notification + submission-update email (respecting the
 * `submissionUpdatesEmail` opt-out); `by === "recruiter"` → in-app
 * notification only, never an email.
 */
export async function deliverRecruiterSubmissionCommentNotification(
  db: Firestore,
  input: {
    triggerEventId: string
    submissionId: string
    comment: Record<string, unknown> | null
  },
): Promise<{ notified: boolean; emailStatus: "sent" | "failed" | "not_configured" | "skipped" | "not_emailed" }> {
  const submissionSnap = await db.collection(RECRUITER_SUBMISSIONS_COLLECTION).doc(input.submissionId).get()
  if (!submissionSnap.exists) return { notified: false, emailStatus: "not_emailed" }
  const submission = (submissionSnap.data() ?? {}) as Record<string, unknown>
  const recruiterId = typeof submission.recruiterId === "string" ? submission.recruiterId : ""
  const notification = submissionCommentNotification(input.comment, submission)
  if (!notification || !recruiterId) return { notified: false, emailStatus: "not_emailed" }

  const type = "submission_comment" as const
  const recruiterEmail = typeof submission.recruiterEmail === "string" ? submission.recruiterEmail : undefined
  const roleUrl = recruiterNotificationRoleUrl(submission)
  const created = await createRecruiterInAppNotification(db, {
    type,
    eventId: input.triggerEventId,
    recruiterId,
    recruiterEmail,
    entityType: "submission",
    entityId: input.submissionId,
    title: notification.title,
    body: notification.body,
    jobId: typeof submission.jobId === "string" ? submission.jobId : undefined,
    publicJobId: typeof submission.inboundJobId === "string" ? submission.inboundJobId : undefined,
    roleTitle: typeof submission.jobTitleSnapshot === "string" ? submission.jobTitleSnapshot : undefined,
    companyLabel: typeof submission.companyLabelSnapshot === "string" ? submission.companyLabelSnapshot : undefined,
    roleUrl,
  })
  // `created === false` means an idempotent replay of the same trigger event —
  // never double-email on retries.
  if (!notification.emailable || !created) return { notified: created, emailStatus: "not_emailed" }

  let emailOptedOut = false
  try {
    const profileSnap = await db.collection(RECRUITER_USERS_COLLECTION).doc(recruiterId).get()
    const profile = profileSnap.exists ? profileSnap.data() as Record<string, unknown> : null
    emailOptedOut = !recruiterSubmissionUpdateEmailsEnabled(profile)
  } catch (err) {
    logger.error("paRecruiterSubmissionCommentNotify_profile_lookup_failed", {
      error: String(err),
      submissionId: input.submissionId,
      recruiterId,
    })
  }
  const emailStatus = await sendRecruiterSubmissionUpdateEmail(
    db,
    eventNotificationId(type, input.submissionId, input.triggerEventId),
    {
      to: recruiterEmail,
      emailOptedOut,
      title: notification.title,
      body: notification.body,
      roleTitle: typeof submission.jobTitleSnapshot === "string" ? submission.jobTitleSnapshot : undefined,
      companyLabel: typeof submission.companyLabelSnapshot === "string" ? submission.companyLabelSnapshot : undefined,
      actionUrl: roleUrl ?? `${RECRUITER_PUBLIC_BASE_URL}/recruiters?tab=submissions`,
    },
  )
  return { notified: true, emailStatus }
}

export const paRecruiterSubmissionCommentNotify = onDocumentCreated(
  {
    document: `${RECRUITER_SUBMISSIONS_COLLECTION}/{submissionId}/${RECRUITER_SUBMISSION_COMMENTS_SUBCOLLECTION}/{commentId}`,
    region: "us-central1",
    memory: RECRUITER_BOARD_MEMORY,
    secrets: MAILGUN_SECRETS,
  },
  async (event) => {
    const comment = event.data?.exists ? event.data.data() as Record<string, unknown> : null
    if (!comment) return
    const result = await deliverRecruiterSubmissionCommentNotification(getFirestore(), {
      triggerEventId: event.id,
      submissionId: event.params.submissionId,
      comment,
    })
    if (result.notified) {
      logger.info("paRecruiterSubmissionCommentNotify_done", {
        submissionId: event.params.submissionId,
        commentId: event.params.commentId,
        by: comment.by,
        emailStatus: result.emailStatus,
      })
    }
  },
)

export const paRecruiterCandidateIdentityCheck = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const db = getFirestore()
    const recruiter = await authenticateRecruiter(db, req)
    if (!recruiter) {
      res.status(401).json({ ok: false, reason: "recruiter_access_required" })
      return
    }
    const validated = validateRecruiterCandidateIdentityCheckInput(req.body)
    if (!validated.ok) {
      res.status(400).json({ ok: false, reason: validated.reason })
      return
    }

    try {
      const payload = validated.value
      const realJobId = await resolvePublicIdToDocId(db, payload.jobId)
      if (!realJobId) {
        res.status(404).json({ ok: false, reason: "job_not_found" })
        return
      }
      const jobSnap = await db.collection("pa-jobs").doc(realJobId).get()
      if (!jobSnap.exists) {
        res.status(404).json({ ok: false, reason: "job_not_found" })
        return
      }
      const jobData = jobSnap.data() as Record<string, unknown>
      const rb = (jobData.recruiterBoard as RecruiterBoardPayload | undefined) ?? null
      if (jobData.wekruitCollaborationStatus !== "collaborated" || !rb || rb.active !== true) {
        res.status(403).json({ ok: false, reason: "job_not_active_on_board" })
        return
      }
      const candidateLinkKey = hashRecruiterCandidateLink(payload.candidate.link)
      const candidateEmailKey = payload.candidate.email
        ? hashRecruiterCandidateEmail(payload.candidate.email)
        : null
      const conflict = await findRecruiterCandidateIdentityConflict(db, {
        realJobId,
        recruiterId: recruiter.recruiterId,
        candidateLinkKey,
        candidateEmailKey,
      })
      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({
        ok: true,
        conflict: conflict
          ? {
              reason: conflict.reason,
              docId: conflict.docId,
            }
          : null,
      })
    } catch (err) {
      logger.error("paRecruiterCandidateIdentityCheck_failed", { error: String(err), recruiterId: recruiter.recruiterId })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

export const paRecruiterSubmission = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY, secrets: MAILGUN_SECRETS, invoker: "public" },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }

    // Idempotency-Key (optional). When provided, we use it as the Firestore
    // doc id so retries of the same logical submission deduplicate. The
    // existing doc is returned with 200 (the caller gets the same
    // `submissionId` + `score` as the original write). Header is validated
    // with a Stripe-style allowlist to keep doc-ids safe.
    const idempotencyHeader = (req.get("idempotency-key") ?? "").trim()
    if (idempotencyHeader && !IDEMPOTENCY_KEY_RE.test(idempotencyHeader)) {
      res.status(400).json({ ok: false, reason: "invalid_idempotency_key" })
      return
    }

    const validated = validateSubmission(req.body)
    if (!validated.ok) {
      res.status(400).json({ ok: false, reason: validated.reason })
      return
    }
    const payload = validated.value

    const db = getFirestore()
    const recruiter = await authenticateRecruiter(db, req)
    if (payload.source === "hiring-board" && !recruiter) {
      res.status(401).json({ ok: false, reason: "recruiter_access_required" })
      return
    }

    // Fast path: idempotent replay returns the existing doc without
    // re-resolving the job or re-scoring the checklist.
    if (idempotencyHeader) {
      const existing = await db
        .collection("pa-recruiter-submissions")
        .doc(idempotencyHeader)
        .get()
      if (existing.exists) {
        const existingData = existing.data() as { score?: SubmissionScore; sourcedCandidateId?: string } | undefined
        res.status(200).json({
          ok: true,
          submissionId: idempotencyHeader,
          score: existingData?.score ?? null,
          ...(existingData?.sourcedCandidateId ? { sourcedCandidateId: existingData.sourcedCandidateId } : {}),
          idempotent: true,
        })
        return
      }
    }

    // Frontend may send either the real Firestore doc id (admin path) or
    // an opaque `publicId` UUID (anonymous hiring-board path). Resolve to
    // the real doc id so every downstream reference is consistent.
    const realJobId = await resolvePublicIdToDocId(db, payload.jobId)
    if (!realJobId) {
      res.status(404).json({ ok: false, reason: "job_not_found" })
      return
    }
    const jobRef = db.collection("pa-jobs").doc(realJobId)
    const jobSnap = await jobRef.get()
    if (!jobSnap.exists) {
      res.status(404).json({ ok: false, reason: "job_not_found" })
      return
    }
    const jobData = jobSnap.data() as Record<string, unknown>
    if (jobData.wekruitCollaborationStatus !== "collaborated") {
      res.status(403).json({ ok: false, reason: "job_not_collab" })
      return
    }
    const rb = jobData.recruiterBoard as RecruiterBoardPayload | undefined
    if (!rb || rb.active !== true) {
      res.status(403).json({ ok: false, reason: "job_not_active_on_board" })
      return
    }
    const extraFieldsResult = resolveSubmissionExtraFields(
      sanitizeRecruiterSubmitFields(rb.submitFields),
      payload.extraFields,
    )
    if (!extraFieldsResult.ok) {
      res.status(400).json({ ok: false, reason: extraFieldsResult.reason })
      return
    }
    const approvedForRole = await recruiterApprovedForRole(db, recruiter, payload.jobId, realJobId)
    const submissionMode = approvedForRole
      ? "primary_role"
      : "single_submission"
    if (recruiter && submissionMode === "single_submission") {
      const weekStartMs = Date.now() - 7 * 86_400_000
      const recentSingles = await recentSingleSubmissionCount(db, recruiter, weekStartMs)
      if (recentSingles >= RECRUITER_SINGLE_SUBMISSION_WEEKLY_LIMIT) {
        res.status(403).json({ ok: false, reason: "single_submission_limit_reached" })
        return
      }
    }

    let sourcedCandidateRef: DocumentReference | null = null
    if (payload.sourcedCandidateId) {
      if (!recruiter) {
        res.status(401).json({ ok: false, reason: "recruiter_access_required" })
        return
      }
      const sourcedSnap = await db
        .collection(RECRUITER_SOURCED_CANDIDATES_COLLECTION)
        .doc(payload.sourcedCandidateId)
        .get()
      if (!sourcedSnap.exists) {
        res.status(404).json({ ok: false, reason: "sourced_candidate_not_found" })
        return
      }
      const sourcedData = sourcedSnap.data() as Record<string, unknown>
      if (sourcedData.recruiterId !== recruiter.recruiterId) {
        res.status(403).json({ ok: false, reason: "sourced_candidate_forbidden" })
        return
      }
      const sourcedJobId = typeof sourcedData.jobId === "string" ? sourcedData.jobId : ""
      const sourcedInboundJobId = typeof sourcedData.inboundJobId === "string" ? sourcedData.inboundJobId : ""
      const sourcedAlreadyAssigned = Boolean(sourcedJobId || sourcedInboundJobId)
      if (
        sourcedAlreadyAssigned &&
        sourcedJobId !== realJobId &&
        sourcedInboundJobId !== payload.jobId
      ) {
        res.status(409).json({ ok: false, reason: "sourced_candidate_role_mismatch" })
        return
      }
      if (sourcedData.stage === "archived") {
        res.status(409).json({ ok: false, reason: "sourced_candidate_archived" })
        return
      }
      sourcedCandidateRef = sourcedSnap.ref
    }

    const candidateLinkKey = hashRecruiterCandidateLink(payload.candidate.link)
    const candidateEmailKey = payload.candidate.email
      ? hashRecruiterCandidateEmail(payload.candidate.email)
      : null
    const candidateConflict = await findRecruiterCandidateIdentityConflict(db, {
      realJobId,
      recruiterId: recruiter?.recruiterId ?? null,
      candidateLinkKey,
      candidateEmailKey,
    })
    if (candidateConflict) {
      res.status(409).json({ ok: false, reason: candidateConflict.reason })
      return
    }

    const score = computeSubmissionScore(rb.checklist.groups, payload.checklist)

    const submissionId = idempotencyHeader || randomUUID()
    // No candidate consent step: a candidate submitted on the recruiter platform
    // is, by default, consented (the recruiter attests it). WeKruit never emails
    // the candidate directly — we only email recruiters. So consent is always
    // recruiter-asserted and there is no candidate confirmation to queue/send.
    const candidateConsentStatus = "recruiter_asserted"
    const finalCandidateConsentStatus = candidateConsentStatus
    const candidateConfirmation = null
    const ip = req.get("x-forwarded-for")?.split(",")[0]?.trim() || ""
    const callerSource = payload.source ?? "unknown"
    const submitter = recruiter
      ? {
          name: payload.submitter.name || recruiter.name,
          email: recruiter.email,
        }
      : payload.submitter
    const submissionDoc = {
      submissionId,
      // Canonical Firestore doc id (what admin tooling expects). When the
      // caller used the public/anonymized id, `inboundJobId` preserves the
      // original lineage for audit.
      jobId: realJobId,
      inboundJobId: payload.jobId,
      jobTitleSnapshot: String(jobData.title ?? ""),
      companyLabelSnapshot: rb.label.company,
      submitter,
      recruiterId: recruiter?.recruiterId ?? null,
      recruiterEmail: recruiter?.email ?? payload.submitter.email,
      ...(payload.sourcedCandidateId ? { sourcedCandidateId: payload.sourcedCandidateId } : {}),
      candidate: payload.candidate,
      candidateLinkKey,
      ...(candidateEmailKey ? { candidateEmailKey } : {}),
      candidateConsent: payload.candidateConsent,
      candidateConsentStatus,
      ...(candidateConfirmation ? { candidateConfirmation } : {}),
      ...(payload.candidateBackground ? { candidateBackground: payload.candidateBackground } : {}),
      checklist: payload.checklist,
      ...(extraFieldsResult.value ? { extraFields: extraFieldsResult.value } : {}),
      score,
      submissionMode,
      // Caller-supplied audit surface. Tracks which UI (hiring-board, api,
      // unknown) produced the submission so downstream filtering works.
      callerSource,
      idempotencyKey: idempotencyHeader || null,
      source: {
        userAgent: req.get("user-agent") ?? "",
        referrer: req.get("referer") ?? "",
        ipHash: ip ? createHash("sha256").update(ip).digest("hex").slice(0, 16) : "",
      },
      status: "submitted",
      statusHistory: [{
        status: "submitted",
        by: "recruiter",
        atIso: new Date().toISOString(),
      }],
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }

    const sourcedCandidateSubmittedPatch = sourcedCandidateRef
      ? {
          stage: "submitted",
          jobId: realJobId,
          inboundJobId: payload.jobId,
          jobTitleSnapshot: String(jobData.title ?? ""),
          companyLabelSnapshot: rb.label.company,
          candidateScope: "role",
          linkedSubmissionId: submissionId,
          submittedAt: FieldValue.serverTimestamp(),
          candidate: payload.candidate,
          updatedAt: FieldValue.serverTimestamp(),
          stageHistory: FieldValue.arrayUnion({
            stage: "submitted",
            submissionId,
            by: "recruiter",
            recruiterEmail: recruiter?.email ?? submitter.email,
            atIso: new Date().toISOString(),
          }),
        }
      : null

    try {
      const submissionRef = db.collection(RECRUITER_SUBMISSIONS_COLLECTION).doc(submissionId)
      if (idempotencyHeader) {
        // `create()` fails when the doc already exists. Combined with the
        // pre-check above, this protects against a narrow race where two
        // concurrent retries of the same key both miss the existence check.
        try {
          if (sourcedCandidateRef && sourcedCandidateSubmittedPatch) {
            const batch = db.batch()
            batch.create(submissionRef, submissionDoc)
            batch.set(sourcedCandidateRef, sourcedCandidateSubmittedPatch, { merge: true })
            await batch.commit()
          } else {
            await submissionRef.create(submissionDoc)
          }
        } catch (createErr) {
          const message = String(createErr)
          if (message.includes("ALREADY_EXISTS") || message.includes("already exists")) {
            const existing = await db
              .collection("pa-recruiter-submissions")
              .doc(submissionId)
              .get()
            const existingData = existing.data() as { score?: SubmissionScore; sourcedCandidateId?: string } | undefined
            res.status(200).json({
              ok: true,
              submissionId,
              score: existingData?.score ?? null,
              ...(existingData?.sourcedCandidateId ? { sourcedCandidateId: existingData.sourcedCandidateId } : {}),
              idempotent: true,
            })
            return
          }
          throw createErr
        }
      } else {
        if (sourcedCandidateRef && sourcedCandidateSubmittedPatch) {
          const batch = db.batch()
          batch.set(submissionRef, submissionDoc)
          batch.set(sourcedCandidateRef, sourcedCandidateSubmittedPatch, { merge: true })
          await batch.commit()
        } else {
          await submissionRef.set(submissionDoc)
        }
      }
    } catch (err) {
      logger.error("paRecruiterSubmission_write_failed", { error: String(err), submissionId })
      res.status(500).json({ ok: false, reason: "write_failed" })
      return
    }

    logger.info("paRecruiterSubmission_received", {
      submissionId,
      jobId: realJobId,
      submitterEmail: submitter.email,
      hardScore: `${score.hardChecked}/${score.hardTotal}`,
      callerSource,
      recruiterId: recruiter?.recruiterId ?? null,
      idempotent: false,
      submissionMode,
    })

    // (Candidate consent confirmation removed — no email is ever sent to the
    // candidate. Consent is recruiter-asserted at submit time.)

    // Best-effort Sheet sync. Failure does not block the 200 — the Firestore
    // write is the source of truth and the doc keeps an error breadcrumb so
    // a retry job can pick it up later.
    const sheetId = (process.env[RECRUITER_BOARD_SHEET_ID_ENV] ?? "").trim()
    if (sheetId) {
      const sheetResult = await appendSubmissionToSheet(sheetId, {
        submissionId,
        jobId: realJobId,
        companyLabel: rb.label.company,
        submitter,
        candidate: payload.candidate,
        checklist: payload.checklist,
        score,
        jobChecklistGroups: rb.checklist.groups,
        jobTitle: String(jobData.title ?? ""),
      })
      try {
        if (sheetResult.ok) {
          await db.collection("pa-recruiter-submissions").doc(submissionId).update({
            sheetSyncedAt: FieldValue.serverTimestamp(),
            sheetRowId: sheetResult.rowId,
          })
        } else {
          await db.collection("pa-recruiter-submissions").doc(submissionId).update({
            sheetSyncError: sheetResult.reason.slice(0, 500),
          })
        }
      } catch (err) {
        logger.error("paRecruiterSubmission_sheet_update_failed", {
          error: String(err),
          submissionId,
        })
      }
    }

    res.status(200).json({
      ok: true,
      submissionId,
      score,
      submissionMode,
      candidateConsentStatus: finalCandidateConsentStatus,
      ...(payload.sourcedCandidateId ? { sourcedCandidateId: payload.sourcedCandidateId } : {}),
    })
  },
)

// ============================================================================
// Recruiter digests — admin-triggered, MANUAL send. WeKruit emails RECRUITERS
// only. Nothing here runs on a schedule: the admin dashboard previews each
// recruiter's draft and presses send (one or all). A pa-recruiter-digest-sends
// log powers a "last sent N days ago" nudge so the admin decides cadence
// (target ~3 days) — there is no auto-send.
// ============================================================================
const RECRUITER_DIGEST_SENDS_COLLECTION = "pa-recruiter-digest-sends"
const RECRUITER_DIGEST_WINDOW_DAYS = 3

type RecruiterDigestPreviewItem = {
  digest: RecruiterDigest
  lastSentAt: string | null
  lastSentBy: string | null
  daysSinceSent: number | null
}

async function buildAllRecruiterDigests(
  db: Firestore,
  nowMs: number,
  windowDays = RECRUITER_DIGEST_WINDOW_DAYS,
): Promise<RecruiterDigestPreviewItem[]> {
  const [recSnap, subSnap, jobSnap, sendSnap] = await Promise.all([
    db.collection(RECRUITER_USERS_COLLECTION).get(),
    db.collection(RECRUITER_SUBMISSIONS_COLLECTION).get(),
    // Collab subset only — never scan the full pa-jobs catalog.
    db.collection("pa-jobs").where("wekruitCollaborationStatus", "==", "collaborated").get(),
    db.collection(RECRUITER_DIGEST_SENDS_COLLECTION).get(),
  ])

  const subsByRecruiter = new Map<string, RawSubmission[]>()
  for (const doc of subSnap.docs) {
    const s = doc.data() as RawSubmission
    if (!s.recruiterId) continue
    const list = subsByRecruiter.get(s.recruiterId)
    if (list) list.push(s)
    else subsByRecruiter.set(s.recruiterId, [s])
  }

  const jobs: RawJob[] = jobSnap.docs
    .map((d) => ({ id: d.id, ...(d.data() as object) }) as RawJob)
    .filter((j) => j.recruiterBoard)
  const { newRoles, priorityRoles } = selectRoles(jobs, nowMs)

  const lastSent = new Map<string, { at: number; by: string | null }>()
  for (const doc of sendSnap.docs) {
    const x = doc.data() as { recruiterId?: string; sentAt?: unknown; sentByEmail?: string }
    if (!x.recruiterId) continue
    const at = digestToMs(x.sentAt)
    const prev = lastSent.get(x.recruiterId)
    if (!prev || at > prev.at) lastSent.set(x.recruiterId, { at, by: x.sentByEmail ?? null })
  }

  const items: RecruiterDigestPreviewItem[] = []
  for (const doc of recSnap.docs) {
    const prof = doc.data() as { name?: string; email?: string; status?: string }
    if (prof.status === "blocked" || prof.status === "removed") continue
    const digest = computeRecruiterDigest({
      recruiter: { recruiterId: doc.id, name: prof.name, email: prof.email },
      submissions: subsByRecruiter.get(doc.id) ?? [],
      newRoles,
      priorityRoles,
      nowMs,
      windowDays,
    })
    const ls = lastSent.get(doc.id)
    items.push({
      digest,
      lastSentAt: ls?.at ? new Date(ls.at).toISOString() : null,
      lastSentBy: ls?.by ?? null,
      daysSinceSent: ls?.at ? Math.floor((nowMs - ls.at) / 86_400_000) : null,
    })
  }

  // Most worth sending first: never-sent / most-overdue, then most-active.
  return items.sort((a, b) => {
    const aOver = a.daysSinceSent === null ? Number.MAX_SAFE_INTEGER : a.daysSinceSent
    const bOver = b.daysSinceSent === null ? Number.MAX_SAFE_INTEGER : b.daysSinceSent
    if (aOver !== bOver) return bOver - aOver
    return b.digest.stats.newSubmitted - a.digest.stats.newSubmitted
  })
}

export const paRecruiterDigestPreview = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY, secrets: [PA_ADMIN_TOKEN_SECRET] },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") { res.status(204).send(""); return }
    if (req.method !== "GET") { res.status(405).json({ ok: false, reason: "method_not_allowed" }); return }
    const admin = await hiringBoardAdminEmail(req)
    if (!admin) { res.status(403).json({ ok: false, reason: "forbidden" }); return }
    try {
      const items = await buildAllRecruiterDigests(getFirestore(), Date.now())
      res.set("Cache-Control", "private, max-age=0, no-store")
      res.status(200).json({ ok: true, windowDays: RECRUITER_DIGEST_WINDOW_DAYS, recruiters: items })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error("recruiter_digest_preview_failed", { error: message })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

export const paRecruiterDigestSend = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY, secrets: [...MAILGUN_SECRETS, PA_ADMIN_TOKEN_SECRET] },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") { res.status(204).send(""); return }
    if (req.method !== "POST") { res.status(405).json({ ok: false, reason: "method_not_allowed" }); return }
    const admin = await hiringBoardAdminEmail(req)
    if (!admin) { res.status(403).json({ ok: false, reason: "forbidden" }); return }

    const body = (req.body ?? {}) as { recruiterIds?: unknown; all?: unknown }
    const all = body.all === true
    const explicitIds = Array.isArray(body.recruiterIds)
      ? body.recruiterIds.filter((x): x is string => typeof x === "string")
      : []
    if (!all && explicitIds.length === 0) {
      res.status(400).json({ ok: false, reason: "no_recruiters_selected" })
      return
    }

    const cfg = recruiterMailgunConfigFromEnv()
    if (!cfg) { res.status(503).json({ ok: false, reason: "mailgun_not_configured" }); return }

    const db = getFirestore()
    try {
      const items = await buildAllRecruiterDigests(db, Date.now())
      const byId = new Map(items.map((i) => [i.digest.recruiterId, i]))
      const targetIds = all ? items.map((i) => i.digest.recruiterId) : explicitIds

      const results: { recruiterId: string; ok: boolean; reason?: string; messageId?: string }[] = []
      for (const id of targetIds) {
        const item = byId.get(id)
        if (!item) { results.push({ recruiterId: id, ok: false, reason: "unknown_recruiter" }); continue }
        const to = item.digest.recruiterEmail
        if (!to) { results.push({ recruiterId: id, ok: false, reason: "no_email" }); continue }
        const email = renderDigestEmail(item.digest)
        const sent = await sendRecruiterMailgunEmail(cfg, { to, ...email })
        if (sent.ok) {
          await db.collection(RECRUITER_DIGEST_SENDS_COLLECTION).add({
            recruiterId: id,
            recruiterEmail: to,
            sentByEmail: admin,
            sentAt: FieldValue.serverTimestamp(),
            subject: email.subject,
            windowDays: item.digest.windowDays,
            stats: item.digest.stats,
            messageId: sent.messageId ?? null,
          })
          results.push({ recruiterId: id, ok: true, messageId: sent.messageId })
        } else {
          logger.warn("recruiter_digest_send_failed", { recruiterId: id, status: sent.status })
          results.push({ recruiterId: id, ok: false, reason: `mailgun_${sent.status}` })
        }
      }
      res.status(200).json({ ok: true, sent: results.filter((r) => r.ok).length, total: targetIds.length, results })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error("recruiter_digest_send_failed", { error: message })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)
