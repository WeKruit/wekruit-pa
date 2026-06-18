/**
 * Dev-only gate for Claire voice calls.
 *
 * This is intentionally phone-based, not uid-based: voice calls dial a real
 * phone number, so the last safety boundary should be the dial target.
 */

export const CLAIRE_VOICE_DEV_PHONES = new Set<string>([
  "+14243201960", // Adam
  "+12154034668", // Noah
])

export function normalizeE164Phone(phone: string | null | undefined): string {
  return typeof phone === "string" ? phone.trim().replace(/[^\d+]/g, "") : ""
}

export function isClaireVoiceDevPhone(phone: string | null | undefined): boolean {
  return CLAIRE_VOICE_DEV_PHONES.has(normalizeE164Phone(phone))
}
