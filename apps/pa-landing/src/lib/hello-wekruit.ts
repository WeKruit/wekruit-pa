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
 * 2026-06-14 (Adam-locked) — the token MUST ALWAYS carry the candidate's
 * IDENTITY as a server-minted, transit-safe BIND CODE: `WeKruit_<jobId>_<bindCode>
 * _Job`. The bind code is the web→phone identity bridge — the inbound webhook
 * resolves it → candidateId → binds the texted phone to THAT web profile
 * (resume/tags intact), so a website-first candidate whose phone is not yet
 * bound is never orphaned (+19196855995 dead-silence) and never split into a
 * duplicate. The code is Crockford-base32-minus-ambiguous (no I/L/O/U/0/1) so it
 * survives page→Messages transit without corrupting (the original raw-uid bug:
 * Maximiliano/Aditya/Sydney). The jobId is always validated against pa-jobs, so
 * a corrupted jobId fails the match (graceful notice), never mis-resolves.
 *
 * EVERY MINT SITE MUST PASS A bindCode. The job-only `WeKruit_<jobId>_Job` form
 * is NEVER minted — it exists only as a DEGRADED/LEGACY inbound that the parser
 * still accepts and resolves via phone-is-auth (for an already-bound phone). The
 * sole no-code branch below is a last-resort fallback for that already-bound /
 * mint-failed case; callers should treat a missing code as a bug, not a path.
 */
export function buildWekruitJobOpenerBody(jobId: string, bindCode?: string): string {
  const job = jobId.trim()
  const code = bindCode ? bindCode.replace(/\s+/g, "").toUpperCase() : ""
  // Degraded fallback ONLY (already-bound phone / mint failed): phone-is-auth
  // resolves identity inbound. Never the preferred mint.
  return code ? `WeKruit_${job}_${code}_Job` : `WeKruit_${job}_Job`
}

/**
 * YC Startup School event opener (2026-07-23 — must mirror
 * packages/pa-orchestrator/src/shared-onboarding.ts YC_EVENT_OPENER_PREFIX /
 * buildYcEventOpenerBody exactly, including the em dash). The QR-scan path
 * already builds this via the server-side (functions) copy; the WEBSITE-first
 * path (Onboarding.tsx Done handoff for a signupSource=yc_startup_school
 * candidate) builds it here so a candidate who registers on wekruit.com/yc-startup
 * gets the SAME YC-flavored first text as someone who scanned the printed QR —
 * not the generic "my verification code is" phrasing, which reads as a bare
 * login step and does not deliver the promised YC greeting. The token slot
 * still carries either the transit-safe bind code or the raw candidateId — the
 * backend parser (parseHelloWekruitOpener) resolves both shapes identically
 * regardless of which opener phrasing wraps them.
 */
export const YC_EVENT_OPENER_PREFIX = "Hey! I'm at YC Startup School — my code is"

export function buildYcEventOpenerBody(token: string): string {
  const t = token.trim()
  if (!t) return YC_EVENT_OPENER_PREFIX
  return `${YC_EVENT_OPENER_PREFIX} ${t}`
}
