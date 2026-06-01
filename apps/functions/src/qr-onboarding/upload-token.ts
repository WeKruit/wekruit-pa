/**
 * upload-token.ts — single-use tokenized resume-upload links for an UNAUTH
 * candidate (the QR / iMessage-first path has no web account yet).
 *
 * Flow (doc §5 / N9):
 *   1. Onboarding texts the candidate a link `https://wekruit.com/upload?token=<t>`.
 *   2. The candidate opens it on the same surface that posts to paPublicCvIngest.
 *   3. The CV-ingest endpoint resolves token -> userId server-side (no Firebase ID
 *      token needed) and ingests the resume for THAT userId only.
 *
 * Tokens are opaque, single-use, time-boxed. The doc id IS the token; the doc maps
 * token -> userId. `verifyCvUploadToken` enforces existence + not-expired + not-used.
 */
import type { Firestore } from "firebase-admin/firestore"
import { randomBytes } from "node:crypto"
import { PA_COLLECTIONS } from "@pa/core-types"

/** Upload tokens are valid for 30 days (resume is OPTIONAL FOREVER — generous window). */
export const CV_UPLOAD_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface CvUploadTokenDoc {
  token: string
  userId: string
  createdAt: string
  expiresAt: string
  usedAt?: string
}

/** Mint a fresh URL-safe upload token. */
export function mintCvUploadToken(): string {
  return randomBytes(24).toString("base64url")
}

/**
 * Issue (create) a single-use upload token for `userId`. Returns the token string.
 * Reissues a fresh token each call — the link is cheap and the candidate may lose
 * the old text.
 */
export async function issueCvUploadToken(
  db: Firestore,
  userId: string,
  now: number = Date.now()
): Promise<string> {
  const token = mintCvUploadToken()
  const doc: CvUploadTokenDoc = {
    token,
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CV_UPLOAD_TOKEN_TTL_MS).toISOString(),
  }
  await db.collection(PA_COLLECTIONS.cvUploadTokens).doc(token).set(doc)
  return token
}

export type VerifyCvUploadTokenResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "missing_token" | "unknown_token" | "token_expired" | "token_used" }

/**
 * Resolve an upload token to its userId. Validates existence, expiry, and single-use.
 * Pure read — does NOT mark used (the caller marks used only after a successful
 * ingest, so a transient failure leaves the link reusable).
 */
export async function verifyCvUploadToken(
  db: Firestore,
  token: string | undefined,
  now: number = Date.now()
): Promise<VerifyCvUploadTokenResult> {
  const t = typeof token === "string" ? token.trim() : ""
  if (!t) return { ok: false, reason: "missing_token" }
  const snap = await db.collection(PA_COLLECTIONS.cvUploadTokens).doc(t).get()
  if (!snap.exists) return { ok: false, reason: "unknown_token" }
  const data = snap.data() as CvUploadTokenDoc
  if (data.usedAt) return { ok: false, reason: "token_used" }
  const expiresAt = Date.parse(data.expiresAt)
  if (Number.isFinite(expiresAt) && now > expiresAt) return { ok: false, reason: "token_expired" }
  if (!data.userId) return { ok: false, reason: "unknown_token" }
  return { ok: true, userId: data.userId }
}

/** Canonical candidate-facing base for the resume-upload link. */
export const CV_UPLOAD_LINK_BASE = "https://wekruit.com/upload"

/** Build the candidate-facing upload URL for a token. */
export function buildCvUploadLink(token: string): string {
  return `${CV_UPLOAD_LINK_BASE}?token=${encodeURIComponent(token)}`
}

/**
 * Return a ready-to-send upload link for `userId`, REUSING an existing unused +
 * unexpired token when one exists (so a multi-turn onboarding doesn't mint a new
 * token every turn). Issues a fresh one otherwise. Best-effort — returns null on
 * any failure so the caller simply omits the nudge (résumé is optional forever).
 */
export async function getOrIssueCvUploadLink(
  db: Firestore,
  userId: string,
  now: number = Date.now()
): Promise<string | null> {
  try {
    const existing = await db
      .collection(PA_COLLECTIONS.cvUploadTokens)
      .where("userId", "==", userId)
      .limit(10)
      .get()
    for (const docSnap of existing.docs) {
      const data = docSnap.data() as CvUploadTokenDoc
      if (data.usedAt) continue
      const expiresAt = Date.parse(data.expiresAt)
      if (Number.isFinite(expiresAt) && now > expiresAt) continue
      if (data.token) return buildCvUploadLink(data.token)
    }
    const token = await issueCvUploadToken(db, userId, now)
    return buildCvUploadLink(token)
  } catch {
    return null
  }
}

/** Mark a token used (single-use) after a successful ingest. Best-effort. */
export async function markCvUploadTokenUsed(
  db: Firestore,
  token: string,
  now: number = Date.now()
): Promise<void> {
  const t = token.trim()
  if (!t) return
  await db
    .collection(PA_COLLECTIONS.cvUploadTokens)
    .doc(t)
    .set({ usedAt: new Date(now).toISOString() }, { merge: true })
}
