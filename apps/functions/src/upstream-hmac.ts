/**
 * Phase 31 — Upstream Event Connector HMAC verifier.
 *
 * Inbound events from external partners (e.g. ATS hooks) must include an
 * HMAC-SHA256 signature of the raw request body, computed with the shared
 * secret stored in `PA_UPSTREAM_HMAC_SECRET` (Firebase Secret Manager).
 *
 * Header conventions (first match wins):
 *   x-pa-upstream-signature        (preferred)
 *   x-upstream-signature
 *   pa-upstream-signature
 *
 * Signature format: hex-encoded HMAC-SHA256, lowercase. Optional
 * `sha256=<hex>` prefix is stripped to match standard webhook conventions.
 *
 * This file is deliberately separate from `sendblue/hmac.ts` because:
 *   - The Sendblue verifier is a plaintext shared-secret compare (Sendblue's
 *     deployed scheme), NOT real HMAC.
 *   - The upstream secret is distinct from the Sendblue secret so a
 *     compromised partner cannot forge Sendblue inbound traffic.
 *
 * `verifyUpstreamSignature` returns false on every failure mode (missing
 * header, missing secret, length mismatch, mismatch). It NEVER throws.
 */

import { createHmac, timingSafeEqual } from "node:crypto"

export function verifyUpstreamSignature(
  rawBody: Buffer | string,
  header: string | undefined | null,
  secret: string
): boolean {
  if (!header || typeof header !== "string") return false
  if (!secret) return false

  const provided = header.trim()
  if (!provided) return false

  const stripped = provided.startsWith("sha256=") ? provided.slice("sha256=".length) : provided
  // Hex decode is permissive: must be even-length hex.
  if (!/^[0-9a-fA-F]+$/.test(stripped) || stripped.length % 2 !== 0) return false

  const bodyBuf =
    typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody)
  const expectedHex = createHmac("sha256", secret).update(bodyBuf).digest("hex")
  const providedBuf = Buffer.from(stripped.toLowerCase(), "hex")
  const expectedBuf = Buffer.from(expectedHex, "hex")
  if (providedBuf.length !== expectedBuf.length) return false
  try {
    return timingSafeEqual(providedBuf, expectedBuf)
  } catch {
    return false
  }
}

export function extractUpstreamSignatureHeader(
  headers: Record<string, string | string[] | undefined>
): string | undefined {
  const candidates = [
    "x-pa-upstream-signature",
    "x-upstream-signature",
    "pa-upstream-signature",
  ]
  for (const key of candidates) {
    const value = headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()]
    if (typeof value === "string" && value.length > 0) return value
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") return value[0]
  }
  return undefined
}

/**
 * Compute the canonical signature header value for a body+secret pair.
 * Used by tests and the dashboard "send test event" tool.
 */
export function computeUpstreamSignature(rawBody: Buffer | string, secret: string): string {
  const bodyBuf =
    typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody)
  return createHmac("sha256", secret).update(bodyBuf).digest("hex")
}
