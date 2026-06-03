/**
 * connect-token.ts — single-use tokenized LinkedIn one-tap connect links for
 * an UNAUTH candidate (the QR / iMessage-first path has no web account yet).
 *
 * Flow (mirror of qr-onboarding/upload-token.ts):
 *   1. Claire (thin) texts the candidate a link
 *      `https://candidate.wekruit.com/connect-linkedin?token=<t>`.
 *   2. The candidate opens it, confirms/submits their LinkedIn profile URL.
 *   3. The connect CF (`paLinkedinConnectSubmit`) resolves token -> userId
 *      server-side (no Firebase ID token needed) and enriches THAT userId only,
 *      then returns an `sms:` reroute body the page redirects to.
 *
 * Tokens are opaque, single-use, time-boxed. The doc id IS the token; the doc
 * maps token -> userId. `verifyLinkedinConnectToken` enforces existence +
 * not-expired + not-used. The token doc additionally carries the candidate's
 * E.164 phone so the connect CF can build the `sms:<number>?body=...` reroute
 * back into the candidate's existing iMessage thread.
 */
import type { Firestore } from "firebase-admin/firestore"
import { randomBytes } from "node:crypto"
import { PA_COLLECTIONS } from "@pa/core-types"

/** Connect tokens are valid for 30 days (generous — links may sit in a text). */
export const LINKEDIN_CONNECT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Canonical candidate-facing base for the LinkedIn connect link (C-end domain). */
export const LINKEDIN_CONNECT_LINK_BASE = "https://candidate.wekruit.com/connect-linkedin"

export interface LinkedinConnectTokenDoc {
  token: string
  userId: string
  /** Candidate E.164 phone — used to build the sms: reroute back to the thread. */
  phoneE164?: string
  createdAt: string
  expiresAt: string
  usedAt?: string
}

/** Mint a fresh URL-safe connect token. */
export function mintLinkedinConnectToken(): string {
  return randomBytes(24).toString("base64url")
}

/**
 * Issue (create) a single-use connect token for `userId`. Returns the token.
 * Reissues a fresh token each call — the link is cheap and the candidate may
 * lose the old text.
 */
export async function issueLinkedinConnectToken(
  db: Firestore,
  userId: string,
  phoneE164?: string,
  now: number = Date.now(),
): Promise<string> {
  const token = mintLinkedinConnectToken()
  const doc: LinkedinConnectTokenDoc = {
    token,
    userId,
    ...(phoneE164 && phoneE164.trim() ? { phoneE164: phoneE164.trim() } : {}),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LINKEDIN_CONNECT_TOKEN_TTL_MS).toISOString(),
  }
  await db.collection(PA_COLLECTIONS.linkedinConnectTokens).doc(token).set(doc)
  return token
}

export type VerifyLinkedinConnectTokenResult =
  | { ok: true; userId: string; phoneE164?: string }
  | { ok: false; reason: "missing_token" | "unknown_token" | "token_expired" | "token_used" }

/**
 * Resolve a connect token to its userId (+ phone). Validates existence,
 * expiry, and single-use. Pure read — does NOT mark used (the caller marks
 * used only after a successful submit, so a transient failure leaves the link
 * reusable).
 */
export async function verifyLinkedinConnectToken(
  db: Firestore,
  token: string | undefined,
  now: number = Date.now(),
): Promise<VerifyLinkedinConnectTokenResult> {
  const t = typeof token === "string" ? token.trim() : ""
  if (!t) return { ok: false, reason: "missing_token" }
  const snap = await db.collection(PA_COLLECTIONS.linkedinConnectTokens).doc(t).get()
  if (!snap.exists) return { ok: false, reason: "unknown_token" }
  const data = snap.data() as LinkedinConnectTokenDoc
  if (data.usedAt) return { ok: false, reason: "token_used" }
  const expiresAt = Date.parse(data.expiresAt)
  if (Number.isFinite(expiresAt) && now > expiresAt) return { ok: false, reason: "token_expired" }
  if (!data.userId) return { ok: false, reason: "unknown_token" }
  return {
    ok: true,
    userId: data.userId,
    ...(typeof data.phoneE164 === "string" && data.phoneE164.trim()
      ? { phoneE164: data.phoneE164.trim() }
      : {}),
  }
}

/** Build the candidate-facing connect URL for a token. */
export function buildConnectLinkedinLink(token: string): string {
  return `${LINKEDIN_CONNECT_LINK_BASE}?token=${encodeURIComponent(token)}`
}

/**
 * Return a ready-to-send connect link for `userId`, REUSING an existing
 * unused + unexpired token when one exists (so a multi-turn conversation
 * doesn't mint a new token every turn). Issues a fresh one otherwise.
 * Best-effort — returns null on any failure so the caller can omit the nudge.
 */
export async function getOrIssueLinkedinConnectLink(
  db: Firestore,
  userId: string,
  phoneE164?: string,
  now: number = Date.now(),
): Promise<string | null> {
  try {
    const existing = await db
      .collection(PA_COLLECTIONS.linkedinConnectTokens)
      .where("userId", "==", userId)
      .limit(10)
      .get()
    for (const docSnap of existing.docs) {
      const data = docSnap.data() as LinkedinConnectTokenDoc
      if (data.usedAt) continue
      const expiresAt = Date.parse(data.expiresAt)
      if (Number.isFinite(expiresAt) && now > expiresAt) continue
      if (data.token) return buildConnectLinkedinLink(data.token)
    }
    const token = await issueLinkedinConnectToken(db, userId, phoneE164, now)
    return buildConnectLinkedinLink(token)
  } catch {
    return null
  }
}

/** Mark a token used (single-use) after a successful submit. Best-effort. */
export async function markLinkedinConnectTokenUsed(
  db: Firestore,
  token: string,
  now: number = Date.now(),
): Promise<void> {
  const t = token.trim()
  if (!t) return
  await db
    .collection(PA_COLLECTIONS.linkedinConnectTokens)
    .doc(t)
    .set({ usedAt: new Date(now).toISOString() }, { merge: true })
}
