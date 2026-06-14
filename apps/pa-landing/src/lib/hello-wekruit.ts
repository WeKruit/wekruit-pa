/**
 * Must match packages/pa-orchestrator shared-onboarding opener builders.
 *
 * 2026-06-02 reword: the candidate-emitted body is the verification-code phrasing
 * ("Hi, WeKruit, my verification code is <token>"). The legacy "Hello, WeKruit!"
 * prefix is kept exported for back-compat (still parsed inbound; in-flight QR links
 * already emit the old body).
 */
export const VERIFICATION_CODE_OPENER_PREFIX = "Hi, WeKruit, my verification code is"
/** Legacy opener prefix — back-compat parse only. */
export const HELLO_WEKRUIT_OPENER_PREFIX = "Hello, WeKruit!"

export function buildHelloWekruitOpenerBody(candidateId: string): string {
  const id = candidateId.trim()
  if (!id) return VERIFICATION_CODE_OPENER_PREFIX
  return `${VERIFICATION_CODE_OPENER_PREFIX} ${id}`
}

/**
 * 2026-06-13 — phone-binding opener carrying a TRANSIT-SAFE bind CODE (server-
 * minted; maps code → candidate in pa-bind-codes). PREFERRED over the raw-uid
 * builder for website-first/unbound-phone candidates: the code uses a Crockford
 * base32 alphabet (no ambiguous I/L/O/U/0/1) so it survives page→Messages
 * transit without corrupting → no failed/wrong binds. Wording is unchanged so
 * back-compat parsers/sanitizers keep working. Code is uppercased on emit; the
 * inbound parser normalizes the same way.
 */
export function buildBindCodeOpenerBody(code: string): string {
  const c = code.replace(/\s+/g, "").toUpperCase()
  if (!c) return VERIFICATION_CODE_OPENER_PREFIX
  return `${VERIFICATION_CODE_OPENER_PREFIX} ${c}`
}

/**
 * Build the prescreen job-opener body the candidate sends to start a screen.
 *
 * 2026-06-13 — the uid is GONE from the token (Adam directive: kill the
 * page→Messages glyph-corruption class at the source). Firebase push-id uids
 * carry ambiguous glyphs (`l`↔`1`, `I`, stray `-`) that mangle in iMessage
 * transit; a corrupted uid resolved to no account → DEAD SILENCE (Maximiliano,
 * Aditya, Sydney). Identity is now PHONE-IS-AUTH (prescreen trigger resolves the
 * candidate from the inbound phone, not the token uid). The jobId is the only
 * payload — and it's validated against pa-jobs, so a corrupted jobId just fails
 * the match (graceful notice), never silently mis-resolves identity.
 *
 * `candidateId` is accepted-but-unused for call-site back-compat.
 */
export function buildWekruitJobOpenerBody(jobId: string, _candidateId?: string): string {
  return `WeKruit_${jobId.trim()}_Job`
}
