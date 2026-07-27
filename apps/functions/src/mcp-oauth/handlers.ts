/**
 * mcp-oauth/handlers.ts — the OAuth 2.1 authorization server that lets an MCP client which can
 * only speak OAuth (the claude.ai / Cowork connector) reach `paHeadhunterMcp`.
 *
 * WHY THIS EXISTS. Measured against the live endpoint 2026-07-27: an unauthenticated POST returned
 * a bare 401 with no `WWW-Authenticate`, and both spec-required discovery documents 404'd — so the
 * connector had nothing to bind to. The static `PA_ADMIN_TOKEN` bearer stays for Claude Code; this
 * adds the discovery + code-exchange path beside it.
 *
 * SCOPE, DELIBERATELY SMALL. This mints tokens for the FULL internal operator surface, so every
 * addition here widens a blast radius:
 *   - authorization_code + PKCE S256 ONLY. No implicit, no password grant, no client_credentials.
 *   - Public clients only; no client secret to leak, PKCE carries the proof.
 *   - No refresh tokens. An 8h access token means one re-auth a day, which is a fair price for not
 *     operating long-lived refresh material against admin tooling.
 *   - The human gate at /authorize is the SAME credential the admin callables already accept, so
 *     this creates no new trust root — it cannot grant what an admin could not already do.
 */
import type { Firestore } from "firebase-admin/firestore"
import { getAuth } from "firebase-admin/auth"
import {
  ACCESS_TOKEN_TTL_MS,
  CODE_TTL_MS,
  consumeAuthCode,
  getClient,
  randomSecret,
  safeEqual,
  saveAccessToken,
  saveAuthCode,
  saveClient,
  verifyPkceS256,
} from "./store.js"

export interface OAuthDeps {
  db: Firestore
  /** Public origin the metadata advertises, e.g. https://wekruit-pa.web.app — no trailing slash. */
  issuer: string
  /** The MCP endpoint this authorization server protects. */
  resource: string
  adminToken: string | null
  now?: () => number
}

export interface HttpResult {
  status: number
  headers?: Record<string, string>
  json?: unknown
  html?: string
  redirect?: string
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
/** The consent page handles a credential: never framed, never sniffed, never referred onward. */
const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
}

function err(status: number, error: string, description?: string): HttpResult {
  return { status, headers: JSON_HEADERS, json: { error, ...(description ? { error_description: description } : {}) } }
}

export function authorizationServerMetadata(deps: OAuthDeps): HttpResult {
  return {
    status: 200,
    headers: JSON_HEADERS,
    json: {
      issuer: deps.issuer,
      authorization_endpoint: `${deps.issuer}/oauth/authorize`,
      token_endpoint: `${deps.issuer}/oauth/token`,
      registration_endpoint: `${deps.issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    },
  }
}

export function protectedResourceMetadata(deps: OAuthDeps): HttpResult {
  return {
    status: 200,
    headers: JSON_HEADERS,
    json: {
      resource: deps.resource,
      authorization_servers: [deps.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    },
  }
}

/**
 * RFC 7591 dynamic client registration.
 *
 * Open registration is what makes the connector's one-click flow work, and it is safe ONLY because
 * a client_id alone grants nothing: every token still requires a human to pass the admin gate at
 * /authorize. Registering is closer to reserving a name than to being trusted.
 */
export async function registerClient(deps: OAuthDeps, body: unknown): Promise<HttpResult> {
  const b = (body ?? {}) as Record<string, unknown>
  const redirectUris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map((u) => String(u)) : []
  if (redirectUris.length === 0) return err(400, "invalid_redirect_uri", "redirect_uris is required")
  for (const uri of redirectUris) {
    let parsed: URL
    try {
      parsed = new URL(uri)
    } catch {
      return err(400, "invalid_redirect_uri", `not a URL: ${uri}`)
    }
    // An http:// callback would put the code on the wire in the clear. localhost is exempt because
    // it never leaves the machine and desktop clients need it.
    const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1"
    if (parsed.protocol !== "https:" && !isLoopback) {
      return err(400, "invalid_redirect_uri", `redirect_uri must be https (or loopback): ${uri}`)
    }
  }
  const clientId = randomSecret()
  const createdAt = new Date(deps.now?.() ?? Date.now()).toISOString()
  await saveClient(deps.db, {
    clientId,
    redirectUris,
    ...(typeof b.client_name === "string" ? { clientName: b.client_name.slice(0, 200) } : {}),
    createdAt,
  })
  return {
    status: 201,
    headers: JSON_HEADERS,
    json: {
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(Date.parse(createdAt) / 1000),
    },
  }
}

interface AuthorizeParams {
  client_id?: string
  redirect_uri?: string
  response_type?: string
  code_challenge?: string
  code_challenge_method?: string
  state?: string
}

/**
 * Validate an /authorize request BEFORE anything is rendered or redirected.
 *
 * Errors split two ways on purpose (RFC 6749 §4.1.2.1): a bad client_id or redirect_uri is shown
 * to the human, because redirecting to an unverified URI is how you hand an attacker the code.
 * Everything after those two is safe to report via the redirect.
 */
async function validateAuthorize(
  deps: OAuthDeps,
  p: AuthorizeParams,
): Promise<{ ok: true; redirectUri: string } | { ok: false; result: HttpResult }> {
  const clientId = String(p.client_id ?? "")
  const redirectUri = String(p.redirect_uri ?? "")
  if (!clientId) return { ok: false, result: err(400, "invalid_request", "client_id is required") }
  const client = await getClient(deps.db, clientId)
  if (!client) return { ok: false, result: err(400, "invalid_client", "unknown client_id") }
  // Exact match only: prefix/substring matching on redirect URIs is a classic code-interception bug.
  if (!client.redirectUris.some((u) => safeEqual(u, redirectUri))) {
    return { ok: false, result: err(400, "invalid_request", "redirect_uri does not match a registered URI") }
  }
  if (String(p.response_type ?? "") !== "code") {
    return { ok: false, result: redirectErr(redirectUri, "unsupported_response_type", p.state) }
  }
  if (String(p.code_challenge_method ?? "") !== "S256" || !String(p.code_challenge ?? "")) {
    return { ok: false, result: redirectErr(redirectUri, "invalid_request", p.state, "PKCE S256 is required") }
  }
  return { ok: true, redirectUri }
}

function redirectErr(redirectUri: string, error: string, state?: string, description?: string): HttpResult {
  const u = new URL(redirectUri)
  u.searchParams.set("error", error)
  if (description) u.searchParams.set("error_description", description)
  if (state) u.searchParams.set("state", state)
  return { status: 302, headers: { location: u.toString(), "cache-control": "no-store" }, redirect: u.toString() }
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c)

/** The consent screen. Deliberately plain — it exists to gate, not to market. */
export async function authorizeGet(deps: OAuthDeps, p: AuthorizeParams): Promise<HttpResult> {
  const v = await validateAuthorize(deps, p)
  if (!v.ok) return v.result
  const hidden = (["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state"] as const)
    .filter((k) => p[k])
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(String(p[k]))}">`)
    .join("\n      ")
  return {
    status: 200,
    headers: HTML_HEADERS,
    html: `<!doctype html><meta charset="utf-8"><title>Connect to WeKruit</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:30rem;margin:12vh auto;padding:0 1.25rem;color:#111}
  @media(prefers-color-scheme:dark){body{background:#111;color:#eee}input{background:#1c1c1c;color:#eee;border-color:#444}}
  h1{font-size:1.15rem;margin:0 0 .35rem}p{color:#666;margin:.35rem 0 1.25rem}
  @media(prefers-color-scheme:dark){p{color:#999}}
  input,button{width:100%;box-sizing:border-box;padding:.65rem .75rem;font-size:1rem;border-radius:.5rem;border:1px solid #ccc}
  button{margin-top:.75rem;background:#111;color:#fff;border:0;cursor:pointer}
  @media(prefers-color-scheme:dark){button{background:#eee;color:#111}}
  .warn{font-size:.82rem;color:#8a6d00;background:#fff8e1;padding:.6rem .75rem;border-radius:.5rem;margin-top:1.25rem}
  @media(prefers-color-scheme:dark){.warn{background:#2a2410;color:#d9b310}}
</style>
<h1>Connect to WeKruit</h1>
<p>This grants the internal operator toolset — candidate data included. Paste the admin token to continue.</p>
<form method="POST" action="/oauth/authorize">
      ${hidden}
  <input type="password" name="admin_token" placeholder="Admin token" autocomplete="off" autofocus required>
  <button type="submit">Authorize</button>
</form>
<div class="warn">Only continue if you started this from a WeKruit tool you trust. The access it grants lasts 8 hours.</div>`,
  }
}

/** Verify the human, then mint a single-use code. */
export async function authorizePost(
  deps: OAuthDeps,
  p: AuthorizeParams & { admin_token?: string },
): Promise<HttpResult> {
  const v = await validateAuthorize(deps, p)
  if (!v.ok) return v.result

  const presented = String(p.admin_token ?? "")
  const principalUid = await resolveAdmin(deps, presented)
  if (!principalUid) {
    // Re-render rather than redirect: a failed human login is not an OAuth protocol error, and
    // bouncing an "access_denied" to the client on a typo makes the flow unusable.
    const page = await authorizeGet(deps, p)
    return {
      ...page,
      status: 401,
      html: (page.html ?? "").replace("<h1>", '<p style="color:#c00;margin-bottom:1rem">That token was not accepted.</p><h1>'),
    }
  }

  const nowMs = deps.now?.() ?? Date.now()
  const code = randomSecret()
  await saveAuthCode(deps.db, code, {
    clientId: String(p.client_id),
    redirectUri: v.redirectUri,
    codeChallenge: String(p.code_challenge),
    principalUid,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + CODE_TTL_MS).toISOString(),
  })
  const u = new URL(v.redirectUri)
  u.searchParams.set("code", code)
  if (p.state) u.searchParams.set("state", p.state)
  return { status: 302, headers: { location: u.toString(), "cache-control": "no-store" }, redirect: u.toString() }
}

/** Same trust model as requireHeadhunterPrincipal — this endpoint must not widen it. */
async function resolveAdmin(deps: OAuthDeps, presented: string): Promise<string | undefined> {
  if (!presented) return undefined
  if (deps.adminToken && safeEqual(presented, deps.adminToken)) return "admin-token"
  try {
    const decoded = await getAuth().verifyIdToken(presented)
    if (decoded.admin === true || decoded.admin === "true") return decoded.uid
  } catch {
    /* not an ID token */
  }
  return undefined
}

export async function tokenExchange(deps: OAuthDeps, body: Record<string, unknown>): Promise<HttpResult> {
  if (String(body.grant_type ?? "") !== "authorization_code") {
    return err(400, "unsupported_grant_type", "only authorization_code is supported")
  }
  const code = String(body.code ?? "")
  const verifier = String(body.code_verifier ?? "")
  if (!code || !verifier) return err(400, "invalid_request", "code and code_verifier are required")

  const nowMs = deps.now?.() ?? Date.now()
  const rec = await consumeAuthCode(deps.db, code, nowMs)
  if (!rec) return err(400, "invalid_grant", "code is unknown, already used, or expired")
  // Every binding is checked even though the code was already burned — a mismatch here means the
  // exchange is not the party that started the flow.
  if (!safeEqual(rec.clientId, String(body.client_id ?? ""))) return err(400, "invalid_grant", "client mismatch")
  if (body.redirect_uri !== undefined && !safeEqual(rec.redirectUri, String(body.redirect_uri))) {
    return err(400, "invalid_grant", "redirect_uri mismatch")
  }
  if (!verifyPkceS256(verifier, rec.codeChallenge)) return err(400, "invalid_grant", "PKCE verification failed")

  const accessToken = randomSecret()
  await saveAccessToken(deps.db, accessToken, {
    clientId: rec.clientId,
    principalUid: rec.principalUid,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ACCESS_TOKEN_TTL_MS).toISOString(),
  })
  return {
    status: 200,
    headers: JSON_HEADERS,
    json: {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: "mcp",
    },
  }
}
