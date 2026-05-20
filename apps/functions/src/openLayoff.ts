// WeKruit Open — Cloud Function handlers.
//
// Co-located with pa-orchestrator. Reuses existing PA modules:
//   - sendblue/pool.ts        — pickFromNumber load-balancer
//   - sendblue/allowlist.ts   — normalizePeer (E.164)
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

import { loadSendbluePool, pickFromNumber, sendblueGroupId, hashStringToUint } from "./sendblue/pool.js"
import { normalizePeer } from "./sendblue/allowlist.js"
import { PA_COLLECTIONS } from "@pa/core-types"
import { hashCandidateHandle, linkCandidateHandle } from "@pa/pa-persistence"
import {
  WEKRUIT_LAYOFF_SOURCE,
  WEKRUIT_CANDIDATE_SOURCE,
  isWekruitSignupSource,
  type WekruitSignupSource,
} from "@pa/pa-orchestrator"
import { runLayoffSmsStart, supersedeActivePrescreensForLayoff } from "./layoff-sms-start.js"
import { sendMailgun, type MailgunConfig } from "./email/mailgun.js"
import {
  MAILGUN_API_KEY,
  MAILGUN_DOMAIN,
  MAILGUN_FROM,
  MAILGUN_REGION,
  MAILGUN_SECRETS,
} from "./orchestrator-deps.js"

/** Inbox that receives the "new employer signup" notification. */
const EMPLOYER_SIGNUP_ADMIN_INBOX = "admin1@wekruit.com"
/** Deep link operators get in the notification email to jump straight to review. */
const EMPLOYER_DASHBOARD_URL = "https://wekruit-pa.web.app/admin/layoff-employers"

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
  lastCompany: string
  jobTitle?: string
  location?: string
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
  /** Source selected by the host funnel: layoff.wekruit.com or candidate.wekruit.com. */
  source?: WekruitSignupSource
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
  const verified = snap.docs.find((d) => d.data()?.verificationStatus === "verified")
  if (!verified) {
    throw new HttpsError("failed-precondition", "employer_not_verified")
  }
  return { employerId: verified.id, workEmailLower }
}

export async function runRegisterLayoffCandidate(
  v: RegisterInput,
  deps: OpenLayoffDeps
): Promise<Record<string, unknown>> {
  if (!v.firstName || !v.lastName || !v.email || !v.lastCompany || !v.consent) {
    throw new HttpsError("invalid-argument", "Missing required fields")
  }
  const mode = v.mode ?? "auto"
  const source: WekruitSignupSource = isWekruitSignupSource(v.source)
    ? v.source
    : WEKRUIT_LAYOFF_SOURCE
  const isLayoff = source === WEKRUIT_LAYOFF_SOURCE

  if (isLayoff) {
    if (!v.phone || !v.jobTitle || !v.location) {
      throw new HttpsError("invalid-argument", "Missing required fields")
    }
  } else {
    let oauthLinkedinSatisfied = false
    const explicitIdEarly = cleanString(v.candidateId, 128)
    if (explicitIdEarly) {
      const earlySnap = await deps.db.collection(PA_COLLECTIONS.users).doc(explicitIdEarly).get()
      const early = earlySnap.data() ?? {}
      oauthLinkedinSatisfied =
        early.linkedinOauthLinked === true ||
        (typeof early.linkedinUrl === "string" && early.linkedinUrl.includes("/oauth-linked/"))
    }
    const hasProfilePath =
      oauthLinkedinSatisfied ||
      Boolean(cleanString(v.resumeFileName)) ||
      Boolean(cleanString(v.linkedin, 500)) ||
      Boolean(cleanString(v.personalWebsite, 500))
    if (!hasProfilePath) {
      throw new HttpsError("invalid-argument", "intake_profile_required")
    }
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
  const groupId = fromNumber ? sendblueGroupId({ number: fromNumber, status: "active" }) : "unassigned"

  // Single source of truth — pa-users.
  //   reuse   → refresh timestamp + source tag (no field overwrite)
  //   refresh → also overwrite source-specific context with newly submitted fields
  //   (fresh new registration) → write everything
  const userRef = deps.db.collection(PA_COLLECTIONS.users).doc(candidateId)
  const writeLayoffContext = !isReregistration || mode === "refresh"

  const linkedin = cleanString(v.linkedin, 500) ?? null
  const personalWebsite = cleanString(v.personalWebsite, 500) ?? null

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
  if (writeLayoffContext && isLayoff) {
    writePayload.displayName = `${v.firstName} ${v.lastName}`.trim() || v.firstName
    writePayload.layoffContext = {
      lastCompany: v.lastCompany,
      jobTitle: v.jobTitle,
      location: v.location,
      email: v.email,
      linkedin: v.linkedin ?? null,
      resumeFileName: v.resumeFileName ?? null,
      consent: v.consent,
    }
  } else if (writeLayoffContext) {
    writePayload.displayName = `${v.firstName} ${v.lastName}`.trim() || v.firstName
    writePayload.candidateContext = {
      lastCompany: v.lastCompany,
      jobTitle: v.jobTitle ?? null,
      location: v.location ?? null,
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

  return {
    candidateId,
    listPosition,
    senderNumber: fromNumber,
    senderGroupId: groupId,
    isReregistration,
    mode,
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
  if (!isWekruitSignupSource(u.source)) {
    throw new HttpsError("failed-precondition", "user_source_unsupported")
  }
  const userSource = u.source as WekruitSignupSource

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
  /** Submitter name — for the admin notification email. */
  contactName?: string
  /** Free-form notes — appended verbatim to the admin notification body. */
  notes?: string
}

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
  const ref = deps.db.collection("layoff_employers").doc()
  await ref.set({
    ...v,
    workEmailLower,
    verificationStatus: "pending",
    registeredByUid: auth?.uid ?? null,
    registeredAt: serverTimestamp(deps),
  })
  await notifyAdminOfEmployerSignup(v, { employerId: ref.id, workEmailLower }, deps.sendMail ?? sendMailgun)
  return { employerId: ref.id }
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
  const from = process.env.MAILGUN_FROM ?? `WeKruit Open <noreply@${domain || "wekruit.com"}>`
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
    v.notes ? `\nNotes:\n${v.notes}` : null,
    `\nFirestore: layoff_employers/${ctx.employerId}`,
    `Source: layoff.wekruit.com /employer`,
  ].filter((s): s is string => s !== null)
  const text = lines.join("\n")
  const html =
    `<h2 style="font-family:system-ui;margin:0 0 12px">New employer signup — ${escapeHtml(v.companyName)}</h2>` +
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
    `</ul>` +
    (v.notes ? `<h3 style="font-family:system-ui;font-size:14px;margin:18px 0 6px">Notes</h3><pre style="font-family:system-ui;font-size:13px;white-space:pre-wrap;background:#f6f3ee;padding:12px;border-radius:6px">${escapeHtml(v.notes)}</pre>` : "") +
    `<p style="font-family:system-ui;font-size:12px;color:#6b6357;margin-top:24px">Firestore: <code>layoff_employers/${escapeHtml(ctx.employerId)}</code><br>Source: <code>layoff.wekruit.com /employer</code></p>`
  try {
    const res = await send(
      { apiKey, domain, from, region },
      {
        to: EMPLOYER_SIGNUP_ADMIN_INBOX,
        subject: `New employer signup — ${v.companyName}`,
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
