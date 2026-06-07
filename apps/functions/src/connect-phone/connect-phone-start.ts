/**
 * connect-phone-start.ts — WS-3(a) STEP 1: a web-authed candidate who already
 * chatted on phone requests a verification code, texted to their iMessage thread.
 *
 * Flow (the INVERSE of the QR opener which binds website → phone):
 *   1. Candidate is signed in on candidate.wekruit.com (Firebase auth) and enters
 *      their phone number on /connect-phone.
 *   2. THIS callable (paCandidateConnectPhoneStart):
 *        a. auth gate (signed-in + verified email).
 *        b. resolve the phone E.164 → the EXISTING phone-resolved pa-users/{uid}
 *           (resolveCandidateIdentity mode "resolve_only" — NEVER create a new
 *           candidate from a phone). Absent → reason "no_phone_profile" (the
 *           candidate hasn't actually chatted on phone) — no SMS, no leak.
 *        c. resolve the WEB uid → its candidate id (pa-candidate-auth mapping).
 *           Same candidate already → idempotent ok (already linked).
 *        d. canary gate (new product behavior, dev phones only). Non-canary →
 *           reason "not_enabled", no SMS.
 *        e. issue a 6-digit code (hashed at rest) + text it to the phone thread.
 *
 * Returns only a coarse status — NEVER the code, NEVER the resolved uid.
 *
 * PR-FIRST: new public callable — committed to claude/ws1-2-3-onboarding, NOT
 * deployed. Reuses Sendblue creds + the bound pool line (no new secret).
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { logger } from "firebase-functions/v2"
import { PA_COLLECTIONS } from "@pa/core-types"
import { resolveCandidateIdentity } from "@pa/pa-persistence"
import { isCanaryUser } from "../claire-agent/canary.js"
import { sendImessage } from "../sendblue/sendblue-client.js"
import { issueConnectPhoneCode } from "./connect-phone-code.js"

type CallableAuth = {
  uid?: string
  token?: Record<string, unknown>
}

export interface ConnectPhoneStartInput {
  phoneE164?: string
}

export interface ConnectPhoneStartResult {
  ok: boolean
  reason?:
    | "no_phone_profile"
    | "not_enabled"
    | "send_failed"
    | "already_linked"
    | "invalid_phone"
  /** Coarse status the page shows; true → a code was texted. */
  codeSent?: boolean
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return undefined
  return trimmed
}

/** Loose E.164 normalize (digits + leading +). Identity hashing canonicalizes further. */
function normalizeE164(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/[\s()-]/g, "")
  if (/^\+?[1-9]\d{6,15}$/.test(trimmed)) {
    return trimmed.startsWith("+") ? trimmed : `+${trimmed}`
  }
  return undefined
}

export interface ConnectPhoneStartDeps {
  db: Firestore
  /** Resolve a web Firebase uid → its candidate id (pa-candidate-auth mapping). */
  resolveWebCandidateId: (firebaseUid: string) => Promise<string | null>
  /** Resolve a phone → an EXISTING candidate id (no create). */
  resolvePhoneCandidateId: (phoneE164: string) => Promise<string | null>
  isCanary: (userId: string) => boolean
  /** Issue a code + return the plaintext code to text. */
  issueCode: (args: {
    webFirebaseUid: string
    phoneCandidateId: string
    phoneE164: string
  }) => Promise<{ code: string }>
  /** Text the code to the candidate's thread on the bound pool line. */
  sendCode: (args: { phoneCandidateId: string; phoneE164: string; code: string }) => Promise<void>
  nowIso?: () => string
}

export async function runConnectPhoneStart(
  data: unknown,
  auth: CallableAuth | undefined,
  deps: ConnectPhoneStartDeps,
): Promise<ConnectPhoneStartResult> {
  const firebaseUid = cleanString(auth?.uid, 128)
  if (!firebaseUid) {
    throw new HttpsError("unauthenticated", "Sign in before connecting your phone.")
  }
  const email = cleanString(auth?.token?.email, 320)?.toLowerCase()
  if (!email || !email.includes("@")) {
    throw new HttpsError("failed-precondition", "Signed-in account has no verified email.")
  }
  if (auth?.token?.email_verified === false) {
    throw new HttpsError("failed-precondition", "Signed-in email is not verified.")
  }

  const input = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const phoneRaw = cleanString(input.phoneE164, 32)
  const phoneE164 = phoneRaw ? normalizeE164(phoneRaw) : undefined
  if (!phoneE164) return { ok: false, reason: "invalid_phone" }

  // Resolve the web session's candidate id.
  const webCandidateId = await deps.resolveWebCandidateId(firebaseUid)

  // Resolve the phone → an EXISTING phone candidate (never create).
  const phoneCandidateId = await deps.resolvePhoneCandidateId(phoneE164)
  if (!phoneCandidateId) {
    // The phone hasn't chatted with us — nothing to bind. No SMS, no leak.
    return { ok: false, reason: "no_phone_profile" }
  }

  // Already the same candidate → idempotent ok (nothing to verify).
  if (webCandidateId && webCandidateId === phoneCandidateId) {
    return { ok: true, reason: "already_linked", codeSent: false }
  }

  // Canary gate — new product behavior, dev phones only for now. Gate on the
  // RESOLVED phone candidate (the uid the code authorizes a bind to).
  if (!deps.isCanary(phoneCandidateId)) {
    return { ok: false, reason: "not_enabled" }
  }

  const { code } = await deps.issueCode({ webFirebaseUid: firebaseUid, phoneCandidateId, phoneE164 })
  try {
    await deps.sendCode({ phoneCandidateId, phoneE164, code })
  } catch (err) {
    logger.warn("connect_phone.send_failed", {
      err: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, reason: "send_failed" }
  }
  return { ok: true, codeSent: true }
}

/** Resolve a web Firebase uid → its candidate id via pa-candidate-auth. */
async function resolveWebCandidateId(db: Firestore, firebaseUid: string): Promise<string | null> {
  try {
    const snap = await db.collection(PA_COLLECTIONS.candidateAuth).doc(firebaseUid).get()
    if (!snap.exists) return null
    const data = (snap.data() ?? {}) as { candidateId?: unknown }
    return typeof data.candidateId === "string" && data.candidateId.trim() ? data.candidateId.trim() : null
  } catch {
    return null
  }
}

/** Resolve a phone → an EXISTING candidate id (resolve-only — never create). */
async function resolvePhoneCandidateId(db: Firestore, phoneE164: string): Promise<string | null> {
  try {
    const res = await resolveCandidateIdentity(db, {
      phoneE164,
      source: "candidate",
      mode: "resolve_only",
    })
    return res.outcome === "resolved_existing" ? res.candidateId : null
  } catch {
    return null
  }
}

function makeProdDeps(db: Firestore): ConnectPhoneStartDeps {
  return {
    db,
    resolveWebCandidateId: (uid) => resolveWebCandidateId(db, uid),
    resolvePhoneCandidateId: (phone) => resolvePhoneCandidateId(db, phone),
    isCanary: (userId) => isCanaryUser(userId),
    issueCode: async ({ webFirebaseUid, phoneCandidateId, phoneE164 }) => {
      const { code } = await issueConnectPhoneCode(db, { webFirebaseUid, phoneCandidateId, phoneE164 })
      return { code }
    },
    sendCode: async ({ phoneCandidateId, phoneE164, code }) => {
      await sendImessage({
        to: phoneE164,
        content:
          `Your WeKruit website code is ${code}. Enter it on the website to connect your phone ` +
          `(expires in 10 min). Didn't request this? Ignore this message.`,
        userId: phoneCandidateId,
        db,
        allowEnvFromNumberFallback: false,
      })
    },
  }
}

export const paCandidateConnectPhoneStart = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 30 },
  async (req): Promise<ConnectPhoneStartResult> => {
    return runConnectPhoneStart(req.data, req.auth, makeProdDeps(getFirestore()))
  },
)
