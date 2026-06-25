/**
 * headhunter-mcp/auth.ts — Phase-1 auth gate for the AI-headhunter MCP server.
 *
 * Mirrors the EXACT trust model of `authorizeAdminCallable` (promote-sandbox-tag.ts):
 * accept either a Firebase ID token carrying the `admin === true` custom claim
 * (the @wekruit.com admin gate) OR the shared `PA_ADMIN_TOKEN` bearer. No new
 * trust surface — the MCP server can never exceed what an admin callable already
 * grants.
 *
 * Phase 2 (employer, passed-only) will add `scope: "employer"` + `employerId`,
 * derived from a per-employer token, and every tool will hard-filter on it.
 */
import { getAuth } from "firebase-admin/auth"
import { defineSecret } from "firebase-functions/params"

// Local (non-exported) to avoid a TS2742 export-portability error on the inferred
// SecretParam type. http.ts declares its own same-named secret for the function's
// `secrets:` binding — defineSecret is keyed by name, so both refer to the same
// underlying secret (the value is available at runtime once any binding declares it).
const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

/** Firebase Secret Manager placeholder used across the codebase for unset secrets. */
const PA_SECRET_UNSET_SENTINEL = "__UNSET__"

export interface HeadhunterPrincipal {
  uid: string
  /**
   * Phase 1 only ever mints "internal" (full operator surface). The "employer"
   * variant is declared now so passed-candidate tools can branch on it (Phase 2
   * = passed-only + consent-redacted) without a later type change.
   */
  scope: "internal" | "employer"
}

export class McpAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "McpAuthError"
  }
}

/**
 * Resolve the calling principal from an `Authorization: Bearer <token>` header.
 * Throws `McpAuthError` when neither the admin claim nor PA_ADMIN_TOKEN matches.
 */
export async function requireHeadhunterPrincipal(
  authorizationHeader: string | undefined,
): Promise<HeadhunterPrincipal> {
  const bearer = extractBearer(authorizationHeader)
  if (!bearer) throw new McpAuthError("missing bearer token")

  const adminToken = safeSecret(PA_ADMIN_TOKEN)
  if (adminToken && bearer === adminToken) {
    return { uid: "admin-token", scope: "internal" }
  }

  try {
    const decoded = await getAuth().verifyIdToken(bearer)
    if (decoded.admin === true || decoded.admin === "true") {
      return { uid: decoded.uid, scope: "internal" }
    }
  } catch {
    /* fall through to the rejection below */
  }
  throw new McpAuthError(
    "not authorized for the headhunter MCP (admin custom claim or PA_ADMIN_TOKEN required)",
  )
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

function safeSecret(secret: { value(): string }): string | null {
  try {
    const value = secret.value()
    return value && value !== PA_SECRET_UNSET_SENTINEL ? value : null
  } catch {
    return null
  }
}
