import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto"
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  CandidateAuthMappingSchema,
  CandidateHandleSchema,
  PA_COLLECTIONS,
  type CandidateHandle,
  type CandidateProfileMarketplaceFields,
} from "@pa/core-types"
import {
  linkCandidateHandle as defaultLinkCandidateHandle,
  hashCandidateHandle,
  normalizeE164,
  writeCandidateSelfProfile as defaultWriteCandidateSelfProfile,
} from "@pa/pa-persistence"
import { enqueueOutbound as defaultEnqueueOutbound } from "@pa/pa-broker"
import {
  candidateClaireConversationStarted as defaultCandidateClaireConversationStarted,
} from "../candidate-claire-conversation.js"

const PHONE_LINK_COLLECTION = "pa-candidate-phone-link-verifications"
const CODE_TTL_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 5

type CallableAuth = {
  uid?: string
  token?: Record<string, unknown>
}

type PhoneCandidate = {
  candidateId: string
  user: Record<string, unknown>
}

type SelfProfileHandle = Pick<CandidateHandle, "kind" | "verifiedAt" | "source">

export type CandidatePhoneLinkStartResult =
  | {
      ok: true
      requestId: string
      phoneMasked: string
      expiresAt: string
    }
  | {
      ok: false
      reason: "no_claire_thread" | "invalid_phone" | "send_failed"
      message: string
    }

export type CandidatePhoneLinkVerifyResult =
  | {
      ok: true
      candidateId: string
      phoneMasked: string
      claireConversationStarted: true
      portalReady: true
    }
  | {
      ok: false
      reason:
        | "invalid_code"
        | "expired"
        | "not_found"
        | "too_many_attempts"
        | "auth_conflict"
        | "identity_conflict"
        | "no_claire_thread"
      message: string
    }

type LinkCandidateHandle = typeof defaultLinkCandidateHandle
type WriteCandidateSelfProfile = typeof defaultWriteCandidateSelfProfile
type EnqueueOutbound = typeof defaultEnqueueOutbound

export interface CandidatePhoneLinkDeps {
  db: Firestore
  now?: () => Date
  requestId?: () => string
  code?: () => string
  loadCandidateByPhone?: (db: Firestore, phoneE164: string) => Promise<PhoneCandidate | null>
  claireConversationStarted?: (
    db: Firestore,
    candidateId: string,
    userData: Record<string, unknown>,
  ) => Promise<boolean>
  enqueueOutbound?: EnqueueOutbound
  linkCandidateHandle?: LinkCandidateHandle
  writeCandidateSelfProfile?: WriteCandidateSelfProfile
  loadSelfProfileHandles?: (db: Firestore, candidateId: string) => Promise<SelfProfileHandle[]>
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return undefined
  return trimmed
}

function authEmail(auth: CallableAuth | undefined): string | undefined {
  return (
    cleanString(auth?.token?.email, 320) ??
    cleanString(auth?.token?.linkedinEmail, 320)
  )?.toLowerCase()
}

function authDisplayName(auth: CallableAuth | undefined): string | null {
  return (
    cleanString(auth?.token?.name, 200) ??
    cleanString(auth?.token?.linkedinName, 200) ??
    null
  )
}

function requireVerifiedAuth(auth: CallableAuth | undefined): {
  firebaseUid: string
  email: string
  displayName: string | null
} {
  const firebaseUid = cleanString(auth?.uid, 128)
  if (!firebaseUid) {
    throw new HttpsError("unauthenticated", "Sign in before linking a Claire phone thread.")
  }
  const email = authEmail(auth)
  if (!email || !email.includes("@")) {
    throw new HttpsError("failed-precondition", "Signed-in account has no verified email.")
  }
  if (auth?.token?.email_verified === false) {
    throw new HttpsError("failed-precondition", "Signed-in email is not verified.")
  }
  return { firebaseUid, email, displayName: authDisplayName(auth) }
}

function normalizeCandidatePhone(value: unknown): string | null {
  const raw = cleanString(value, 64)
  if (!raw) return null
  const normalized = normalizeE164(raw)
  return /^\+\d{8,16}$/.test(normalized) ? normalized : null
}

function maskPhone(phoneE164: string): string {
  return phoneE164.length <= 5 ? "***" : `${phoneE164.slice(0, 3)}***${phoneE164.slice(-2)}`
}

async function loadCandidateUserData(db: Firestore, candidateId: string): Promise<Record<string, unknown> | null> {
  const snap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  if (!snap.exists) return null
  return snap.data() ?? {}
}

async function hasClairePhoneIdentity(
  deps: CandidatePhoneLinkDeps,
  candidateId: string,
  userData: Record<string, unknown>,
): Promise<boolean> {
  if (normalizeCandidatePhone(userData.phoneE164)) return true
  try {
    return await (deps.claireConversationStarted ?? defaultCandidateClaireConversationStarted)(
      deps.db,
      candidateId,
      userData,
    )
  } catch {
    return true
  }
}

async function canReplaceAuthMappingFromCandidate(
  deps: CandidatePhoneLinkDeps,
  existingCandidateId: string,
): Promise<boolean> {
  const existingUser = await loadCandidateUserData(deps.db, existingCandidateId)
  if (!existingUser) return false
  return !(await hasClairePhoneIdentity(deps, existingCandidateId, existingUser))
}

async function moveEmailHandleFromPlaceholderCandidate(
  db: Firestore,
  email: string,
  fromCandidateId: string | null,
  toCandidateId: string,
  nowIso: string,
): Promise<void> {
  if (!fromCandidateId) return
  const hashed = hashCandidateHandle("email", email)
  const ref = db.collection(PA_COLLECTIONS.candidateHandles).doc(hashed.handleId)
  const snap = await ref.get()
  if (!snap.exists) return
  const handle = CandidateHandleSchema.parse(snap.data())
  if (handle.candidateId !== fromCandidateId) return
  const next = CandidateHandleSchema.parse({
    ...handle,
    candidateId: toCandidateId,
    source: "candidate",
    verifiedAt: handle.verifiedAt ?? nowIso,
    deliverable: true,
    updatedAt: nowIso,
  })
  await ref.set(next as unknown as Record<string, unknown>)
}

function hashCode(salt: string, code: string): string {
  return createHash("sha256").update(`${salt}:${code}`, "utf8").digest("hex")
}

function makeCode(): string {
  return String(randomInt(100000, 1000000))
}

function userTimestampMs(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  if (value && typeof value === "object") {
    const ts = value as { toDate?: () => Date; _seconds?: number; seconds?: number }
    if (typeof ts.toDate === "function") return ts.toDate().getTime()
    if (typeof ts._seconds === "number") return ts._seconds * 1000
    if (typeof ts.seconds === "number") return ts.seconds * 1000
  }
  return 0
}

function pickDeterministicCandidate(
  docs: Array<{ id: string; data: () => Record<string, unknown> | undefined }>,
): { id: string; data: () => Record<string, unknown> | undefined } {
  return [...docs].sort((a, b) => {
    const aCreated = userTimestampMs(a.data()?.createdAt) || Number.POSITIVE_INFINITY
    const bCreated = userTimestampMs(b.data()?.createdAt) || Number.POSITIVE_INFINITY
    if (aCreated !== bCreated) return aCreated - bCreated
    const aUpdated = userTimestampMs(a.data()?.updatedAt)
    const bUpdated = userTimestampMs(b.data()?.updatedAt)
    if (bUpdated !== aUpdated) return bUpdated - aUpdated
    return a.id.localeCompare(b.id)
  })[0]!
}

async function defaultLoadCandidateByPhone(
  db: Firestore,
  phoneE164: string,
): Promise<PhoneCandidate | null> {
  const snap = await db.collection(PA_COLLECTIONS.users).where("phoneE164", "==", phoneE164).limit(10).get()
  if (snap.empty) return null
  const chosen = pickDeterministicCandidate(snap.docs)
  return { candidateId: chosen.id, user: chosen.data() ?? {} }
}

async function defaultLoadSelfProfileHandles(
  db: Firestore,
  candidateId: string,
): Promise<SelfProfileHandle[]> {
  const snap = await db
    .collection(PA_COLLECTIONS.candidateHandles)
    .where("candidateId", "==", candidateId)
    .limit(20)
    .get()
  return snap.docs.map((doc) => {
    const handle = CandidateHandleSchema.parse(doc.data()) as CandidateHandle
    return {
      kind: handle.kind,
      source: handle.source,
      ...(handle.verifiedAt !== undefined ? { verifiedAt: handle.verifiedAt } : {}),
    }
  })
}

function phoneLinkError(reason: CandidatePhoneLinkStartResult extends infer R
  ? R extends { ok: false; reason: infer K } ? K : never
  : never): string {
  switch (reason) {
    case "invalid_phone":
      return "Enter the phone number you used to text Claire."
    case "no_claire_thread":
      return "We could not find a Claire phone thread for that number. Use onboarding, or talk with Claire from that number first."
    case "send_failed":
      return "We could not send the code right now. Try again in a moment."
  }
}

function verifyError(reason: Extract<CandidatePhoneLinkVerifyResult, { ok: false }>["reason"]): string {
  switch (reason) {
    case "invalid_code":
      return "That code did not match. Check Claire's text and try again."
    case "expired":
      return "That code expired. Send a new code."
    case "not_found":
      return "Send a new code before verifying."
    case "too_many_attempts":
      return "Too many attempts. Send a new code."
    case "auth_conflict":
      return "This sign-in is already attached to another WeKruit profile. We need to review it."
    case "identity_conflict":
      return "This email or phone is already attached to another WeKruit profile. We need to review it."
    case "no_claire_thread":
      return "We could not confirm a Claire text thread for that phone anymore."
  }
}

export async function runCandidatePhoneLinkStart(
  data: unknown,
  auth: CallableAuth | undefined,
  deps: CandidatePhoneLinkDeps,
): Promise<CandidatePhoneLinkStartResult> {
  const { firebaseUid } = requireVerifiedAuth(auth)
  const input = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const phoneE164 = normalizeCandidatePhone(input.phoneE164 ?? input.phone)
  if (!phoneE164) {
    return { ok: false, reason: "invalid_phone", message: phoneLinkError("invalid_phone") }
  }

  const candidate = await (deps.loadCandidateByPhone ?? defaultLoadCandidateByPhone)(deps.db, phoneE164)
  const claireStarted = candidate
    ? await (deps.claireConversationStarted ?? defaultCandidateClaireConversationStarted)(
        deps.db,
        candidate.candidateId,
        candidate.user,
      )
    : false
  if (!candidate || !claireStarted) {
    return { ok: false, reason: "no_claire_thread", message: phoneLinkError("no_claire_thread") }
  }

  const now = (deps.now ?? (() => new Date()))()
  const requestId = (deps.requestId ?? randomUUID)()
  const code = (deps.code ?? makeCode)()
  const salt = randomBytes(16).toString("hex")
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS).toISOString()
  const createdAt = now.toISOString()

  await deps.db.collection(PHONE_LINK_COLLECTION).doc(requestId).set({
    requestId,
    firebaseUid,
    candidateId: candidate.candidateId,
    phoneE164,
    phoneMasked: maskPhone(phoneE164),
    codeHash: hashCode(salt, code),
    salt,
    status: "pending",
    attempts: 0,
    createdAt,
    expiresAt,
  })

  try {
    await (deps.enqueueOutbound ?? defaultEnqueueOutbound)(deps.db, {
      userId: candidate.candidateId,
      toE164: phoneE164,
      body: `WeKruit verification code: ${code}. Use it to connect this web account to your Claire phone thread. It expires in 10 minutes.`,
      idempotencyKey: `candidate_phone_link:${firebaseUid}:${candidate.candidateId}:${requestId}`,
      runtimeApproved: true,
      // INBOUND-FIRST (Adam-locked 2026-06-14): this is a WEBSITE-initiated code,
      // NOT a reply into a thread that texted us — it must NOT use the
      // pa_identity_notice RULE-1 exemption. Subject to the never-inbound block:
      // the code only sends to a phone that already has a Claire thread (the
      // intended "I've chatted on phone, now connect web" flow). A phone that
      // never texted us is blocked — they must text us first (inbound-first).
      runtimeSource: "pa_connect_phone_link",
    })
  } catch {
    await deps.db.collection(PHONE_LINK_COLLECTION).doc(requestId).set(
      {
        status: "send_failed",
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    )
    return { ok: false, reason: "send_failed", message: phoneLinkError("send_failed") }
  }

  return {
    ok: true,
    requestId,
    phoneMasked: maskPhone(phoneE164),
    expiresAt,
  }
}

export async function runCandidatePhoneLinkVerify(
  data: unknown,
  auth: CallableAuth | undefined,
  deps: CandidatePhoneLinkDeps,
): Promise<CandidatePhoneLinkVerifyResult> {
  const { firebaseUid, email, displayName } = requireVerifiedAuth(auth)
  const input = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const requestId = cleanString(input.requestId, 160)
  const code = cleanString(input.code, 16)?.replace(/\D/g, "")
  if (!requestId || !code) {
    return { ok: false, reason: "not_found", message: verifyError("not_found") }
  }

  const ref = deps.db.collection(PHONE_LINK_COLLECTION).doc(requestId)
  const snap = await ref.get()
  if (!snap.exists) {
    return { ok: false, reason: "not_found", message: verifyError("not_found") }
  }
  const row = snap.data() ?? {}
  if (cleanString(row.firebaseUid, 128) !== firebaseUid || cleanString(row.status, 40) !== "pending") {
    return { ok: false, reason: "not_found", message: verifyError("not_found") }
  }
  const expiresAt = cleanString(row.expiresAt, 64)
  const now = (deps.now ?? (() => new Date()))()
  if (!expiresAt || Date.parse(expiresAt) <= now.getTime()) {
    await ref.set({ status: "expired", updatedAt: now.toISOString() }, { merge: true })
    return { ok: false, reason: "expired", message: verifyError("expired") }
  }
  const attempts = typeof row.attempts === "number" ? row.attempts : 0
  if (attempts >= MAX_ATTEMPTS) {
    await ref.set({ status: "too_many_attempts", updatedAt: now.toISOString() }, { merge: true })
    return { ok: false, reason: "too_many_attempts", message: verifyError("too_many_attempts") }
  }
  const salt = cleanString(row.salt, 128)
  const expectedHash = cleanString(row.codeHash, 128)
  if (!salt || !expectedHash || hashCode(salt, code) !== expectedHash) {
    const nextAttempts = attempts + 1
    await ref.set(
      {
        attempts: nextAttempts,
        ...(nextAttempts >= MAX_ATTEMPTS ? { status: "too_many_attempts" } : {}),
        updatedAt: now.toISOString(),
      },
      { merge: true },
    )
    return {
      ok: false,
      reason: nextAttempts >= MAX_ATTEMPTS ? "too_many_attempts" : "invalid_code",
      message: verifyError(nextAttempts >= MAX_ATTEMPTS ? "too_many_attempts" : "invalid_code"),
    }
  }

  const candidateId = cleanString(row.candidateId, 160)
  const phoneE164 = normalizeCandidatePhone(row.phoneE164)
  if (!candidateId || !phoneE164) {
    await ref.set({ status: "invalid", updatedAt: now.toISOString() }, { merge: true })
    return { ok: false, reason: "not_found", message: verifyError("not_found") }
  }

  const userRef = deps.db.collection(PA_COLLECTIONS.users).doc(candidateId)
  const userSnap = await userRef.get()
  const userData = userSnap.data() ?? {}
  const storedPhone = normalizeCandidatePhone(userData.phoneE164)
  const claireStarted = storedPhone === phoneE164
    ? await (deps.claireConversationStarted ?? defaultCandidateClaireConversationStarted)(
        deps.db,
        candidateId,
        userData,
      )
    : false
  if (!claireStarted) {
    await ref.set({ status: "no_claire_thread", updatedAt: now.toISOString() }, { merge: true })
    return { ok: false, reason: "no_claire_thread", message: verifyError("no_claire_thread") }
  }

  const authRef = deps.db.collection(PA_COLLECTIONS.candidateAuth).doc(firebaseUid)
  const existingAuthSnap = await authRef.get()
  let authRemapFromCandidateId: string | null = null
  if (existingAuthSnap.exists) {
    const existingCandidateId = cleanString(existingAuthSnap.data()?.candidateId, 160)
    if (existingCandidateId && existingCandidateId !== candidateId) {
      if (!(await canReplaceAuthMappingFromCandidate(deps, existingCandidateId))) {
        await ref.set({ status: "auth_conflict", updatedAt: now.toISOString() }, { merge: true })
        return { ok: false, reason: "auth_conflict", message: verifyError("auth_conflict") }
      }
      authRemapFromCandidateId = existingCandidateId
    }
  }

  let emailHandle: Awaited<ReturnType<LinkCandidateHandle>>["handle"]
  try {
    await moveEmailHandleFromPlaceholderCandidate(
      deps.db,
      email,
      authRemapFromCandidateId,
      candidateId,
      now.toISOString(),
    )
    emailHandle = (await (deps.linkCandidateHandle ?? defaultLinkCandidateHandle)(deps.db, {
      candidateId,
      kind: "email",
      value: email,
      source: "candidate",
      verified: true,
      deliverable: true,
      now: now.toISOString(),
      evidence: [{ source: "system", summary: "Phone-code verified Claire thread claim" }],
    })).handle
    await (deps.linkCandidateHandle ?? defaultLinkCandidateHandle)(deps.db, {
      candidateId,
      kind: "phone",
      value: phoneE164,
      source: "candidate",
      verified: true,
      deliverable: true,
      now: now.toISOString(),
      evidence: [{ source: "system", summary: "Phone-code verified Claire thread claim" }],
    })
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("identity_conflict:")) {
      await ref.set({ status: "identity_conflict", updatedAt: now.toISOString() }, { merge: true })
      return { ok: false, reason: "identity_conflict", message: verifyError("identity_conflict") }
    }
    throw err
  }

  const authMapping = CandidateAuthMappingSchema.parse({
    firebaseUid,
    candidateId,
    emailHandleId: emailHandle.handleId,
    emailHandleHash: emailHandle.handleHash,
    createdAt: existingAuthSnap.exists
      ? CandidateAuthMappingSchema.parse(existingAuthSnap.data()).createdAt
      : now.toISOString(),
    updatedAt: now.toISOString(),
    lastClaimedAt: now.toISOString(),
  })
  await authRef.set(authMapping, { merge: true })

  const nextUser = {
    ...userData,
    email,
    ...(displayName ? { displayName } : {}),
    phoneE164,
    phoneE164Source: "phone_code_verified_claire_thread",
    phoneLinkedFirebaseUid: firebaseUid,
    phoneLinkedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
  await userRef.set(nextUser, { merge: true })

  const handles = await (deps.loadSelfProfileHandles ?? defaultLoadSelfProfileHandles)(deps.db, candidateId)
  const senderNumber = cleanString((nextUser as Record<string, unknown>).senderNumber, 32) ?? null
  await (deps.writeCandidateSelfProfile ?? defaultWriteCandidateSelfProfile)(deps.db, {
    candidateId,
    email,
    phoneE164,
    senderNumber,
    displayName: displayName ?? (typeof nextUser.displayName === "string" ? nextUser.displayName : null),
    marketplaceFields: nextUser as unknown as CandidateProfileMarketplaceFields,
    handles,
    now: now.toISOString(),
  })

  await ref.set({ status: "verified", verifiedAt: now.toISOString(), updatedAt: now.toISOString() }, { merge: true })

  return {
    ok: true,
    candidateId,
    phoneMasked: maskPhone(phoneE164),
    claireConversationStarted: true,
    portalReady: true,
  }
}

export const paCandidatePhoneLinkStart = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 30,
  },
  async (req): Promise<CandidatePhoneLinkStartResult> => {
    return runCandidatePhoneLinkStart(req.data, req.auth, { db: getFirestore() })
  },
)

export const paCandidatePhoneLinkVerify = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 30,
  },
  async (req): Promise<CandidatePhoneLinkVerifyResult> => {
    return runCandidatePhoneLinkVerify(req.data, req.auth, { db: getFirestore() })
  },
)
