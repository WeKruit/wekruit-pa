// WeKruit Open — Cloud Function handlers.
//
// Co-located with pa-orchestrator. Reuses existing PA modules:
//   - sendblue/pool.ts        — pickFromNumber load-balancer
//   - sendblue/allowlist.ts   — normalizePeer (E.164)
//   - layoff-sms-start.ts     — shared Claire kickoff into pa-outbound
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
// Kickoff = same pattern as pa-landing outreach:
//   1. pa-users upsert with `source: "WeKruit_Laid_Off"` + `lastLaidOffAt`
//   2. enqueueOutbound() drops one row; Claire takes over on candidate reply

import { onCall, HttpsError } from "firebase-functions/v2/https"
import { getFirestore, FieldValue, type Firestore, type Query } from "firebase-admin/firestore"
import { getApps, initializeApp } from "firebase-admin/app"

import { loadSendbluePool, pickFromNumber, sendblueGroupId, hashStringToUint } from "./sendblue/pool.js"
import { normalizePeer } from "./sendblue/allowlist.js"
import { enqueueOutbound } from "@pa/pa-broker"
import { PA_COLLECTIONS } from "@pa/core-types"
import { hashCandidateHandle, linkCandidateHandle } from "@pa/pa-persistence"
import { WEKRUIT_LAYOFF_SOURCE } from "@pa/pa-orchestrator"
import { runLayoffSmsStart, supersedeActivePrescreensForLayoff } from "./layoff-sms-start.js"

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
  lastCompany: string
  jobTitle: string
  location: string
  phone: string
  consent: boolean
  resumeFileName?: string
  /**
   * Dedup mode (default "auto"):
   *   - "auto"    → if phone exists, RETURN { duplicate: true, ... } and do not write
   *   - "reuse"   → if phone exists, reuse candidateId + refresh lastLaidOffAt only (no field overwrite)
   *   - "refresh" → if phone exists, reuse candidateId + overwrite layoffContext + refresh lastLaidOffAt
   */
  mode?: "auto" | "reuse" | "refresh"
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
  enqueueOutbound?: typeof enqueueOutbound
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
  if (!v.firstName || !v.email || !v.phone || !v.consent) {
    throw new HttpsError("invalid-argument", "Missing required fields")
  }
  const mode = v.mode ?? "auto"

  const phoneCheck = normalizeAndValidatePhone(v.phone)
  if (!phoneCheck.ok) throw new HttpsError("invalid-argument", `phone_invalid:${phoneCheck.reason}`)
  const phoneE164 = phoneCheck.e164
  const indexId = phoneIndexId(phoneE164)
  const now = serverTimestamp(deps)
  const isoNow = (deps.nowIso ?? nowIso)()

  // Phone dedup index — controls reuse path.
  const indexRef = deps.db.doc(`layoff_phone_index/${indexId}`)
  const indexSnap = await indexRef.get()
  const phoneHandleCandidateId = await candidateIdForHandle(deps.db, "phone", phoneE164)
  let candidateId: string
  let isReregistration = false
  if (indexSnap.exists) {
    candidateId = indexSnap.data()!.candidateId as string
    isReregistration = true
    if (phoneHandleCandidateId && phoneHandleCandidateId !== candidateId) {
      throw new HttpsError("failed-precondition", "identity_conflict:phone_belongs_to_another_candidate")
    }
  } else if (phoneHandleCandidateId) {
    candidateId = phoneHandleCandidateId
    isReregistration = true
  } else {
    candidateId = deps.db.collection(PA_COLLECTIONS.users).doc().id
  }

  // Auto mode → return duplicate signal so the UI can show the
  // "reuse / start fresh" prompt. No writes performed.
  if (isReregistration && mode === "auto") {
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
  const fromNumber = pickFromNumber(pool, candidateId) ?? process.env.SENDBLUE_FROM_NUMBER ?? ""
  const groupId = fromNumber ? sendblueGroupId({ number: fromNumber, status: "active" }) : "unassigned"

  // Single source of truth — pa-users.
  //   reuse   → only refresh lastLaidOffAt + source tag (no field overwrite)
  //   refresh → also overwrite layoffContext with newly submitted fields
  //   (fresh new registration) → write everything
  const userRef = deps.db.collection(PA_COLLECTIONS.users).doc(candidateId)
  const writeLayoffContext = !isReregistration || mode === "refresh"

  const writePayload: Record<string, unknown> = {
    id: candidateId,
    phoneE164,
    source: WEKRUIT_LAYOFF_SOURCE,
    lastLaidOffAt: now,
    senderNumber: fromNumber,
    senderGroupId: groupId,
  }
  if (writeLayoffContext) {
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
  }
  if (!isReregistration) {
    writePayload.onboardingStatus = "invited"
    writePayload.createdAt = isoNow
  }

  const batch = deps.db.batch()
  batch.set(userRef, writePayload, { merge: true })
  batch.set(indexRef, { candidateId, lastLaidOffAt: now, phoneHash: indexId }, { merge: true })
  batch.delete(deps.db.collection("pa-ats-pending-trigger").doc(phoneE164))

  // List-position counter (for the success screen)
  const counterRef = deps.db.doc("layoff_meta/counters")
  const counterSnap = await counterRef.get()
  const listPosition = (counterSnap.exists ? (counterSnap.data()?.candidateCount ?? 412) : 412) + (isReregistration ? 0 : 1)
  if (!isReregistration) batch.set(counterRef, { candidateCount: listPosition }, { merge: true })

  await batch.commit()
  await supersedeActivePrescreensForLayoff(deps.db, { candidateId, nowIso: isoNow })
  await linkCandidateHandle(deps.db, {
    candidateId,
    kind: "phone",
    value: phoneE164,
    source: "candidate",
    deliverable: true,
    now: isoNow,
    evidence: [{ source: "system", summary: "Layoff registration phone handle" }],
  })
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
  { region: "us-central1", cors: true },
  async (req) => {
    return runRegisterLayoffCandidate(req.data, { db: getFirestore() })
  },
)

// ---------- SMS kickoff (Claire opener via pa-outbound) ----------

export async function runInitiateSmsPrescreen(
  candidateId: string,
  deps: OpenLayoffDeps
): Promise<Record<string, unknown>> {
  const userRef = deps.db.collection(PA_COLLECTIONS.users).doc(candidateId)
  const doc = await userRef.get()
  if (!doc.exists) throw new HttpsError("not-found", "User not found")
  const u = doc.data()!
  if (u.source !== WEKRUIT_LAYOFF_SOURCE) {
    throw new HttpsError("failed-precondition", "user_not_tagged_layoff")
  }

  const phoneE164 = u.phoneE164 as string
  const result = await runLayoffSmsStart({
    db: deps.db,
    userId: candidateId,
    toE164: phoneE164,
    enqueueOutbound: deps.enqueueOutbound,
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
  { region: "us-central1", cors: true },
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
}>({ region: "us-central1", cors: true }, async (req) => {
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
  q = q.where("lastLaidOffAt", ">=", cutoff)

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
}

export async function runRegisterEmployer(
  v: EmployerInput,
  deps: OpenLayoffDeps,
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
  return { employerId: ref.id }
}

export const openRegisterEmployer = onCall<EmployerInput>(
  { region: "us-central1", cors: true },
  async (req) => {
    return runRegisterEmployer(req.data, { db: getFirestore() }, req.auth)
  },
)
