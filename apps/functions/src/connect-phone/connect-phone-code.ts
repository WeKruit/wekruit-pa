/**
 * connect-phone-code.ts — WS-3(a) single-use short verification codes for the
 * PHONE-FIRST → WEBSITE bind ("I've chatted on phone, then verification code").
 *
 * This is the INVERSE of the QR opener (which binds website → phone). A
 * web-authed candidate who already chatted on iMessage requests a 6-digit code;
 * it's texted to their existing thread on the bound pool line; entering it on
 * the website links the web session to the phone-resolved pa-users/{uid}.
 *
 * Mirror of linkedin-connect/connect-token.ts, with these differences:
 *   - The DOC ID is a RANDOM opaque token (never the code, never raw PII).
 *   - The 6-digit code is stored ONLY as a sha256 hash (the doc never holds the
 *     plaintext code — a Firestore read can't reveal it).
 *   - Single outstanding code per `webFirebaseUid` (issuing a new one supersedes
 *     the prior). 10-minute TTL. Attempt cap 5 (then the code is dead).
 *
 * Server-only: pa-connect-phone-codes has NO firestore.rules entry → default-deny
 * → Admin SDK only.
 */
import type { Firestore } from "firebase-admin/firestore"
import { createHash, randomBytes, randomInt } from "node:crypto"
import { PA_COLLECTIONS } from "@pa/core-types"

/** Codes are valid for 10 minutes (a texted code is entered promptly). */
export const CONNECT_PHONE_CODE_TTL_MS = 10 * 60 * 1000

/** Max wrong-code attempts before the code is burned (brute-force guard over 1e6 space). */
export const CONNECT_PHONE_CODE_MAX_ATTEMPTS = 5

export interface ConnectPhoneCodeDoc {
  /** Random opaque doc id (NOT the code). */
  token: string
  /** The web-session Firebase uid that requested the bind. */
  webFirebaseUid: string
  /** The phone-resolved candidate the web session will link to. */
  phoneCandidateId: string
  /** sha256(code) — the plaintext 6-digit code is NEVER stored. */
  codeHash: string
  /** Candidate E.164 (telemetry / re-send only; not an identity doc id). */
  phoneE164?: string
  attempts: number
  createdAt: string
  expiresAt: string
  usedAt?: string
}

/** Mint a random opaque doc-id token. */
function mintToken(): string {
  return randomBytes(24).toString("base64url")
}

/** Generate a zero-padded 6-digit code (cryptographically uniform). */
export function generateConnectPhoneCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0")
}

/** sha256 of a normalized (trimmed) code. */
export function hashConnectPhoneCode(code: string): string {
  return createHash("sha256").update(code.trim()).digest("hex")
}

/**
 * Issue a fresh code for (webFirebaseUid → phoneCandidateId). Supersedes any
 * outstanding code for the same webFirebaseUid (best-effort cleanup). Returns
 * the plaintext code (caller texts it) + the doc token (caller does NOT expose
 * it). The doc stores only the hash.
 */
export async function issueConnectPhoneCode(
  db: Firestore,
  args: {
    webFirebaseUid: string
    phoneCandidateId: string
    phoneE164?: string
  },
  now: number = Date.now(),
): Promise<{ code: string; token: string }> {
  // Supersede prior outstanding codes for this web uid (single outstanding code).
  try {
    const prior = await db
      .collection(PA_COLLECTIONS.connectPhoneCodes)
      .where("webFirebaseUid", "==", args.webFirebaseUid)
      .limit(10)
      .get()
    await Promise.all(
      prior.docs
        .filter((d) => !(d.data() as ConnectPhoneCodeDoc).usedAt)
        .map((d) => d.ref.set({ usedAt: new Date(now).toISOString() }, { merge: true })),
    )
  } catch {
    /* best-effort supersede — a stale prior code still expires on its own TTL */
  }

  const code = generateConnectPhoneCode()
  const token = mintToken()
  const doc: ConnectPhoneCodeDoc = {
    token,
    webFirebaseUid: args.webFirebaseUid,
    phoneCandidateId: args.phoneCandidateId,
    codeHash: hashConnectPhoneCode(code),
    ...(args.phoneE164 && args.phoneE164.trim() ? { phoneE164: args.phoneE164.trim() } : {}),
    attempts: 0,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CONNECT_PHONE_CODE_TTL_MS).toISOString(),
  }
  await db.collection(PA_COLLECTIONS.connectPhoneCodes).doc(token).set(doc)
  return { code, token }
}

export type VerifyConnectPhoneCodeResult =
  | { ok: true; phoneCandidateId: string; webFirebaseUid: string }
  | {
      ok: false
      reason: "no_outstanding_code" | "code_expired" | "code_used" | "too_many_attempts" | "code_mismatch"
    }

/**
 * Verify the latest outstanding code for `webFirebaseUid` against the submitted
 * code. On a match: marks the doc used (single-use) and returns the phone
 * candidate id to link. On a mismatch: increments attempts and burns the code at
 * the cap. Never throws (read/write errors degrade to a generic mismatch so the
 * web caller surfaces "wrong code" rather than a 500).
 */
export async function verifyConnectPhoneCode(
  db: Firestore,
  args: { webFirebaseUid: string; code: string },
  now: number = Date.now(),
): Promise<VerifyConnectPhoneCodeResult> {
  try {
    const snap = await db
      .collection(PA_COLLECTIONS.connectPhoneCodes)
      .where("webFirebaseUid", "==", args.webFirebaseUid)
      .limit(10)
      .get()
    // Pick the newest unused code for this web uid.
    const candidates = snap.docs
      .map((d) => ({ ref: d.ref, data: d.data() as ConnectPhoneCodeDoc }))
      .filter((d) => !d.data.usedAt)
      .sort((a, b) => (a.data.createdAt < b.data.createdAt ? 1 : -1))
    const latest = candidates[0]
    if (!latest) return { ok: false, reason: "no_outstanding_code" }

    const expiresAt = Date.parse(latest.data.expiresAt)
    if (Number.isFinite(expiresAt) && now > expiresAt) {
      return { ok: false, reason: "code_expired" }
    }
    if ((latest.data.attempts ?? 0) >= CONNECT_PHONE_CODE_MAX_ATTEMPTS) {
      return { ok: false, reason: "too_many_attempts" }
    }

    const matches = hashConnectPhoneCode(args.code) === latest.data.codeHash
    if (!matches) {
      const attempts = (latest.data.attempts ?? 0) + 1
      const burn = attempts >= CONNECT_PHONE_CODE_MAX_ATTEMPTS
      await latest.ref.set(
        { attempts, ...(burn ? { usedAt: new Date(now).toISOString() } : {}) },
        { merge: true },
      )
      return { ok: false, reason: burn ? "too_many_attempts" : "code_mismatch" }
    }

    // Match → single-use burn.
    await latest.ref.set({ usedAt: new Date(now).toISOString() }, { merge: true })
    return {
      ok: true,
      phoneCandidateId: latest.data.phoneCandidateId,
      webFirebaseUid: latest.data.webFirebaseUid,
    }
  } catch {
    return { ok: false, reason: "code_mismatch" }
  }
}
