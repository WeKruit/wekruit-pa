/**
 * Cross-domain Single Sign-On for *.wekruit.com.
 *
 * Adam directive 2026-05-27 — users must stay signed in across every
 * wekruit.com subdomain. Firebase Auth's default `indexedDBLocalPersistence`
 * is scoped per browser origin, so a session on `candidate.wekruit.com` does
 * not carry to `www.wekruit.com` (or vice versa).
 *
 * Mechanism:
 *
 *   1. After any successful client-side sign-in (Google popup, email link,
 *      LinkedIn custom token, etc.) the client POSTs the fresh Firebase
 *      `idToken` to `paSsoLogin`. The CF verifies the token and asks
 *      `firebase-admin` to mint a session cookie, then writes it as
 *      `wkr_session` on `Domain=.wekruit.com` so every subdomain can read it.
 *
 *   2. On every other subdomain's app boot, the client calls `paSsoBootstrap`
 *      with `credentials: include`. The CF reads the shared cookie, verifies
 *      it (with revocation check), mints a fresh Firebase custom token bound
 *      to the same uid, and returns it. The client then calls
 *      `signInWithCustomToken` which writes a Firebase session into the new
 *      origin's IndexedDB. From that point forward the user is signed in on
 *      both origins with the same Firebase uid.
 *
 *   3. On sign-out the client calls `paSsoLogout` which clears the shared
 *      cookie. The next bootstrap attempt on any subdomain returns 401, so
 *      no other tab can restore the dead session.
 *
 * Security posture:
 *   - `wkr_session` is `HttpOnly` so XSS scripts cannot read or steal it.
 *   - `Secure` + `SameSite=Lax` blocks cross-site CSRF and downgrade attacks.
 *   - Cookie content is a Firebase session cookie (signed by Google Identity
 *     Platform) — not a raw idToken. Verification runs revocation check so
 *     disabled / deleted users lose access immediately.
 *   - Max-Age = 5 days (Firebase's recommended ceiling for session cookies).
 *   - All three handlers reject every Origin not in `ALLOWED_ORIGINS` so a
 *     malicious site cannot trigger cookie issuance or read the bootstrap
 *     response. Wildcard CORS is intentionally not used.
 */
import { onRequest, type HttpsOptions } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getAuth as getAdminAuth } from "firebase-admin/auth"
import { getApps, initializeApp } from "firebase-admin/app"

// firebase-functions v2 does not re-export the Express Request/Response types
// it hands to onRequest handlers, so we describe the minimal shape we use.
export interface SsoRequestLike {
  method: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
}

export interface SsoResponseLike {
  setHeader(name: string, value: string | string[]): void
  status(code: number): SsoResponseLike
  send(body?: unknown): SsoResponseLike
  json(body: unknown): SsoResponseLike
}

if (!getApps().length) initializeApp()

// ---------------------------------------------------------------- constants

export const SSO_COOKIE_NAME = "wkr_session"
export const SSO_COOKIE_DOMAIN = ".wekruit.com"
// 5 days — Firebase Identity Platform's recommended ceiling for session cookies.
export const SSO_COOKIE_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000

export const SSO_ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  "https://wekruit.com",
  "https://www.wekruit.com",
  "https://candidate.wekruit.com",
  "https://pa.wekruit.com",
  "https://layoff.wekruit.com",
  "https://wekruit-pa-landing.web.app",
  "https://wekruit-pa-landing.firebaseapp.com",
  "https://wekruit-pa.web.app",
  "https://wekruit-pa.firebaseapp.com",
  "https://layoff-wekruit.web.app",
  "https://layoff-wekruit.firebaseapp.com",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
])

const HTTP_OPTS: HttpsOptions = {
  region: "us-central1",
  invoker: "public",
  // CORS handled manually — firebase-functions v2 onRequest `cors` option does
  // not support per-origin Access-Control-Allow-Credentials.
}

// ------------------------------------------------------------------ helpers

/** Set per-origin CORS headers. Returns false if the request was preflight (already handled). */
export function applySsoCors(
  req: Pick<SsoRequestLike, "headers" | "method">,
  res: Pick<SsoResponseLike, "setHeader" | "status" | "send">,
  allowedOrigins: ReadonlySet<string> = SSO_ALLOWED_ORIGINS,
): boolean {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : ""
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
    res.setHeader("Access-Control-Allow-Credentials", "true")
    res.setHeader("Vary", "Origin")
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
  res.setHeader("Access-Control-Max-Age", "86400")
  if (req.method === "OPTIONS") {
    res.status(204).send("")
    return false
  }
  return true
}

export function parseCookieHeader(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=")
    if (rawKey === name) return rest.join("=")
  }
  return null
}

export function buildSetCookieHeader(value: string, maxAgeSeconds: number): string {
  return `${SSO_COOKIE_NAME}=${value}; Domain=${SSO_COOKIE_DOMAIN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`
}

// --------------------------------------------------- handler dependency types

export interface SsoAdmin {
  verifyIdToken(idToken: string, checkRevoked?: boolean): Promise<{ uid: string }>
  createSessionCookie(idToken: string, opts: { expiresIn: number }): Promise<string>
  verifySessionCookie(cookie: string, checkRevoked?: boolean): Promise<{ uid: string }>
  createCustomToken(uid: string): Promise<string>
}

function liveAdmin(): SsoAdmin {
  const a = getAdminAuth()
  return {
    verifyIdToken: (idToken, checkRevoked) => a.verifyIdToken(idToken, checkRevoked),
    createSessionCookie: (idToken, opts) => a.createSessionCookie(idToken, opts),
    verifySessionCookie: (cookie, checkRevoked) => a.verifySessionCookie(cookie, checkRevoked),
    createCustomToken: (uid) => a.createCustomToken(uid),
  }
}

// ---------------------------------------------------------------- handlers

export async function handleSsoLogin(
  req: Pick<SsoRequestLike, "method" | "headers" | "body">,
  res: Pick<SsoResponseLike, "setHeader" | "status" | "send"> & { json?: (body: unknown) => void },
  deps: { admin: SsoAdmin; allowedOrigins?: ReadonlySet<string> } = { admin: liveAdmin() },
): Promise<void> {
  if (!applySsoCors(req, res, deps.allowedOrigins)) return
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed")
    return
  }
  const body = (req.body ?? {}) as { idToken?: unknown }
  const idToken = typeof body.idToken === "string" ? body.idToken : ""
  if (!idToken) {
    res.status(400).send("missing idToken")
    return
  }
  try {
    const decoded = await deps.admin.verifyIdToken(idToken, true)
    const sessionCookie = await deps.admin.createSessionCookie(idToken, {
      expiresIn: SSO_COOKIE_MAX_AGE_MS,
    })
    res.setHeader("Set-Cookie", [
      buildSetCookieHeader(sessionCookie, Math.floor(SSO_COOKIE_MAX_AGE_MS / 1000)),
    ])
    logger.info("paSsoLogin issued cookie", { uid: decoded.uid })
    res.status(204).send("")
  } catch (err) {
    logger.warn("paSsoLogin verify failed", { err: (err as Error).message })
    res.status(401).send("invalid id token")
  }
}

export async function handleSsoBootstrap(
  req: Pick<SsoRequestLike, "method" | "headers">,
  res: Pick<SsoResponseLike, "setHeader" | "status" | "send" | "json">,
  deps: { admin: SsoAdmin; allowedOrigins?: ReadonlySet<string> } = { admin: liveAdmin() },
): Promise<void> {
  if (!applySsoCors(req, res, deps.allowedOrigins)) return
  if (req.method !== "GET") {
    res.status(405).send("Method not allowed")
    return
  }
  const cookieHeader = typeof req.headers.cookie === "string" ? req.headers.cookie : undefined
  const cookie = parseCookieHeader(cookieHeader, SSO_COOKIE_NAME)
  if (!cookie) {
    res.status(401).json({ error: "no_session" })
    return
  }
  try {
    const decoded = await deps.admin.verifySessionCookie(cookie, true)
    const customToken = await deps.admin.createCustomToken(decoded.uid)
    res.status(200).json({ customToken })
  } catch (err) {
    logger.info("paSsoBootstrap invalid cookie", { err: (err as Error).message })
    // Clear the bad cookie so the client stops retrying it on every refresh.
    res.setHeader("Set-Cookie", [buildSetCookieHeader("", 0)])
    res.status(401).json({ error: "invalid_session" })
  }
}

export async function handleSsoLogout(
  req: Pick<SsoRequestLike, "method" | "headers">,
  res: Pick<SsoResponseLike, "setHeader" | "status" | "send">,
  deps: { allowedOrigins?: ReadonlySet<string> } = {},
): Promise<void> {
  if (!applySsoCors(req, res, deps.allowedOrigins)) return
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed")
    return
  }
  res.setHeader("Set-Cookie", [buildSetCookieHeader("", 0)])
  res.status(204).send("")
}

// ---------------------------------------------------------------- exports

export const paSsoLogin = onRequest(HTTP_OPTS, async (req, res) => {
  await handleSsoLogin(req, res)
})

export const paSsoBootstrap = onRequest(HTTP_OPTS, async (req, res) => {
  await handleSsoBootstrap(req, res)
})

export const paSsoLogout = onRequest(HTTP_OPTS, async (req, res) => {
  await handleSsoLogout(req, res)
})
