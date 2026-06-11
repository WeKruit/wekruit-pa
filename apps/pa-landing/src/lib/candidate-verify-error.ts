/**
 * CandidateVerifyError + the sign-out policy for verify failures.
 *
 * Kept dependency-free (no firebase imports) so the policy is unit-testable
 * under plain `node --test` — see candidate-verify-error.test.ts.
 */

export class CandidateVerifyError extends Error {
  readonly reason: string
  readonly status: number

  constructor(reason: string, status: number, message?: string) {
    super(message ?? reason)
    this.name = "CandidateVerifyError"
    this.reason = reason
    this.status = status
  }
}

export function candidateVerifyErrorMessage(reason: string): string {
  switch (reason) {
    case "email_not_verified":
      return "Your email isn't verified yet. Check your inbox or try Google sign-in again."
    case "missing_verified_email":
      return "We couldn't read an email from your sign-in. Try another method."
    default:
      return "Sign-in verification failed. Please try again."
  }
}

/** Verify reasons where the Firebase session itself is unusable. */
const AUTH_FAILURE_REASONS = new Set([
  "email_not_verified",
  "missing_verified_email",
  "not_signed_in",
])

/**
 * True only for auth-class verify failures (bad session → sign out + bounce
 * to /login). Everything else — network failures, 5xx, generic
 * `verify_failed` — is transient: callers MUST keep the session and offer an
 * inline retry instead of destroying a valid sign-in. One transient error
 * signing the user out is exactly the login loop observed live (2026-06-10).
 */
export function shouldSignOutOnVerifyError(err: unknown): boolean {
  if (!(err instanceof CandidateVerifyError)) return false
  if (AUTH_FAILURE_REASONS.has(err.reason)) return true
  return err.status === 401 || err.status === 403
}
