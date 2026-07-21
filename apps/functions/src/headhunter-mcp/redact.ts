/**
 * headhunter-mcp/redact.ts — the rule-#6 PII consent gate for passed-candidate
 * data exposed over MCP. Isolated here so it is unit-testable without loading the
 * MCP server / job-rec graph.
 *
 * The dashboard redacts un-consented PII CLIENT-side (trusted human UI). An LLM
 * MCP client is NOT trusted, so for the EMPLOYER scope we redact every row whose
 * candidate has not granted PII consent BEFORE the bytes leave the server.
 * Internal operators get dashboard-parity (no redaction).
 */
import { redactPassedCandidateText } from "../admin-passed-candidates.js"
import type { HeadhunterPrincipal } from "./auth.js"

/** Operates on a JSON clone so the caller's typed snapshot is never mutated. */
export function maybeRedactPassed(snapshot: unknown, principal: HeadhunterPrincipal): unknown {
  if (principal.scope !== "employer") return snapshot
  const clone = JSON.parse(JSON.stringify(snapshot)) as {
    rows?: Array<Record<string, unknown>>
  } & Record<string, unknown>
  const rows = Array.isArray(clone.rows) ? clone.rows : []
  for (const row of rows) {
    const profile = row.profile as { consentStatus?: string } | undefined
    if (profile?.consentStatus === "granted") continue
    row.displayName = "[redacted — consent pending]"
    if (typeof row.email === "string") row.email = "[redacted]"
    for (const field of ["resumeSummary", "passReason", "matchReason"] as const) {
      const current = row[field]
      if (typeof current === "string") row[field] = redactPassedCandidateText(current)
    }
    row.transcript = { redacted: true, reason: "pii_consent_pending", turns: [] }
    row.consentRedacted = true
  }
  return clone
}
