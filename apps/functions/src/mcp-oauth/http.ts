/**
 * mcp-oauth/http.ts — `paMcpOauth`, the HTTPS entrypoint for the MCP authorization server.
 *
 * Routed through Firebase Hosting on the ADMIN origin, because RFC 8414 puts discovery at the
 * origin root and the raw function URL lives under a path. Hosting rewrites (firebase.json,
 * pa-dashboard target) map:
 *
 *   /.well-known/oauth-authorization-server  ->  paMcpOauth
 *   /.well-known/oauth-protected-resource    ->  paMcpOauth
 *   /oauth/{register,authorize,token}        ->  paMcpOauth
 *   /mcp                                     ->  paHeadhunterMcp
 *
 * so the issuer is `https://wekruit-pa.web.app` and the protected resource `.../mcp`.
 */
import { onRequest } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { defineSecret } from "firebase-functions/params"
import { getFirestore } from "firebase-admin/firestore"

import {
  authorizationServerMetadata,
  authorizeGet,
  authorizePost,
  protectedResourceMetadata,
  registerClient,
  tokenExchange,
  type HttpResult,
  type OAuthDeps,
} from "./handlers.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")
const PA_SECRET_UNSET_SENTINEL = "__UNSET__"

/** The public origin this server is reached through; overridable for a staging host. */
const DEFAULT_ISSUER = "https://wekruit-pa.web.app"

function safeSecret(): string | null {
  try {
    const v = PA_ADMIN_TOKEN.value()
    return v && v !== PA_SECRET_UNSET_SENTINEL ? v : null
  } catch {
    return null
  }
}

/** Hosting rewrites preserve the original path; a direct function hit does not. Accept both. */
export function normalizePath(rawPath: string): string {
  const p = rawPath.split("?")[0] ?? ""
  return p.replace(/^\/paMcpOauth/, "").replace(/\/+$/, "") || "/"
}

export async function routeOauthRequest(
  deps: OAuthDeps,
  req: { method: string; path: string; query: Record<string, unknown>; body: unknown },
): Promise<HttpResult> {
  const path = normalizePath(req.path)
  const method = req.method.toUpperCase()
  const query = (req.query ?? {}) as Record<string, string>
  const body = (typeof req.body === "object" && req.body ? req.body : {}) as Record<string, unknown>

  if (method === "GET" && path === "/.well-known/oauth-authorization-server") {
    return authorizationServerMetadata(deps)
  }
  if (method === "GET" && path === "/.well-known/oauth-protected-resource") {
    return protectedResourceMetadata(deps)
  }
  if (method === "POST" && path === "/oauth/register") return registerClient(deps, body)
  if (method === "GET" && path === "/oauth/authorize") return authorizeGet(deps, query)
  if (method === "POST" && path === "/oauth/authorize") {
    // The consent form posts urlencoded; a client could post JSON. Both land in req.body.
    return authorizePost(deps, { ...query, ...(body as Record<string, string>) })
  }
  if (method === "POST" && path === "/oauth/token") return tokenExchange(deps, body)

  return { status: 404, headers: { "content-type": "application/json" }, json: { error: "not_found", path } }
}

export const paMcpOauth = onRequest(
  { region: "us-central1", secrets: [PA_ADMIN_TOKEN], cors: false, invoker: "public" },
  async (req, res) => {
    try {
      const deps: OAuthDeps = {
        db: getFirestore(),
        issuer: process.env.PA_MCP_OAUTH_ISSUER || DEFAULT_ISSUER,
        resource: `${process.env.PA_MCP_OAUTH_ISSUER || DEFAULT_ISSUER}/mcp`,
        adminToken: safeSecret(),
      }
      const result = await routeOauthRequest(deps, {
        method: req.method,
        path: req.path,
        query: req.query as Record<string, unknown>,
        body: req.body,
      })
      for (const [k, v] of Object.entries(result.headers ?? {})) res.setHeader(k, v)
      // Never log a code, verifier, or token — only the shape of the request.
      logger.info("mcp_oauth_request", { path: normalizePath(req.path), method: req.method, status: result.status })
      if (result.html !== undefined) {
        res.status(result.status).send(result.html)
        return
      }
      if (result.status === 302 && result.redirect) {
        res.redirect(302, result.redirect)
        return
      }
      res.status(result.status).json(result.json ?? {})
    } catch (e) {
      logger.error("mcp_oauth_failed", { error: e instanceof Error ? e.message : String(e) })
      res.status(500).json({ error: "server_error" })
    }
  },
)
