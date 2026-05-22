/**
 * Sendblue peer normalization.
 *
 * This is deliberately only a formatter. Candidate access is not gated by an
 * inbound/outbound phone allowlist.
 */

export function normalizePeer(raw: string): string {
  if (typeof raw !== "string") return ""
  const value = raw.trim()
  if (!value) return ""
  if (value.includes("@")) return value.toLowerCase()
  const digits = value.replace(/\D/g, "")
  if (!digits) return ""
  if (value.startsWith("+")) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  return `+${digits}`
}
