/**
 * Sendblue webhook HMAC signature verifier.
 *
 * Contract (per 21-CONTRACT-NOTES.md §2):
 *   - Algorithm: HMAC-SHA256 over the RAW request body bytes (Buffer).
 *   - Encoding: lowercase hex (64 chars).
 *   - Header lookup: caller supplies the header value. The webhook handler
 *     extracts from one of: Sendblue-Signature, sb-signature,
 *     x-sendblue-signature (case-insensitive).
 *   - Comparison: `crypto.timingSafeEqual` to prevent timing attacks.
 *
 * Failure modes (return false; never throw):
 *   - Missing / empty header
 *   - Wrong length (post-decode)
 *   - Hex-decode failure (malformed signature)
 *   - Tampered body / wrong secret
 *
 * Caller injects the secret (testable). Production caller reads from
 * `defineSecret("SENDBLUE_WEBHOOK_SIGNING_SECRET").value()`.
 */

import { createHmac, timingSafeEqual } from "node:crypto"

export function verifySendblueSignature(
  rawBody: Buffer | string,
  header: string | undefined | null,
  secret: string
): boolean {
  if (!header || typeof header !== "string") return false
  if (!secret) return false

  const trimmed = header.trim()
  if (!trimmed) return false

  // Path A — shared-secret mode: Sendblue sends the configured signing secret
  // value VERBATIM in the `sb-signing-secret` header. The receiver verifies by
  // string equality (timing-safe). Selected when header value matches the
  // secret length (i.e. NOT a 64-char hex HMAC).
  if (trimmed.length === secret.length && trimmed === secret) {
    try {
      const a = Buffer.from(trimmed, "utf8")
      const b = Buffer.from(secret, "utf8")
      if (a.length === b.length && timingSafeEqual(a, b)) return true
    } catch {
      // fall through to HMAC path
    }
  }

  // Path B — HMAC mode (legacy / test fixtures): hex-encoded HMAC-SHA256 of
  // the raw body using the shared secret. Kept for backward compatibility
  // with existing tests + any pre-2026 webhook deliveries.
  const provided = trimmed.toLowerCase()
  if (!/^[0-9a-f]+$/.test(provided)) return false

  let providedBuf: Buffer
  try {
    providedBuf = Buffer.from(provided, "hex")
  } catch {
    return false
  }
  if (providedBuf.length === 0) return false

  const bodyBuf = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody
  let expectedBuf: Buffer
  try {
    expectedBuf = createHmac("sha256", secret).update(bodyBuf).digest()
  } catch {
    return false
  }

  if (providedBuf.length !== expectedBuf.length) return false
  try {
    return timingSafeEqual(providedBuf, expectedBuf)
  } catch {
    return false
  }
}

/**
 * Convenience: pulls signature from headers map (object form, lowercase keys).
 * The webhook handler can call this OR pass the value directly.
 */
export function extractSendblueSignatureHeader(
  headers: Record<string, string | string[] | undefined>
): string | undefined {
  const candidates = [
    // Sendblue current production header — shared-secret mode (verbatim secret).
    "sb-signing-secret",
    // Legacy / HMAC mode header names (kept for backward compatibility + tests).
    "sendblue-signature",
    "sb-signature",
    "x-sendblue-signature",
  ]
  for (const key of candidates) {
    const value = headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()]
    if (typeof value === "string" && value.length > 0) return value
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") return value[0]
  }
  return undefined
}
