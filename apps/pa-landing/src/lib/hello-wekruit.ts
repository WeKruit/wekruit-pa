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

export function buildWekruitJobOpenerBody(jobId: string, candidateId: string): string {
  return `WeKruit_${jobId.trim()}_${candidateId.trim()}_Job`
}
