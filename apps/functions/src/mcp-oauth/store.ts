/**
 * mcp-oauth/store.ts — Firestore persistence for the MCP authorization server.
 *
 * Three short-lived record types, deliberately separate collections so a TTL policy or a manual
 * purge can target one without touching the others:
 *   pa-mcp-oauth-clients — dynamically registered clients (RFC 7591). Public clients only.
 *   pa-mcp-oauth-codes   — authorization codes. Single-use, 60s.
 *   pa-mcp-oauth-tokens  — issued access tokens, stored HASHED.
 *
 * SECRETS ARE NEVER STORED IN THE CLEAR. Codes and access tokens are kept as SHA-256 digests, so
 * a read of this collection — a leaked backup, an over-broad console session — yields nothing that
 * can be replayed. This matters more than usual here: a token minted by this server grants the
 * full internal operator surface.
 */
import type { Firestore } from "firebase-admin/firestore"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

export const CLIENTS = "pa-mcp-oauth-clients"
export const CODES = "pa-mcp-oauth-codes"
export const TOKENS = "pa-mcp-oauth-tokens"

/** Authorization codes live only long enough to be redeemed by a redirect that just fired. */
export const CODE_TTL_MS = 60_000
/**
 * 30 days.
 *
 * Started at 8h on the reasoning that short-lived beats convenient against admin tooling. In
 * practice this server has TWO internal users and no refresh-token flow, so an 8h token meant a
 * browser round-trip every working day for a tool people reach for a few times a week — friction
 * that pushes everyone back to sharing the long-lived static bearer instead, which is strictly
 * worse. A month-long token that nobody works around beats a daily one that everybody does.
 *
 * The tradeoff is a longer window if a token leaks. Mitigated by: tokens are stored hashed and are
 * never logged; the value only ever exists in the client's own config; and revocation is a single
 * doc delete from `pa-mcp-oauth-tokens` (keyed by SHA-256 of the token). Revisit if this server
 * ever serves more than a handful of operators, or gains a refresh flow that makes short TTLs free.
 */
export const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/** Base64url of 32 random bytes — the only place a bearer value exists in the clear. */
export function randomSecret(): string {
  return randomBytes(32).toString("base64url")
}

/** Constant-time compare so a wrong guess leaks nothing through timing. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export interface OAuthClient {
  clientId: string
  redirectUris: string[]
  clientName?: string
  createdAt: string
}

export interface AuthCodeRecord {
  clientId: string
  redirectUri: string
  codeChallenge: string
  principalUid: string
  expiresAt: string
  createdAt: string
}

export async function saveClient(db: Firestore, client: OAuthClient): Promise<void> {
  await db.collection(CLIENTS).doc(client.clientId).set(client)
}

export async function getClient(db: Firestore, clientId: string): Promise<OAuthClient | undefined> {
  const snap = await db.collection(CLIENTS).doc(clientId).get()
  return snap.exists ? (snap.data() as OAuthClient) : undefined
}

export async function saveAuthCode(db: Firestore, code: string, record: AuthCodeRecord): Promise<void> {
  await db.collection(CODES).doc(sha256(code)).set(record)
}

/**
 * Redeem in one shot: read, delete, then validate.
 *
 * Deleting BEFORE validating is deliberate. A code is single-use by definition, and an attacker
 * who can replay one gets unlimited attempts at the PKCE verifier if a failed exchange leaves it
 * alive. Burning it on first touch makes every replay a miss regardless of why the first failed.
 */
export async function consumeAuthCode(
  db: Firestore,
  code: string,
  nowMs: number,
): Promise<AuthCodeRecord | undefined> {
  const ref = db.collection(CODES).doc(sha256(code))
  const snap = await ref.get()
  if (!snap.exists) return undefined
  await ref.delete()
  const rec = snap.data() as AuthCodeRecord
  if (Date.parse(rec.expiresAt) <= nowMs) return undefined
  return rec
}

export async function saveAccessToken(
  db: Firestore,
  token: string,
  data: { clientId: string; principalUid: string; expiresAt: string; createdAt: string },
): Promise<void> {
  await db.collection(TOKENS).doc(sha256(token)).set(data)
}

export async function lookupAccessToken(
  db: Firestore,
  token: string,
  nowMs: number,
): Promise<{ clientId: string; principalUid: string } | undefined> {
  const snap = await db.collection(TOKENS).doc(sha256(token)).get()
  if (!snap.exists) return undefined
  const d = snap.data() as { principalUid: string; clientId: string; expiresAt: string }
  if (Date.parse(d.expiresAt) <= nowMs) return undefined
  return { clientId: d.clientId, principalUid: d.principalUid }
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) === challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier).digest("base64url")
  return safeEqual(computed, challenge)
}
