/**
 * Sendblue inbound `from_number` format helpers.
 *
 * Sendblue iMessage transport accepts inbound from email-based Apple IDs
 * (per https://docs.sendblue.com/faq/) but provides no documented wire
 * format and no outbound path for them. We currently reject non-E.164
 * senders at webhook entry; email Apple ID support is tracked in GH #142.
 *
 * E.164 spec: leading `+`, country code starts with 1-9, total digits
 * between 7 and 15.
 */

const E164_REGEX = /^\+[1-9]\d{6,14}$/

export function isE164(value: string): boolean {
  return typeof value === "string" && E164_REGEX.test(value)
}

export function looksLikeEmail(value: string): boolean {
  if (typeof value !== "string") return false
  const at = value.indexOf("@")
  if (at <= 0 || at === value.length - 1) return false
  const domain = value.slice(at + 1)
  return domain.includes(".")
}

export type HandleFormat = "e164_phone" | "email_apple_id" | "unknown"

export function classifyInboundSender(value: string): HandleFormat {
  if (isE164(value)) return "e164_phone"
  if (looksLikeEmail(value)) return "email_apple_id"
  return "unknown"
}
