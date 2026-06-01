/**
 * Recruiter board HTTP Cloud Functions.
 *
 * Backs the `/recruiters` route on candidate.wekruit.com. Public, CORS-enabled.
 * Lives in the `recruiter-board` multi-codebase (separate from pa-orchestrator)
 * so cold start + bundle stay small and the API stays usable for downstream
 * consumers (e.g. recruiter agents calling the public list endpoint).
 *
 *   GET  paCollabJobsList          -> sanitized list of WeKruit collab jobs
 *                                     (supports ?limit, ?offset, ?since, ?status)
 *   POST paRecruiterInviteCodeCreate -> admin creates one-use recruiter invite code
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
 *   POST paRecruiterSubmission     -> writes pa-recruiter-submissions doc
 *                                     (honors Idempotency-Key header)
 *   POST paRecruiterCandidateConsentResend -> recruiter resends candidate double-opt-in email
 *   GET  paRecruiterCandidateConsentConfirm -> candidate confirms submitted interest
 *   GET  paRecruiterSubmissionsList -> recruiter-authenticated status tracker
 *   TRG  paRecruiterRoleReleasedNotify -> emails recruiters when a role is released
 *   TRG  paRecruiterRoleApplicationDecisionNotify -> creates recruiter inbox decision notices
 *   TRG  paRecruiterSubmissionFeedbackNotify -> creates recruiter inbox status/feedback notices
 *   GET  paCollabJobsListSchema    -> JSON Schema for the list response shape
 *
 * Companion docs:
 *   .planning/INITIATIVE-recruiter-board.md
 */
import { onRequest } from "firebase-functions/v2/https"
import { onDocumentWritten } from "firebase-functions/v2/firestore"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore, FieldValue, type DocumentReference, type Firestore, type Timestamp } from "firebase-admin/firestore"
import { getAuth } from "firebase-admin/auth"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { appendSubmissionToSheet } from "./recruiter-board-sheet.js"

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
const MAILGUN_SECRETS = [MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM, MAILGUN_REGION]
const RECRUITER_PUBLIC_BASE_URL = "https://candidate.wekruit.com"
const RECRUITER_CANDIDATE_CONFIRM_URL =
  "https://us-central1-wekruit-5f89b.cloudfunctions.net/paRecruiterCandidateConsentConfirm"

// ─────────────────────────────────────────────────────────────────────────────
// Hiring-board admin gating
//
// Anonymous visitors of https://wekruit.github.io/hiring-board/ must NEVER
// see the real company name on a collab job. Authenticated `@wekruit.com`
// staff get the full payload (real company, real Firestore doc id) so they
// can perform admin operations from the same surface.
// ─────────────────────────────────────────────────────────────────────────────

const HIRING_BOARD_ADMIN_EMAIL_DOMAIN = "@wekruit.com"
const RECRUITER_PRIMARY_ROLE_SLOT_LIMIT = 5
const RECRUITER_SINGLE_SUBMISSION_WEEKLY_LIMIT = 5

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

export interface RecruiterBoardPayload {
  active: boolean
  sortOrder: number
  label: RecruiterBoardLabel
  culture: RecruiterBoardCulture
  checklist: RecruiterBoardChecklist
  interviewProcess?: string
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

export interface RecruiterNotificationPreferences {
  newRolesEmail: boolean
}

export interface RecruiterWorkspacePreferences {
  primaryRoleIds: string[]
}

export interface RecruiterProfilePublic {
  recruiterId: string
  firebaseUid: string
  name: string
  email: string
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
}

interface RecruiterFirebaseIdentity {
  uid: string
  email: string
}

interface RecruiterInviteCodeCreateInput {
  label?: string
  code?: string
  maxUses: number
  expiresAt?: string
}

interface RecruiterInviteCodeReplaceInput {
  inviteCodeId: string
}

interface RecruiterInviteCodeRestoreInput {
  inviteCodeId: string
  inviteCode: string
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

function validateRecruiterRegistration(input: unknown):
  | { ok: true; value: RecruiterAccessRegistrationInput }
  | { ok: false; reason: string } {
  if (!input || typeof input !== "object") return { ok: false, reason: "missing_body" }
  const b = input as Record<string, unknown>
  if (!isNonEmptyString(b.name)) return { ok: false, reason: "missing_name" }
  if (!isNonEmptyString(b.email)) return { ok: false, reason: "missing_email" }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return { ok: false, reason: "invalid_email" }
  if (!isNonEmptyString(b.inviteCode)) return { ok: false, reason: "missing_invite_code" }
  if (b.name.length > 200 || b.email.length > 320 || b.inviteCode.length > 80) {
    return { ok: false, reason: "input_too_long" }
  }
  return {
    ok: true,
    value: {
      name: b.name.trim(),
      email: (b.email as string).trim().toLowerCase(),
      inviteCode: normalizeRecruiterInviteCode(b.inviteCode),
    },
  }
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
  let expiresAt = defaultRecruiterInviteCodeExpiresAt()
  if (b.expiresAt !== undefined) {
    if (typeof b.expiresAt !== "string") return { ok: false, reason: "invalid_expires_at" }
    const ms = Date.parse(b.expiresAt)
    if (Number.isNaN(ms) || ms <= Date.now()) return { ok: false, reason: "invalid_expires_at" }
    expiresAt = new Date(ms).toISOString()
  }
  return { ok: true, value: { code, label, maxUses: 1, expiresAt } }
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
  expiresAt?: string | null
  createdByEmail: string
  replacesInviteCodeId?: string
}): Record<string, unknown> {
  return {
    inviteCodeId: input.inviteCodeId,
    inviteCode: input.inviteCode,
    active: true,
    label: input.label ?? null,
    codePreview: maskRecruiterInviteCode(input.inviteCode),
    maxUses: 1,
    usedCount: 0,
    expiresAt: input.expiresAt ?? null,
    createdByEmail: input.createdByEmail,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...(input.replacesInviteCodeId ? { replacesInviteCodeId: input.replacesInviteCodeId } : {}),
  }
}

function readNotificationPreferences(data: Record<string, unknown> | null | undefined): RecruiterNotificationPreferences {
  const raw = data?.notificationPreferences
  const prefs = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  return { newRolesEmail: prefs.newRolesEmail !== false }
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

export async function registerRecruiterAccess(
  db: Firestore,
  identity: RecruiterFirebaseIdentity,
  input: RecruiterAccessRegistrationInput,
): Promise<RecruiterProfilePublic | null> {
  if (identity.email !== input.email) {
    throw new Error("email_mismatch")
  }
  const recruiterId = identity.uid
  const recruiterBase: RecruiterProfilePublic = {
    recruiterId,
    firebaseUid: identity.uid,
    name: input.name,
    email: identity.email,
    notificationPreferences: { newRolesEmail: true },
    workspacePreferences: { primaryRoleIds: [] },
  }

  const result = await db.runTransaction(async (tx) => {
    const nowMs = Date.now()
    const userRef = db.collection(RECRUITER_USERS_COLLECTION).doc(recruiterId)
    const existingUser = await tx.get(userRef)
    const existingData = existingUser.exists ? existingUser.data() as Record<string, unknown> : null
    if (existingData?.status === "disabled") return null

    if (existingUser.exists) {
      const existingEmail = typeof existingData?.email === "string" ? existingData.email.trim().toLowerCase() : ""
      if (existingEmail && existingEmail !== identity.email) throw new Error("email_mismatch")
      if (!recruiterInviteCodeMatchesBoundUser(existingData, input.inviteCode)) return null
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
    for (const id of candidateInviteCodeIds(input.inviteCode)) {
      const ref = db.collection(RECRUITER_INVITE_CODES_COLLECTION).doc(id)
      const snap = await tx.get(ref)
      if (!snap.exists) continue
      const data = snap.data() as Record<string, unknown>
      if (!inviteCodeUsable(data, nowMs)) return null
      inviteId = id
      inviteRef = ref
      break
    }
    if (!inviteId || !inviteRef) return null

    const recruiter = {
      ...recruiterBase,
      notificationPreferences: { newRolesEmail: true },
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
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>
    const rb = d.recruiterBoard as RecruiterBoardPayload | undefined
    if (!rb) continue
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

    const recruiterBoardForCaller: RecruiterBoardPayload = options.isAdmin
      ? rb
      : { ...rb, label: anonymizeCompanyLabel(rb.label) }

    allMatching.push({
      jobId: jobIdForCaller,
      title: String(d.title ?? ""),
      compSummary: typeof d.compSummary === "string" ? d.compSummary : undefined,
      jdBlocks: Array.isArray(d.jdBlocks) ? (d.jdBlocks as JdBlock[]) : [],
      recruiterBoard: recruiterBoardForCaller,
      updatedAt: updatedAtIso,
    })
  }
  allMatching.sort((a, b) => a.recruiterBoard.sortOrder - b.recruiterBoard.sortOrder)

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
      try {
        await ref.create(buildRecruiterInviteCodeDoc({
          inviteCodeId: codeHash,
          inviteCode: normalizedCode,
          label: validated.value.label ?? null,
          expiresAt: validated.value.expiresAt ?? null,
          createdByEmail: adminEmail,
        }))
        res.set("Cache-Control", "private, max-age=0, no-store")
        res.status(200).json({
          ok: true,
          inviteCode: normalizedCode,
          inviteCodeId: codeHash,
          codePreview: maskRecruiterInviteCode(normalizedCode),
          maxUses: validated.value.maxUses,
          expiresAt: validated.value.expiresAt ?? null,
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
    res.set("Cache-Control", "private, max-age=0, no-store")
    res.status(200).json({ ok: true, recruiterId: recruiter.recruiterId, recruiter })
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
    currentRole?: string
    yoe?: string
    notes?: string
  }
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
  recruiterFeedbackNote?: string | null
  recruiterFeedbackRating?: number | null
  recruiterFeedbackReasons?: string[]
  recruiterFeedbackUpdatedByEmail?: string | null
  recruiterFeedbackUpdatedAt?: unknown
  createdAt?: unknown
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

function publicRecruiterSubmission(d: { id: string; data: () => Record<string, unknown> }): RecruiterSubmissionListItem {
  const data = d.data()
  return {
    id: d.id,
    submissionId: typeof data.submissionId === "string" ? data.submissionId : undefined,
    sourcedCandidateId: typeof data.sourcedCandidateId === "string" ? data.sourcedCandidateId : undefined,
    jobId: typeof data.jobId === "string" ? data.jobId : undefined,
    inboundJobId: typeof data.inboundJobId === "string" ? data.inboundJobId : undefined,
    jobTitleSnapshot: typeof data.jobTitleSnapshot === "string" ? data.jobTitleSnapshot : undefined,
    companyLabelSnapshot: typeof data.companyLabelSnapshot === "string" ? data.companyLabelSnapshot : undefined,
    candidate: typeof data.candidate === "object" && data.candidate !== null
      ? data.candidate as RecruiterSubmissionListItem["candidate"]
      : undefined,
    candidateConsentStatus: typeof data.candidateConsentStatus === "string" ? data.candidateConsentStatus : undefined,
    candidateConfirmation: publicRecruiterCandidateConfirmation(data.candidateConfirmation),
    score: typeof data.score === "object" && data.score !== null ? data.score as SubmissionScore : undefined,
    submissionMode: data.submissionMode === "primary_role" || data.submissionMode === "single_submission"
      ? data.submissionMode
      : "unclassified",
    status: typeof data.status === "string" ? data.status : "submitted",
    statusHistory: sanitizeSubmissionStatusHistory(data.statusHistory),
    recruiterFeedbackNote: typeof data.recruiterFeedbackNote === "string" ? data.recruiterFeedbackNote : null,
    recruiterFeedbackRating: sanitizeSubmissionFeedbackRating(data.recruiterFeedbackRating),
    recruiterFeedbackReasons: sanitizeSubmissionFeedbackReasons(data.recruiterFeedbackReasons),
    recruiterFeedbackUpdatedByEmail: typeof data.recruiterFeedbackUpdatedByEmail === "string"
      ? data.recruiterFeedbackUpdatedByEmail
      : null,
    recruiterFeedbackUpdatedAt: data.recruiterFeedbackUpdatedAt,
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
  jobId: string
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

export function validateRecruiterSourcedCandidateInput(input: unknown):
  | { ok: true; value: RecruiterSourcedCandidateInput }
  | { ok: false; reason: string } {
  if (!input || typeof input !== "object") return { ok: false, reason: "missing_body" }
  const b = input as Record<string, unknown>
  const candidateId = sanitizeOptionalString(b.candidateId, 120)
  if (candidateId && !/^[A-Za-z0-9_.:-]{1,120}$/.test(candidateId)) return { ok: false, reason: "invalid_candidate_id" }
  if (!isNonEmptyString(b.jobId)) return { ok: false, reason: "missing_jobId" }
  if (b.jobId.length > 200) return { ok: false, reason: "jobId_too_long" }
  const stage = typeof b.stage === "string" && RECRUITER_SOURCED_CANDIDATE_STAGES.includes(b.stage as RecruiterSourcedCandidateStage)
    ? b.stage as RecruiterSourcedCandidateStage
    : "sourced"

  const c = b.candidate as Record<string, unknown> | undefined
  if (!c || typeof c !== "object") return { ok: false, reason: "missing_candidate" }
  if (!isNonEmptyString(c.name)) return { ok: false, reason: "missing_candidate_name" }
  if (!isNonEmptyString(c.link)) return { ok: false, reason: "missing_candidate_link" }
  if (c.name.length > 200) return { ok: false, reason: "candidate_name_too_long" }
  if (c.link.length > 2000) return { ok: false, reason: "candidate_link_too_long" }
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

  const candidate: RecruiterSourcedCandidateInput["candidate"] = {
    name: c.name.trim(),
    link: c.link.trim(),
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
      jobId: b.jobId.trim(),
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
  return status === "submitted" || status === "new" || status === "reviewing" || status === undefined || status === null
}

function isAdvancedSubmissionStatus(status: unknown): boolean {
  return status === "advanced" || status === "interviewing" || status === "hired"
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
        if (candidate.jobId !== realJobId && candidate.inboundJobId !== payload.jobId) {
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
        if (data.jobId !== realJobId) continue
        if (data.recruiterId !== recruiter.recruiterId) {
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
          if (data.jobId !== realJobId) continue
          if (data.recruiterId !== recruiter.recruiterId) {
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
        jobId: realJobId,
        inboundJobId: payload.jobId,
        candidateLinkKey,
        ...(candidateEmailKey ? { candidateEmailKey } : {}),
        jobTitleSnapshot: String(jobData.title ?? ""),
        companyLabelSnapshot: rb.label.company,
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
    if (!prefsBody && !workspacePrefsBody) {
      res.status(400).json({ ok: false, reason: "missing_preferences_update" })
      return
    }
    if (prefsBody && typeof prefsBody.newRolesEmail !== "boolean") {
      res.status(400).json({ ok: false, reason: "invalid_new_roles_email" })
      return
    }
    const workspacePreferencesResult = workspacePrefsBody
      ? validateRecruiterWorkspacePreferences(workspacePrefsBody)
      : { ok: true as const, value: recruiter.workspacePreferences }
    if (!workspacePreferencesResult.ok) {
      res.status(400).json({ ok: false, reason: workspacePreferencesResult.reason })
      return
    }
    const notificationPreferences: RecruiterNotificationPreferences = prefsBody
      ? { newRolesEmail: prefsBody.newRolesEmail as boolean }
      : recruiter.notificationPreferences
    const workspacePreferences = workspacePreferencesResult.value
    const updateDoc: Record<string, unknown> = {
      notificationPreferences,
      workspacePreferences,
      lastSeenAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }
    await db.collection(RECRUITER_USERS_COLLECTION).doc(recruiter.recruiterId).set(updateDoc, { merge: true })
    res.set("Cache-Control", "private, max-age=0, no-store")
    res.status(200).json({
      ok: true,
      recruiter: { ...recruiter, notificationPreferences, workspacePreferences },
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
    currentRole?: string
    yoe?: string
    notes?: string
  }
  checklist: { [itemId: string]: boolean }
  candidateConsent: true
  /** Caller hint: which surface produced this submission. Tracked verbatim. */
  source?: string
}

interface CandidateConfirmationResendInput {
  submissionId: string
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
}

export interface RecruiterCandidateIdentityDoc {
  id: string
  collection: "submissions" | "sourced"
  data: Record<string, unknown>
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
      return { reason: "candidate_already_submitted_for_role", docId: doc.id }
    }
    const owner = typeof data.recruiterId === "string" ? data.recruiterId : null
    const linkedSubmissionId = typeof data.linkedSubmissionId === "string" ? data.linkedSubmissionId.trim() : ""
    if (linkedSubmissionId) {
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

  const cl = b.checklist
  if (!cl || typeof cl !== "object") return { ok: false, reason: "missing_checklist" }
  const cleanedChecklist: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(cl as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length > 200) return { ok: false, reason: "invalid_checklist_key" }
    if (typeof v !== "boolean") return { ok: false, reason: "invalid_checklist_value" }
    cleanedChecklist[k] = v
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
  if (b.candidateConsent !== true) return { ok: false, reason: "candidate_consent_required" }
  if (!candidateEmail) return { ok: false, reason: "missing_candidate_email" }

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
        link: (c.link as string).trim(),
        currentRole: typeof c.currentRole === "string" ? (c.currentRole as string).trim() : undefined,
        yoe: typeof c.yoe === "string" ? (c.yoe as string).trim() : undefined,
        notes: typeof c.notes === "string" ? (c.notes as string).trim() : undefined,
      },
      checklist: cleanedChecklist,
      candidateConsent: true,
      source,
    },
  }
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

export function computeSubmissionScore(
  groups: RecruiterBoardChecklistGroup[],
  checklist: Record<string, boolean>,
): SubmissionScore {
  const score: SubmissionScore = {
    hardChecked: 0, hardTotal: 0,
    fitChecked: 0, fitTotal: 0,
    bonusChecked: 0, bonusTotal: 0,
    antiChecked: 0, antiTotal: 0,
  }
  for (const g of groups) {
    for (const item of g.items) {
      const checked = checklist[item.id] === true
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

interface RecruiterRoleNotificationEmailInput {
  recruiterName: string
  roleTitle: string
  companyLabel: string
  location: string
  roleUrl: string
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

interface CandidateSubmissionConfirmationEmailInput {
  candidateName: string
  recruiterName: string
  roleTitle: string
  companyLabel: string
  confirmationUrl: string
}

export function composeCandidateSubmissionConfirmationEmail(
  input: CandidateSubmissionConfirmationEmailInput,
): { subject: string; text: string; html: string } {
  const roleLabel = `${input.roleTitle} at ${input.companyLabel}`
  const subject = `Confirm your WeKruit submission for ${input.roleTitle}`
  const text = [
    `Hi ${input.candidateName || "there"},`,
    "",
    `${input.recruiterName || "A recruiter"} submitted you to WeKruit for ${roleLabel}.`,
    "Confirm that you are interested in this role and gave permission for this submission.",
    "",
    `Confirm here: ${input.confirmationUrl}`,
    "",
    "If you did not approve this submission, ignore this email and WeKruit will not treat it as candidate-confirmed.",
  ].join("\n")
  const html = [
    `<p>Hi ${escapeHtml(input.candidateName || "there")},</p>`,
    `<p>${escapeHtml(input.recruiterName || "A recruiter")} submitted you to WeKruit for <b>${escapeHtml(roleLabel)}</b>.</p>`,
    "<p>Confirm that you are interested in this role and gave permission for this submission.</p>",
    `<p><a href="${escapeHtml(input.confirmationUrl)}">Confirm this submission</a></p>`,
    "<p style=\"color:#666;font-size:12px\">If you did not approve this submission, ignore this email and WeKruit will not treat it as candidate-confirmed.</p>",
  ].join("")
  return { subject, text, html }
}

function recruiterCandidateConfirmationUrl(submissionId: string, token: string): string {
  const url = new URL(RECRUITER_CANDIDATE_CONFIRM_URL)
  url.searchParams.set("submissionId", submissionId)
  url.searchParams.set("token", token)
  return url.toString()
}

function hashRecruiterCandidateConfirmationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
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

type CandidateConfirmationSendResult =
  | { ok: true; status: "email_sent"; candidateConsentStatus: "pending_candidate_confirmation"; messageId?: string }
  | { ok: false; reason: string; candidateConsentStatus: "candidate_confirmed" | "confirmation_email_failed" | "confirmation_email_not_configured" }

function candidateSubmissionConfirmationEmailInputFromDoc(
  submissionId: string,
  data: Record<string, unknown>,
): (CandidateSubmissionConfirmationEmailInput & { candidateEmail: string; token: string }) | { reason: string } {
  const candidate = data.candidate && typeof data.candidate === "object"
    ? data.candidate as Record<string, unknown>
    : {}
  const submitter = data.submitter && typeof data.submitter === "object"
    ? data.submitter as Record<string, unknown>
    : {}
  const candidateName = typeof candidate.name === "string" ? candidate.name.trim() : ""
  const candidateEmail = typeof candidate.email === "string" ? normalizeRecruiterCandidateEmail(candidate.email) : ""
  if (!candidateEmail || !validRecruiterCandidateEmail(candidateEmail)) return { reason: "missing_candidate_email" }
  const token = randomUUID()
  return {
    candidateName,
    candidateEmail,
    recruiterName: typeof submitter.name === "string" ? submitter.name.trim() : "",
    roleTitle: typeof data.jobTitleSnapshot === "string" && data.jobTitleSnapshot.trim()
      ? data.jobTitleSnapshot.trim()
      : "WeKruit role",
    companyLabel: typeof data.companyLabelSnapshot === "string" && data.companyLabelSnapshot.trim()
      ? data.companyLabelSnapshot.trim()
      : "WeKruit",
    confirmationUrl: recruiterCandidateConfirmationUrl(submissionId, token),
    token,
  }
}

async function sendCandidateSubmissionConfirmationForDoc(
  submissionRef: DocumentReference,
  submissionId: string,
  data: Record<string, unknown>,
  actor: "submission" | "recruiter_resend",
): Promise<CandidateConfirmationSendResult> {
  if (data.candidateConsentStatus === "candidate_confirmed") {
    return { ok: false, reason: "candidate_already_confirmed", candidateConsentStatus: "candidate_confirmed" }
  }
  const input = candidateSubmissionConfirmationEmailInputFromDoc(submissionId, data)
  if ("reason" in input) {
    await submissionRef.set({
      candidateConsentStatus: "confirmation_email_failed",
      "candidateConfirmation.status": "email_failed",
      "candidateConfirmation.lastError": input.reason,
      "candidateConfirmation.updatedAt": FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    return { ok: false, reason: input.reason, candidateConsentStatus: "confirmation_email_failed" }
  }

  const cfg = recruiterMailgunConfigFromEnv()
  const queuedUpdate: Record<string, unknown> = {
    candidateConsentStatus: "pending_candidate_confirmation",
    "candidateConfirmation.status": "email_queued",
    "candidateConfirmation.candidateEmail": input.candidateEmail,
    "candidateConfirmation.tokenHash": hashRecruiterCandidateConfirmationToken(input.token),
    "candidateConfirmation.updatedAt": FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }
  if (actor === "recruiter_resend") {
    queuedUpdate["candidateConfirmation.resendCount"] = FieldValue.increment(1)
    queuedUpdate["candidateConfirmation.lastResentAt"] = FieldValue.serverTimestamp()
  }
  await submissionRef.set(queuedUpdate, { merge: true })

  if (!cfg) {
    await submissionRef.set({
      candidateConsentStatus: "confirmation_email_not_configured",
      "candidateConfirmation.status": "email_not_configured",
      "candidateConfirmation.lastError": "mailgun_not_configured",
      "candidateConfirmation.updatedAt": FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    return { ok: false, reason: "mailgun_not_configured", candidateConsentStatus: "confirmation_email_not_configured" }
  }

  const emailContent = composeCandidateSubmissionConfirmationEmail(input)
  try {
    const result = await sendRecruiterMailgunEmail(cfg, { to: input.candidateEmail, ...emailContent })
    if (result.ok) {
      await submissionRef.set({
        candidateConsentStatus: "pending_candidate_confirmation",
        "candidateConfirmation.status": "email_sent",
        "candidateConfirmation.provider": "mailgun",
        "candidateConfirmation.messageId": result.messageId ?? null,
        "candidateConfirmation.sentAt": FieldValue.serverTimestamp(),
        "candidateConfirmation.lastError": null,
        "candidateConfirmation.updatedAt": FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
      return {
        ok: true,
        status: "email_sent",
        candidateConsentStatus: "pending_candidate_confirmation",
        messageId: result.messageId,
      }
    }
    const reason = `mailgun_${result.status}:${result.raw.slice(0, 300)}`
    await submissionRef.set({
      candidateConsentStatus: "confirmation_email_failed",
      "candidateConfirmation.status": "email_failed",
      "candidateConfirmation.provider": "mailgun",
      "candidateConfirmation.lastError": reason,
      "candidateConfirmation.updatedAt": FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    return { ok: false, reason, candidateConsentStatus: "confirmation_email_failed" }
  } catch (err) {
    const reason = String(err).slice(0, 300)
    await submissionRef.set({
      candidateConsentStatus: "confirmation_email_failed",
      "candidateConfirmation.status": "email_failed",
      "candidateConfirmation.provider": "mailgun",
      "candidateConfirmation.lastError": reason,
      "candidateConfirmation.updatedAt": FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    return { ok: false, reason, candidateConsentStatus: "confirmation_email_failed" }
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
    type: "role_application_decision" | "submission_feedback"
    eventId: string
    recruiterId: string
    recruiterEmail?: string
    entityType: "role_application" | "submission"
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

function recruiterSubmissionStatusLabel(status: string): string {
  switch (status) {
    case "reviewing": return "WeKruit review"
    case "advanced": return "sent to hiring team"
    case "interviewing": return "interviewing"
    case "hired": return "hired"
    case "rejected": return "not a fit"
    case "duplicate": return "duplicate"
    case "submitted":
    case "new":
    default:
      return "submitted"
  }
}

function feedbackFieldChanged(before: Record<string, unknown> | null, after: Record<string, unknown>): boolean {
  const keys = ["recruiterFeedbackNote", "recruiterFeedbackRating", "recruiterFeedbackUpdatedAt"]
  if (keys.some((key) => JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after[key] ?? null))) return true
  return JSON.stringify(before?.recruiterFeedbackReasons ?? []) !== JSON.stringify(after.recruiterFeedbackReasons ?? [])
}

function submissionFeedbackNotification(
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
  const title = feedbackChanged
    ? `WeKruit feedback for ${candidateName}`
    : `${candidateName} is ${recruiterSubmissionStatusLabel(afterStatus)}`
  const body = compactNotificationBody([
    typeof after.jobTitleSnapshot === "string" ? after.jobTitleSnapshot : "",
    statusChanged ? `Status: ${recruiterSubmissionStatusLabel(afterStatus)}` : "",
    rating ? `Rating ${rating}` : "",
    reasons,
    note,
  ])
  return { title, body }
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

export const paRecruiterRoleApplicationDecisionNotify = onDocumentWritten(
  {
    document: `${RECRUITER_ROLE_APPLICATIONS_COLLECTION}/{applicationId}`,
    region: "us-central1",
    memory: RECRUITER_BOARD_MEMORY,
  },
  async (event) => {
    const before = event.data?.before.exists ? event.data.before.data() as Record<string, unknown> : null
    const after = event.data?.after.exists ? event.data.after.data() as Record<string, unknown> : null
    const notification = roleApplicationDecisionNotification(before, after)
    if (!notification || !after) return
    const recruiterId = typeof after.recruiterId === "string" ? after.recruiterId : ""
    if (!recruiterId) return
    const created = await createRecruiterInAppNotification(getFirestore(), {
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
  },
)

export const paRecruiterSubmissionFeedbackNotify = onDocumentWritten(
  {
    document: `${RECRUITER_SUBMISSIONS_COLLECTION}/{submissionId}`,
    region: "us-central1",
    memory: RECRUITER_BOARD_MEMORY,
  },
  async (event) => {
    const before = event.data?.before.exists ? event.data.before.data() as Record<string, unknown> : null
    const after = event.data?.after.exists ? event.data.after.data() as Record<string, unknown> : null
    const notification = submissionFeedbackNotification(before, after)
    if (!notification || !after) return
    const recruiterId = typeof after.recruiterId === "string" ? after.recruiterId : ""
    if (!recruiterId) return
    const created = await createRecruiterInAppNotification(getFirestore(), {
      type: "submission_feedback",
      eventId: event.id,
      recruiterId,
      recruiterEmail: typeof after.recruiterEmail === "string" ? after.recruiterEmail : undefined,
      entityType: "submission",
      entityId: event.params.submissionId,
      title: notification.title,
      body: notification.body,
      jobId: typeof after.jobId === "string" ? after.jobId : undefined,
      publicJobId: typeof after.inboundJobId === "string" ? after.inboundJobId : undefined,
      roleTitle: typeof after.jobTitleSnapshot === "string" ? after.jobTitleSnapshot : undefined,
      companyLabel: typeof after.companyLabelSnapshot === "string" ? after.companyLabelSnapshot : undefined,
      roleUrl: recruiterNotificationRoleUrl(after),
    })
    if (created) logger.info("paRecruiterSubmissionFeedbackNotify_done", { submissionId: event.params.submissionId, recruiterId })
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
      if (sourcedData.jobId !== realJobId && sourcedData.inboundJobId !== payload.jobId) {
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
    const candidateConsentStatus = payload.candidate.email
      ? "pending_candidate_confirmation"
      : "recruiter_asserted"
    let finalCandidateConsentStatus = candidateConsentStatus
    const candidateConfirmation = payload.candidate.email
      ? {
          status: "email_queued",
          candidateEmail: payload.candidate.email,
          requestedAt: FieldValue.serverTimestamp(),
        }
      : null
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
      checklist: payload.checklist,
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

    if (payload.candidate.email) {
      try {
        const submissionRef = db.collection("pa-recruiter-submissions").doc(submissionId)
        const confirmationResult = await sendCandidateSubmissionConfirmationForDoc(submissionRef, submissionId, submissionDoc, "submission")
        finalCandidateConsentStatus = confirmationResult.candidateConsentStatus
      } catch (err) {
        logger.error("paRecruiterSubmission_candidate_confirmation_failed", {
          error: String(err),
          submissionId,
        })
      }
    }

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

export const paRecruiterCandidateConsentResend = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY, secrets: MAILGUN_SECRETS },
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

    const validated = validateCandidateConfirmationResendInput(req.body)
    if (!validated.ok) {
      res.status(400).json({ ok: false, reason: validated.reason })
      return
    }

    const { submissionId } = validated.value
    const submissionRef = db.collection(RECRUITER_SUBMISSIONS_COLLECTION).doc(submissionId)
    const snap = await submissionRef.get()
    if (!snap.exists) {
      res.status(404).json({ ok: false, reason: "submission_not_found" })
      return
    }
    const data = snap.data() as Record<string, unknown>
    if (data.recruiterId !== recruiter.recruiterId) {
      res.status(403).json({ ok: false, reason: "forbidden" })
      return
    }
    if (data.candidateConsentStatus === "candidate_confirmed") {
      res.status(409).json({
        ok: false,
        reason: "candidate_already_confirmed",
        candidateConsentStatus: "candidate_confirmed",
      })
      return
    }

    const result = await sendCandidateSubmissionConfirmationForDoc(
      submissionRef,
      submissionId,
      data,
      "recruiter_resend",
    )
    if (result.ok) {
      res.status(200).json({
        ok: true,
        candidateConsentStatus: result.candidateConsentStatus,
        confirmationStatus: result.status,
      })
      return
    }

    res.status(result.reason === "mailgun_not_configured" ? 503 : 502).json({
      ok: false,
      reason: result.reason,
      candidateConsentStatus: result.candidateConsentStatus,
    })
  },
)

function candidateConfirmationHtml(input: { title: string; body: string }): string {
  return [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    `<title>${escapeHtml(input.title)}</title>`,
    "<style>body{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,sans-serif;background:#faf7f2;color:#28180f;margin:0;padding:48px 18px}.card{max-width:640px;margin:0 auto;background:white;border:1px solid #eadfce;border-radius:16px;padding:28px;box-shadow:0 18px 48px rgba(57,34,18,.08)}h1{font-family:Georgia,serif;font-size:34px;margin:0 0 12px}p{font-size:16px;line-height:1.55;color:#5d5148}.brand{letter-spacing:.18em;text-transform:uppercase;font-size:12px;color:#936c3e;font-weight:700}</style>",
    "</head><body><main class=\"card\">",
    "<div class=\"brand\">WeKruit</div>",
    `<h1>${escapeHtml(input.title)}</h1>`,
    `<p>${escapeHtml(input.body)}</p>`,
    "</main></body></html>",
  ].join("")
}

export const paRecruiterCandidateConsentConfirm = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    res.set("Content-Type", "text/html; charset=utf-8")
    if (req.method !== "GET") {
      res.status(405).send(candidateConfirmationHtml({
        title: "Unsupported request",
        body: "This confirmation link only works as a browser link.",
      }))
      return
    }
    const submissionId = typeof req.query.submissionId === "string" ? req.query.submissionId.trim() : ""
    const token = typeof req.query.token === "string" ? req.query.token.trim() : ""
    if (!submissionId || !IDEMPOTENCY_KEY_RE.test(submissionId) || !/^[A-Za-z0-9-]{20,120}$/.test(token)) {
      res.status(400).send(candidateConfirmationHtml({
        title: "Invalid confirmation link",
        body: "The candidate confirmation link is malformed. Ask your recruiter or WeKruit for a fresh submission link.",
      }))
      return
    }
    const ref = getFirestore().collection("pa-recruiter-submissions").doc(submissionId)
    const snap = await ref.get()
    if (!snap.exists) {
      res.status(404).send(candidateConfirmationHtml({
        title: "Submission not found",
        body: "We could not find this recruiter submission. It may have been removed or replaced.",
      }))
      return
    }
    const data = snap.data() as Record<string, unknown>
    const confirmation = data.candidateConfirmation && typeof data.candidateConfirmation === "object"
      ? data.candidateConfirmation as Record<string, unknown>
      : {}
    const storedHash = typeof confirmation.tokenHash === "string" ? confirmation.tokenHash : ""
    if (!storedHash || storedHash !== hashRecruiterCandidateConfirmationToken(token)) {
      res.status(403).send(candidateConfirmationHtml({
        title: "Confirmation link expired",
        body: "This link does not match the current recruiter submission. Ask your recruiter or WeKruit for a fresh link.",
      }))
      return
    }
    if (data.candidateConsentStatus !== "candidate_confirmed") {
      await ref.update({
        candidateConsentStatus: "candidate_confirmed",
        "candidateConfirmation.status": "confirmed",
        "candidateConfirmation.confirmedAt": FieldValue.serverTimestamp(),
        "candidateConfirmation.updatedAt": FieldValue.serverTimestamp(),
        statusHistory: FieldValue.arrayUnion({
          status: "candidate_confirmed",
          by: "candidate",
          atIso: new Date().toISOString(),
        }),
        updatedAt: FieldValue.serverTimestamp(),
      })
    }
    res.status(200).send(candidateConfirmationHtml({
      title: "Submission confirmed",
      body: "Thanks. WeKruit has recorded that you approved this recruiter submission and are interested in the role.",
    }))
  },
)
