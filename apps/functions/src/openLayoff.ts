// WeKruit candidate and employer intake Cloud Function handlers.
//
// Co-located with pa-orchestrator. Reuses existing PA modules:
//   - sendblue/pool.ts        — pickFromNumber load-balancer
//   - sendblue/peer.ts        — normalizePeer (E.164)
//   - layoff-sms-start.ts     — shared runtime kickoff
//
// SINGLE candidate collection (alignment with user instruction 2026-05-15):
//   pa-users/{candidateId}
//     phoneE164, displayName, onboardingStatus, source
//     lastLaidOffAt              ← layoff flag + timestamp (used by filter)
//     layoffContext              ← lastCompany, jobTitle, location, email, linkedin
//     senderNumber               ← sticky Sendblue pool number
//   layoff_phone_index/{p_hash}  → { candidateId, lastLaidOffAt }  (dedup index)
//   layoff_employers/{employerId}
//   pa-config/sendblue-pool      — REUSED from PA (same numbers)
//
// Kickoff:
//   1. pa-users upsert with `source: "WeKruit_Laid_Off"` + `lastLaidOffAt`
//   2. layoff-sms-start hands the first message to the Claire runtime

import { onCall, HttpsError } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore, FieldValue, type Firestore, type Query } from "firebase-admin/firestore"
import { getApps, initializeApp } from "firebase-admin/app"

import { findSendbluePoolNumber, loadSendbluePool, pickFromNumber, sendblueGroupId, hashStringToUint } from "./sendblue/pool.js"
import { normalizePeer } from "./sendblue/peer.js"
import { PA_COLLECTIONS, isPaUserSource, type PaUserSource } from "@pa/core-types"
import { hashCandidateHandle, linkCandidateHandle } from "@pa/pa-persistence"
import {
  WEKRUIT_LAYOFF_SOURCE,
  WEKRUIT_CANDIDATE_SOURCE,
  isWekruitSignupSource,
  type WekruitSignupSource,
} from "@pa/pa-orchestrator"
import { runLayoffSmsStart, supersedeActivePrescreensForLayoff } from "./layoff-sms-start.js"
import { issueBindCode } from "./bind-code.js"
import { sendMailgun, type MailgunConfig } from "./email/mailgun.js"
import {
  MAILGUN_API_KEY,
  MAILGUN_DOMAIN,
  MAILGUN_FROM,
  MAILGUN_REGION,
  MAILGUN_SECRETS,
} from "./orchestrator-deps.js"

/** Inbox that receives the "new employer signup" notification. */
// Mailgun's `to` field accepts comma-separated addresses. All three admins
// receive the same notification (one Mailgun send, multi-recipient).
// Adam directive 2026-05-27: fix recipient list.
const EMPLOYER_SIGNUP_ADMIN_INBOX = "admin1@wekruit.com, adam.ylol@wekruit.com, noah.liu@wekruit.com"
/** Deep link operators get in the notification email to jump straight to review. */
const EMPLOYER_DASHBOARD_URL = "https://wekruit-pa.web.app/admin/layoff-employers"
const EMPLOYER_ROLE_PACKET_SOURCE_LABEL = "candidate.wekruit.com /employer"

/** Source tag — drives Claire's opener variant + listing filter + analytics. */
export const LAYOFF_SOURCE_TAG = WEKRUIT_LAYOFF_SOURCE

if (!getApps().length) initializeApp()

// ---------- Phone normalize + validate ----------

export function normalizeAndValidatePhone(raw: string): { ok: true; e164: string } | { ok: false; reason: string } {
  const e164 = normalizePeer(raw)
  if (!e164) return { ok: false, reason: "empty" }
  if (e164.includes("@")) return { ok: false, reason: "email_not_phone" }
  const digits = e164.replace(/\D/g, "")
  if (digits.length < 10) return { ok: false, reason: "too_short" }
  if (digits.length > 15) return { ok: false, reason: "too_long" }
  if (/^(\+?1?)(555)\d{7}$/.test(e164) && process.env.NODE_ENV === "production") {
    return { ok: false, reason: "test_number_not_allowed" }
  }
  return { ok: true, e164 }
}

export function phoneIndexId(e164: string): string {
  return `p_${hashStringToUint(e164).toString(36)}`
}

async function candidateIdForHandle(
  db: Firestore,
  kind: "email" | "phone",
  value: string,
): Promise<string | null> {
  const { handleId } = hashCandidateHandle(kind, value)
  const snap = await db.collection(PA_COLLECTIONS.candidateHandles).doc(handleId).get()
  if (!snap.exists) return null
  const candidateId = snap.data()?.candidateId
  return typeof candidateId === "string" && candidateId.trim() ? candidateId : null
}

// ---------- Registration ----------

export type RegisterInput = {
  firstName: string
  lastName: string
  email: string
  linkedin?: string
  personalWebsite?: string
  lastCompany?: string
  jobTitle?: string
  location?: string
  function?: string
  phone?: string
  consent: boolean
  resumeFileName?: string
  /** When set (post-auth onboarding), merge intake onto this pa-users doc. */
  candidateId?: string
  /**
   * Dedup mode (default "auto"):
   *   - "auto"    → if phone exists, RETURN { duplicate: true, ... } and do not write
   *   - "reuse"   → if phone exists, reuse candidateId + refresh lastLaidOffAt only (no field overwrite)
   *   - "refresh" → if phone exists, reuse candidateId + overwrite layoffContext + refresh lastLaidOffAt
   */
  mode?: "auto" | "reuse" | "refresh"
  /** Source selected by the host funnel (wekruit.com, layoff.wekruit.com, /yc-startup, …). */
  source?: PaUserSource
}

type CallableAuth = {
  uid?: string
  token?: Record<string, unknown>
}

export interface OpenLayoffDeps {
  db: Firestore
  serverTimestamp?: () => unknown
  nowIso?: () => string
  loadSendbluePool?: typeof loadSendbluePool
  runRuntimeKickoff?: Parameters<typeof runLayoffSmsStart>[0]["runRuntimeKickoff"]
}

function nowIso(): string {
  return new Date().toISOString()
}

function serverTimestamp(deps: OpenLayoffDeps): unknown {
  return deps.serverTimestamp ? deps.serverTimestamp() : FieldValue.serverTimestamp()
}

function cleanString(value: unknown, max = 320): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return undefined
  return trimmed
}

function cleanEmail(value: unknown): string | undefined {
  const email = cleanString(value)?.toLowerCase()
  return email && email.includes("@") ? email : undefined
}

function cleanFunction(value: unknown): "Design" | "Engineering" | "Product" | "GTM" | "Other" | undefined {
  if (value !== "Design" && value !== "Engineering" && value !== "Product" && value !== "GTM" && value !== "Other") {
    return undefined
  }
  return value
}

function deriveFunctionFromTitle(title: unknown): "Design" | "Engineering" | "Product" | "GTM" | "Other" | undefined {
  const t = cleanString(title, 240)?.toLowerCase()
  if (!t) return undefined
  if (t.includes("design") || t.includes("ux") || t.includes("brand")) return "Design"
  if (t.includes("eng") || t.includes("sw") || t.includes("developer")) return "Engineering"
  if (t.includes("pm") || t.includes("product")) return "Product"
  if (t.includes("sales") || t.includes("marketing") || t.includes("ae") || t.includes("cs")) return "GTM"
  return "Other"
}

async function requireVerifiedEmployer(
  db: Firestore,
  auth: CallableAuth | undefined
): Promise<{ employerId: string; workEmailLower: string }> {
  if (!auth?.uid) throw new HttpsError("unauthenticated", "Sign in required")
  const workEmailLower = cleanEmail(auth.token?.email)
  if (!workEmailLower) {
    throw new HttpsError("failed-precondition", "signed_in_work_email_required")
  }

  const snap = await db
    .collection("layoff_employers")
    .where("workEmailLower", "==", workEmailLower)
    .limit(10)
    .get()
  const verifiedDocs = snap.docs.filter((d) => d.data()?.verificationStatus === "verified")
  if (verifiedDocs.length === 0) {
    throw new HttpsError("failed-precondition", "employer_not_verified")
  }
  const approved = verifiedDocs.find((d) => isApprovedEmployerScreeningPacket(d.data()?.screeningPacket))
  if (!approved) {
    throw new HttpsError("failed-precondition", "employer_screening_packet_not_approved")
  }
  return { employerId: approved.id, workEmailLower }
}

function hasNonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.some((item) => typeof item === "string" && item.trim().length > 0)
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function hasNonEmptyRecord(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0)
}

function hasExistingProfilePath(value: Record<string, unknown>): boolean {
  return Boolean(
    value.linkedinOauthLinked === true ||
      hasNonEmptyString(value.linkedinUrl) ||
      hasNonEmptyString(value.latestResumeArtifactId) ||
      hasNonEmptyString(value.resumeArtifactId) ||
      hasNonEmptyString(value.latestResumeId) ||
      hasNonEmptyString(value.resumeFileName) ||
      hasNonEmptyRecord(value.candidateContext) ||
      hasNonEmptyRecord(value.layoffContext) ||
      hasNonEmptyRecord(value.tags),
  )
}

function isApprovedEmployerScreeningPacket(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const packet = value as Record<string, unknown>
  return (
    packet.reviewStatus === "approved_for_claire" &&
    hasNonEmptyStrings(packet.roleBrief) &&
    hasNonEmptyStrings(packet.hardFilters) &&
    hasNonEmptyStrings(packet.evidenceProbes) &&
    hasNonEmptyString(packet.calibrationExamples) &&
    hasNonEmptyString(packet.mustHaves) &&
    hasNonEmptyString(packet.feedbackLoop) &&
    hasNonEmptyString(packet.introHandoff)
  )
}

export async function runRegisterLayoffCandidate(
  v: RegisterInput,
  deps: OpenLayoffDeps
): Promise<Record<string, unknown>> {
  const mode = v.mode ?? "auto"
  // Accept ANY canonical pa-users source label (yc_startup_school, layoffhedge,
  // …) — the label is attribution only. Flow branching stays layoff-vs-rest via
  // isLayoff below. Legacy no-source calls keep the layoff default.
  const source: PaUserSource = isPaUserSource(v.source) ? v.source : WEKRUIT_LAYOFF_SOURCE
  const isLayoff = source === WEKRUIT_LAYOFF_SOURCE
  // YC Startup School is PEOPLE matching — a person may be an investor/founder, not a job
  // candidate — so résumé/LinkedIn/site is OPTIONAL (Adam-LOCKED 2026-07-24). Matches the
  // client-side gate; Claire still asks for LinkedIn in iMessage.
  const isYc = source === "yc_startup_school"
  const lastCompany = cleanString(v.lastCompany, 200)
  if (!v.firstName || !v.lastName || !v.email || !v.consent || (isLayoff && !lastCompany)) {
    throw new HttpsError("invalid-argument", "Missing required fields")
  }

  let existingProfilePathSatisfied = false
  const explicitIdEarly = cleanString(v.candidateId, 128)
  if (explicitIdEarly) {
    const earlySnap = await deps.db.collection(PA_COLLECTIONS.users).doc(explicitIdEarly).get()
    const early = earlySnap.data() ?? {}
    existingProfilePathSatisfied = hasExistingProfilePath(early)
  }
  const hasProfilePath =
    existingProfilePathSatisfied ||
    Boolean(cleanString(v.resumeFileName)) ||
    Boolean(cleanString(v.linkedin, 500)) ||
    Boolean(cleanString(v.personalWebsite, 500))
  if (!isYc && !hasProfilePath) {
    throw new HttpsError("invalid-argument", "intake_profile_required")
  }

  const now = serverTimestamp(deps)
  const isoNow = (deps.nowIso ?? nowIso)()

  let phoneE164: string | undefined
  let indexId: string | undefined
  let indexRef: ReturnType<Firestore["doc"]> | undefined
  let indexSnap: Awaited<ReturnType<ReturnType<Firestore["doc"]>["get"]>> | undefined
  let phoneHandleCandidateId: string | null = null

  if (v.phone) {
    const phoneCheck = normalizeAndValidatePhone(v.phone)
    if (!phoneCheck.ok) throw new HttpsError("invalid-argument", `phone_invalid:${phoneCheck.reason}`)
    phoneE164 = phoneCheck.e164
    indexId = phoneIndexId(phoneE164)
    indexRef = deps.db.doc(`layoff_phone_index/${indexId}`)
    indexSnap = await indexRef.get()
    phoneHandleCandidateId = await candidateIdForHandle(deps.db, "phone", phoneE164)
  }

  const explicitCandidateId = cleanString(v.candidateId, 128)
  let candidateId: string
  let isReregistration = false

  if (explicitCandidateId) {
    const explicitRef = deps.db.collection(PA_COLLECTIONS.users).doc(explicitCandidateId)
    const explicitSnap = await explicitRef.get()
    if (!explicitSnap.exists) {
      throw new HttpsError("not-found", "candidate_not_found")
    }
    candidateId = explicitCandidateId
    isReregistration = true
    if (phoneE164 && phoneHandleCandidateId && phoneHandleCandidateId !== candidateId) {
      throw new HttpsError("failed-precondition", "identity_conflict:phone_belongs_to_another_candidate")
    }
  } else if (indexSnap?.exists) {
    candidateId = indexSnap.data()!.candidateId as string
    isReregistration = true
    if (phoneE164 && phoneHandleCandidateId && phoneHandleCandidateId !== candidateId) {
      throw new HttpsError("failed-precondition", "identity_conflict:phone_belongs_to_another_candidate")
    }
  } else if (phoneHandleCandidateId) {
    candidateId = phoneHandleCandidateId
    isReregistration = true
  } else {
    candidateId = deps.db.collection(PA_COLLECTIONS.users).doc().id
  }

  // Auto mode → return duplicate signal so the UI can show the
  // "reuse / start fresh" prompt. No writes performed (phone dedup only).
  if (isReregistration && mode === "auto" && indexSnap?.exists && !explicitCandidateId) {
    const userRef = deps.db.collection(PA_COLLECTIONS.users).doc(candidateId)
    const userSnap = await userRef.get()
    const u = userSnap.data() ?? {}
    const ctx = (u.layoffContext ?? {}) as Record<string, string | null>
    const ts = u.lastLaidOffAt
    const lastLaidOffAt =
      ts && typeof (ts as { toDate?: unknown }).toDate === "function"
        ? (ts as { toDate: () => Date }).toDate().toISOString()
        : typeof ts === "string"
          ? ts
          : null
    return {
      duplicate: true,
      candidateId,
      existing: {
        firstName: ((u.displayName as string | undefined) ?? "").split(" ")[0] ?? null,
        lastCompany: ctx.lastCompany ?? null,
        jobTitle: ctx.jobTitle ?? null,
        location: ctx.location ?? null,
        lastLaidOffAt,
      },
    }
  }

  const emailCandidateId = await candidateIdForHandle(deps.db, "email", v.email)
  if (emailCandidateId && emailCandidateId !== candidateId) {
    throw new HttpsError("failed-precondition", "identity_conflict:email_belongs_to_another_candidate")
  }

  // Sticky from-number — deterministic hash by candidateId.
  const pool = await (deps.loadSendbluePool ?? loadSendbluePool)(deps.db)
  const fromNumber = pickFromNumber(pool, candidateId, { requireNewUserCapacity: !isReregistration }) ?? ""
  const groupId = fromNumber
    ? sendblueGroupId(findSendbluePoolNumber(pool, fromNumber) ?? { number: fromNumber, status: "active" })
    : "unassigned"

  // Single source of truth — pa-users.
  //   reuse   → refresh timestamp + source tag (no field overwrite)
  //   refresh → also overwrite source-specific context with newly submitted fields
  //   (fresh new registration) → write everything
  const userRef = deps.db.collection(PA_COLLECTIONS.users).doc(candidateId)
  const writeProfileContext = Boolean(explicitCandidateId) || !isReregistration || mode === "refresh"

  const linkedin = cleanString(v.linkedin, 500) ?? null
  const personalWebsite = cleanString(v.personalWebsite, 500) ?? null
  const roleFunction = cleanFunction(v.function) ?? deriveFunctionFromTitle(v.jobTitle) ?? null

  const writePayload: Record<string, unknown> = {
    id: candidateId,
    source,
    senderNumber: fromNumber,
    senderGroupId: groupId,
    intakeCompletedAt: isoNow,
    updatedAt: isoNow,
  }
  if (phoneE164) writePayload.phoneE164 = phoneE164
  if (linkedin) writePayload.linkedinUrl = linkedin
  if (isLayoff) {
    writePayload.lastLaidOffAt = now
    // Default canonical flags for the layoff list (Adam directive 2026-05-18):
    // every pa-users.source=WeKruit_Laid_Off doc should carry `isDemo` and
    // `getHired` so the public preview endpoint can mix demo + real rows and
    // the hire-success metric is always derivable. Only set on first registration
    // — re-registrations preserve whatever state ops already flipped.
    if (!isReregistration) {
      writePayload.isDemo = false
      writePayload.getHired = false
    }
  }
  if (writeProfileContext && isLayoff) {
    writePayload.displayName = `${v.firstName} ${v.lastName}`.trim() || v.firstName
    writePayload.layoffContext = {
      lastCompany,
      jobTitle: cleanString(v.jobTitle, 200) ?? null,
      location: cleanString(v.location, 200) ?? null,
      function: roleFunction,
      email: v.email,
      linkedin: v.linkedin ?? null,
      resumeFileName: v.resumeFileName ?? null,
      consent: v.consent,
    }
  } else if (writeProfileContext) {
    writePayload.displayName = `${v.firstName} ${v.lastName}`.trim() || v.firstName
    writePayload.candidateContext = {
      lastCompany: lastCompany ?? null,
      jobTitle: v.jobTitle ?? null,
      location: v.location ?? null,
      function: roleFunction,
      email: v.email,
      linkedin,
      personalWebsite,
      resumeFileName: v.resumeFileName ?? null,
      consent: v.consent,
    }
  }
  if (!isReregistration) {
    writePayload.onboardingStatus = "invited"
    writePayload.createdAt = isoNow
  }

  const batch = deps.db.batch()
  batch.set(userRef, writePayload, { merge: true })
  if (indexRef && indexId) {
    batch.set(
      indexRef,
      {
        candidateId,
        phoneHash: indexId,
        ...(isLayoff ? { lastLaidOffAt: now } : {}),
        lastSeenAt: now,
        source,
      },
      { merge: true },
    )
  }
  if (phoneE164) {
    batch.delete(deps.db.collection("pa-ats-pending-trigger").doc(phoneE164))
  }

  // List-position counter (for the success screen)
  const counterRef = deps.db.doc("layoff_meta/counters")
  const counterSnap = await counterRef.get()
  const listPosition = (counterSnap.exists ? (counterSnap.data()?.candidateCount ?? 412) : 412) + (isReregistration ? 0 : 1)
  if (!isReregistration) batch.set(counterRef, { candidateCount: listPosition }, { merge: true })

  await batch.commit()
  if (isLayoff) {
    await supersedeActivePrescreensForLayoff(deps.db, { candidateId, nowIso: isoNow })
  }
  if (phoneE164) {
    await linkCandidateHandle(deps.db, {
      candidateId,
      kind: "phone",
      value: phoneE164,
      source: "candidate",
      deliverable: true,
      now: isoNow,
      evidence: [{ source: "system", summary: "Layoff registration phone handle" }],
    })
  }
  await linkCandidateHandle(deps.db, {
    candidateId,
    kind: "email",
    value: v.email,
    source: "candidate",
    deliverable: true,
    now: isoNow,
    evidence: [{ source: "system", summary: "Layoff registration email handle" }],
  })

  // Phone-binding opener code (2026-06-13). The website-first candidate (no
  // bound phone) opens iMessage with "Hi, WeKruit, my code is <CODE>" — the CODE
  // is the bind mechanism (there's no phone to resolve from yet). Server-mint a
  // SHORT transit-safe code (Crockford base32 minus ambiguous glyphs) → the
  // page embeds it instead of the corruption-prone raw uid. Only minted when no
  // phone is bound; a phone-bound candidate resolves by phone (no code needed).
  // Best-effort: a mint failure must never fail registration — the client falls
  // back to "Hi Claire" / the legacy opener.
  let bindCode: string | undefined
  if (!phoneE164) {
    try {
      bindCode = await issueBindCode(deps.db, candidateId, Date.parse(isoNow) || Date.now())
    } catch {
      /* non-fatal — registration still succeeds; client falls back */
    }
  }

  return {
    candidateId,
    listPosition,
    senderNumber: fromNumber,
    senderGroupId: groupId,
    isReregistration,
    mode,
    ...(bindCode ? { bindCode } : {}),
  }
}

export const openRegisterLayoffCandidate = onCall<RegisterInput>(
  { region: "us-central1", cors: true, memory: "512MiB" },
  async (req) => {
    return runRegisterLayoffCandidate(req.data, { db: getFirestore() })
  },
)

// ---------- SMS kickoff (Claire opener via runtime) ----------

export async function runInitiateSmsPrescreen(
  candidateId: string,
  deps: OpenLayoffDeps
): Promise<Record<string, unknown>> {
  const userRef = deps.db.collection(PA_COLLECTIONS.users).doc(candidateId)
  const doc = await userRef.get()
  if (!doc.exists) throw new HttpsError("not-found", "User not found")
  const u = doc.data()!
  if (!isPaUserSource(u.source)) {
    throw new HttpsError("failed-precondition", "user_source_unsupported")
  }
  // Runtime kickoff branches layoff-vs-candidate only; every other canonical
  // source (yc_startup_school, layoffhedge, …) rides the candidate opener.
  const userSource: WekruitSignupSource = isWekruitSignupSource(u.source)
    ? u.source
    : WEKRUIT_CANDIDATE_SOURCE

  const phoneE164 = u.phoneE164 as string
  const result = await runLayoffSmsStart({
    db: deps.db,
    userId: candidateId,
    toE164: phoneE164,
    source: userSource,
    runRuntimeKickoff: deps.runRuntimeKickoff,
  })
  if (!result.ok) throw new HttpsError("failed-precondition", result.reason)

  return {
    ok: true,
    kickoffOutboundId: result.kickoffOutboundId,
    kickoffCreated: result.kickoffCreated,
    sourceTag: result.sourceTag,
  }
}

export const openInitiateSmsPrescreen = onCall<{ candidateId: string }>(
  { region: "us-central1", cors: true, memory: "512MiB" },
  async (req) => {
    return runInitiateSmsPrescreen(req.data.candidateId, { db: getFirestore() })
  },
)

// ---------- Chat turn capture (web SMS-bubble UI; SMS turns go through PA broker) ----------

export async function runSubmitChatTurn(
  input: { candidateId: string; turn: { promptId: string; text: string; at?: string } },
  deps: OpenLayoffDeps
): Promise<{ ok: true }> {
  const { candidateId, turn } = input
  const promptId = cleanString(turn.promptId, 80)
  const text = cleanString(turn.text, 4000)
  if (!candidateId || !promptId || !text) {
    throw new HttpsError("invalid-argument", "candidateId, promptId, and text are required")
  }
  const userRef = deps.db.collection(PA_COLLECTIONS.users).doc(candidateId)
  const userSnap = await userRef.get()
  if (!userSnap.exists) throw new HttpsError("not-found", "User not found")
  if (userSnap.data()?.source !== WEKRUIT_LAYOFF_SOURCE) {
    throw new HttpsError("failed-precondition", "user_not_tagged_layoff")
  }
  const isoNow = (deps.nowIso ?? nowIso)()
  const submittedAt = cleanString(turn.at, 80) ?? isoNow
  const layoffContextPatch: Record<string, unknown> = {}
  if (promptId === "next") layoffContextPatch.roleShape = text
  if (promptId === "open") {
    layoffContextPatch.openTo = text
    layoffContextPatch.sponsorshipNeeded =
      /\b(sponsor|sponsorship|h-?1b|visa|opt|cpt)\b/i.test(text) &&
      !/\b(no|not|don't|do not|without|none|citizen|green card|gc)\b/i.test(text)
    layoffContextPatch.logisticsRaw = text
  }
  if (promptId === "pitch") layoffContextPatch.pitch = text
  await userRef.set(
    {
      layoffChatAnswers: {
        [promptId]: text,
      },
      conversationDerivedPreferences: {
        layoff_onboarding: {
          [promptId]: {
            answer: text,
            source: "layoff_onboarding",
            at: submittedAt,
            updatedAt: isoNow,
          },
        },
        updatedAt: isoNow,
      },
      layoffEvidence: {
        latestChatTurn: {
          promptId,
          answer: text.slice(0, 1000),
          source: "layoff_onboarding",
          at: submittedAt,
          updatedAt: isoNow,
        },
      },
      ...(Object.keys(layoffContextPatch).length > 0
        ? { layoffContext: layoffContextPatch }
        : {}),
      smsLastTurnAt: serverTimestamp(deps),
      updatedAt: isoNow,
    },
    { merge: true },
  )
  return { ok: true }
}

export const openSubmitChatTurn = onCall<{
  candidateId: string
  turn: { promptId: string; text: string; at?: string }
}>({ region: "us-central1", cors: true, maxInstances: 1, memory: "512MiB" }, async (req) => {
  return runSubmitChatTurn(req.data, { db: getFirestore() })
})

// ---------- Verified-marketplace listing (layoff-tagged users only) ----------

export async function runListLayoffCandidates(
  input: {
    functions?: string[]
    verifiedOnly?: boolean
    withinDays?: number
  },
  auth: CallableAuth | undefined,
  deps: OpenLayoffDeps
): Promise<{ data: Record<string, unknown>[] }> {
  await requireVerifiedEmployer(deps.db, auth)

  // Filter by source tag — guarantees we never spill non-layoff pa-users
  // (e.g., regular PA candidates from pa-landing) into the layoff list.
  let q: Query = deps.db
    .collection(PA_COLLECTIONS.users)
    .where("source", "==", WEKRUIT_LAYOFF_SOURCE)

  const withinDays = input.withinDays ?? 180
  const cutoff = new Date(Date.now() - withinDays * 86400_000)
  q = q.where("lastLaidOffAt", ">=", cutoff).orderBy("lastLaidOffAt", "desc")

  if (input.functions?.length) {
    q = q.where("layoffContext.function", "in", input.functions.slice(0, 10))
  }

  const snap = await q.limit(200).get()
  return {
    data: snap.docs.map((d) => {
      const x = d.data()
      const ctx = (x.layoffContext ?? {}) as Record<string, unknown>
      // Return a redacted marketplace card — never raw email/phone.
      return {
        id: d.id,
        firstName: (x.displayName as string)?.split(" ")[0] ?? null,
        lastInitial: (x.displayName as string)?.split(" ")[1]?.[0] ?? null,
        lastCompany: ctx.lastCompany ?? null,
        jobTitle: ctx.jobTitle ?? null,
        location: ctx.location ?? null,
        lastLaidOffAt: x.lastLaidOffAt ?? null,
        verified: x.onboardingStatus === "complete" || x.onboardingStatus === "active",
      }
    }),
  }
}

export const openListLayoffCandidates = onCall<{
  functions?: string[]
  verifiedOnly?: boolean
  /** Max age (days) for lastLaidOffAt — defaults to 180. */
  withinDays?: number
}>({ region: "us-central1", cors: true }, async (req) => {
  return runListLayoffCandidates(req.data, req.auth, { db: getFirestore() })
})

// ---------- Employer registration ----------

export type EmployerInput = {
  companyName: string
  companyLinkedin: string
  workEmail: string
  stage: string
  roleAtCompany: string
  rolesHiring: string[]
  /** Hard-stop filters Claire must enforce before passing a candidate. */
  hardFilters: string[]
  /** Specific evidence probes Claire should elicit in the first interview. */
  screeningQuestions: string[]
  /** Examples that calibrate the strong-pass bar and false-positive boundary before Claire screens. */
  calibrationExamples: string
  /** Hiring-team signal loop after accepted/rejected passed-profile intros. */
  feedbackLoop: string
  /** Employer-owned next step after WeKruit sends an accepted passed-profile intro. */
  introHandoff: string
  /** Submitter name — for the admin notification email. */
  contactName?: string
  /** Free-form notes — appended verbatim to the admin notification body. */
  notes?: string
}

export type EmployerScreeningPacket = {
  version: 1
  source: "employer_role_intake"
  reviewStatus: "needs_wekruit_review" | "approved_for_claire" | "rejected_by_wekruit"
  roleBrief: string[]
  hardFilters: string[]
  evidenceProbes: string[]
  calibrationExamples: string
  mustHaves: string
  feedbackLoop: string
  introHandoff: string
}

const EMPLOYER_SCREENING_PACKET_STATUS = "needs WeKruit review before Claire screens"

export interface RegisterEmployerDeps extends OpenLayoffDeps {
  sendMail?: (cfg: MailgunConfig, input: { to: string; subject: string; text: string; html?: string }) => Promise<{ ok: boolean; status: number; messageId?: string; rawResponse?: string }>
}

export async function runRegisterEmployer(
  v: EmployerInput,
  deps: RegisterEmployerDeps,
  auth?: CallableAuth
): Promise<{ employerId: string }> {
  if (!v.companyName || !v.workEmail) throw new HttpsError("invalid-argument", "Missing required fields")
  const workEmailLower = cleanEmail(v.workEmail)
  if (!workEmailLower) throw new HttpsError("invalid-argument", "work_email_invalid")
  const rolesHiring = cleanStringList(v.rolesHiring)
  if (rolesHiring.length === 0) throw new HttpsError("invalid-argument", "role_brief_required")
  const hardFilters = cleanStringList(v.hardFilters)
  if (hardFilters.length === 0) throw new HttpsError("invalid-argument", "hard_filters_required")
  const screeningQuestions = cleanStringList(v.screeningQuestions)
  if (screeningQuestions.length === 0) throw new HttpsError("invalid-argument", "screening_questions_required")
  const calibrationExamples = typeof v.calibrationExamples === "string" ? v.calibrationExamples.trim() : ""
  if (!calibrationExamples) throw new HttpsError("invalid-argument", "calibration_examples_required")
  const notes = typeof v.notes === "string" ? v.notes.trim() : ""
  if (!notes) throw new HttpsError("invalid-argument", "must_haves_required")
  const feedbackLoop = typeof v.feedbackLoop === "string" ? v.feedbackLoop.trim() : ""
  if (!feedbackLoop) throw new HttpsError("invalid-argument", "feedback_loop_required")
  const introHandoff = typeof v.introHandoff === "string" ? v.introHandoff.trim() : ""
  if (!introHandoff) throw new HttpsError("invalid-argument", "intro_handoff_required")
  const cleanInput: EmployerInput = {
    ...v,
    companyName: v.companyName.trim(),
    companyLinkedin: typeof v.companyLinkedin === "string" ? v.companyLinkedin.trim() : "",
    workEmail: v.workEmail.trim(),
    stage: typeof v.stage === "string" && v.stage.trim() ? v.stage.trim() : "other",
    roleAtCompany: typeof v.roleAtCompany === "string" ? v.roleAtCompany.trim() : "",
    rolesHiring,
    hardFilters,
    screeningQuestions,
    calibrationExamples,
    feedbackLoop,
    introHandoff,
    contactName: typeof v.contactName === "string" ? v.contactName.trim() : undefined,
    notes,
  }
  const screeningPacket = buildEmployerScreeningPacket(cleanInput)
  const ref = deps.db.collection("layoff_employers").doc()
  await ref.set({
    ...cleanInput,
    screeningPacket,
    workEmailLower,
    verificationStatus: "pending",
    registeredByUid: auth?.uid ?? null,
    registeredAt: serverTimestamp(deps),
  })
  await notifyAdminOfEmployerSignup(cleanInput, { employerId: ref.id, workEmailLower }, deps.sendMail ?? sendMailgun)
  return { employerId: ref.id }
}

function cleanStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
}

function buildEmployerScreeningPacket(input: EmployerInput): EmployerScreeningPacket {
  return {
    version: 1,
    source: "employer_role_intake",
    reviewStatus: "needs_wekruit_review",
    roleBrief: input.rolesHiring,
    hardFilters: input.hardFilters,
    evidenceProbes: input.screeningQuestions,
    calibrationExamples: input.calibrationExamples,
    mustHaves: input.notes ?? "",
    feedbackLoop: input.feedbackLoop,
    introHandoff: input.introHandoff,
  }
}

async function notifyAdminOfEmployerSignup(
  v: EmployerInput,
  ctx: { employerId: string; workEmailLower: string },
  send: (cfg: MailgunConfig, input: { to: string; subject: string; text: string; html?: string }) => Promise<{ ok: boolean; status: number; messageId?: string; rawResponse?: string }>,
): Promise<void> {
  logger.info("openRegisterEmployer.notify_admin.starting", {
    employerId: ctx.employerId,
    apiKeyPresent: Boolean(process.env.MAILGUN_API_KEY),
    domainPresent: Boolean(process.env.MAILGUN_DOMAIN),
    fromPresent: Boolean(process.env.MAILGUN_FROM),
    regionEnv: process.env.MAILGUN_REGION ?? "(unset)",
  })
  const apiKey = process.env.MAILGUN_API_KEY ?? ""
  const domain = process.env.MAILGUN_DOMAIN ?? ""
  const from = process.env.MAILGUN_FROM ?? `WeKruit Employer Intake <noreply@${domain || "wekruit.com"}>`
  const region = (process.env.MAILGUN_REGION === "eu" ? "eu" : "us") as "us" | "eu"
  if (!apiKey || !domain) {
    logger.warn("openRegisterEmployer.notify_admin.skipped", {
      reason: "mailgun_not_configured",
      employerId: ctx.employerId,
    })
    return
  }
  const reviewUrl = `${EMPLOYER_DASHBOARD_URL}?focus=${ctx.employerId}`
  const lines: string[] = [
    `Review: ${reviewUrl}`,
    ``,
    `Company: ${v.companyName}`,
    `Stage: ${v.stage || "—"}`,
    v.companyLinkedin ? `LinkedIn: ${v.companyLinkedin}` : null,
    `Contact: ${v.contactName ?? "—"} (${v.roleAtCompany || "no role given"})`,
    `Work email: ${ctx.workEmailLower}`,
    `Roles hiring: ${v.rolesHiring?.length ? v.rolesHiring.join(", ") : "—"}`,
    `Screening packet: ${EMPLOYER_SCREENING_PACKET_STATUS}`,
    `Hard filters: ${v.hardFilters.length ? v.hardFilters.join("; ") : "—"}`,
    `Screening questions: ${v.screeningQuestions.length ? v.screeningQuestions.join("; ") : "—"}`,
    `Calibration examples: ${v.calibrationExamples || "—"}`,
    `Feedback loop: ${v.feedbackLoop || "—"}`,
    `Intro handoff: ${v.introHandoff || "—"}`,
    v.notes ? `\nNotes:\n${v.notes}` : null,
    `\nFirestore: layoff_employers/${ctx.employerId}`,
    `Source: ${EMPLOYER_ROLE_PACKET_SOURCE_LABEL}`,
  ].filter((s): s is string => s !== null)
  const text = lines.join("\n")
  const html =
    `<h2 style="font-family:system-ui;margin:0 0 12px">New employer role packet — ${escapeHtml(v.companyName)}</h2>` +
    `<p style="font-family:system-ui;font-size:14px;margin:0 0 18px">` +
    `  <a href="${escapeHtmlAttr(reviewUrl)}" style="display:inline-block;background:#2d1a0a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:500">` +
    `    Open in dashboard →` +
    `  </a>` +
    `</p>` +
    `<ul style="font-family:system-ui;font-size:14px;line-height:1.6;padding-left:20px">` +
    `<li><b>Stage:</b> ${escapeHtml(v.stage || "—")}</li>` +
    (v.companyLinkedin ? `<li><b>LinkedIn:</b> <a href="${escapeHtmlAttr(v.companyLinkedin)}">${escapeHtml(v.companyLinkedin)}</a></li>` : "") +
    `<li><b>Contact:</b> ${escapeHtml(v.contactName ?? "—")} (${escapeHtml(v.roleAtCompany || "no role given")})</li>` +
    `<li><b>Work email:</b> <a href="mailto:${escapeHtmlAttr(ctx.workEmailLower)}">${escapeHtml(ctx.workEmailLower)}</a></li>` +
    `<li><b>Roles hiring:</b> ${v.rolesHiring?.length ? escapeHtml(v.rolesHiring.join(", ")) : "—"}</li>` +
    `<li><b>Screening packet:</b> ${escapeHtml(EMPLOYER_SCREENING_PACKET_STATUS)}</li>` +
    `<li><b>Hard filters:</b> ${v.hardFilters.length ? escapeHtml(v.hardFilters.join("; ")) : "—"}</li>` +
    `<li><b>Screening questions:</b> ${v.screeningQuestions.length ? escapeHtml(v.screeningQuestions.join("; ")) : "—"}</li>` +
    `<li><b>Calibration examples:</b> ${escapeHtml(v.calibrationExamples || "—")}</li>` +
    `<li><b>Feedback loop:</b> ${escapeHtml(v.feedbackLoop || "—")}</li>` +
    `<li><b>Intro handoff:</b> ${escapeHtml(v.introHandoff || "—")}</li>` +
    `</ul>` +
    (v.notes ? `<h3 style="font-family:system-ui;font-size:14px;margin:18px 0 6px">Notes</h3><pre style="font-family:system-ui;font-size:13px;white-space:pre-wrap;background:#f6f3ee;padding:12px;border-radius:6px">${escapeHtml(v.notes)}</pre>` : "") +
    `<p style="font-family:system-ui;font-size:12px;color:#6b6357;margin-top:24px">Firestore: <code>layoff_employers/${escapeHtml(ctx.employerId)}</code><br>Source: <code>${escapeHtml(EMPLOYER_ROLE_PACKET_SOURCE_LABEL)}</code></p>`
  try {
    const res = await send(
      { apiKey, domain, from, region },
      {
        to: EMPLOYER_SIGNUP_ADMIN_INBOX,
        subject: `New employer role packet — ${v.companyName}`,
        text,
        html,
      },
    )
    if (res.ok) {
      logger.info("openRegisterEmployer.notify_admin.sent", {
        employerId: ctx.employerId,
        messageId: res.messageId,
      })
    } else {
      logger.error("openRegisterEmployer.notify_admin.failed", {
        employerId: ctx.employerId,
        status: res.status,
        rawResponse: res.rawResponse,
      })
    }
  } catch (err) {
    logger.error("openRegisterEmployer.notify_admin.threw", {
      employerId: ctx.employerId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function escapeHtmlAttr(s: string): string {
  return escapeHtml(s)
}

export const openRegisterEmployer = onCall<EmployerInput>(
  { region: "us-central1", cors: true, memory: "512MiB", secrets: MAILGUN_SECRETS },
  async (req) => {
    logger.info("openRegisterEmployer.entry", {
      companyName: req.data?.companyName,
      hasWorkEmail: Boolean(req.data?.workEmail),
    })
    // Hydrate Mailgun env so notifyAdminOfEmployerSignup() can read the
    // secret values without each call site doing defineSecret().value()
    // gymnastics. Same pattern as paMessageCoalescer (apps/functions/src/index.ts).
    try { process.env.MAILGUN_API_KEY = MAILGUN_API_KEY.value() } catch {}
    try { process.env.MAILGUN_DOMAIN = MAILGUN_DOMAIN.value() } catch {}
    try { process.env.MAILGUN_FROM = MAILGUN_FROM.value() } catch {}
    try { process.env.MAILGUN_REGION = MAILGUN_REGION.value() } catch {}
    return runRegisterEmployer(req.data, { db: getFirestore() }, req.auth)
  },
)
