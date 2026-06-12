/**
 * claire-continuation.ts — PRD §2.4/§2.5 (ENTRY-UX-PRD.md): the "Talk to
 * Claire" CTA continuation model.
 *
 * The continuation STATE itself (auth provider, resume/LinkedIn status, job
 * context, pitch-sent) lives server-side on pa-users.websiteEntry — the CTA's
 * only job is to make the candidate's FIRST thread message attribute to the
 * SAME pa-users/{uid}:
 *
 *  - phone already bound (verified phone handle / Claire thread exists) →
 *    plain `sms:` deeplink into the sticky senderNumber thread ("Hi Claire").
 *    The inbound resolves by phone → same uid → runtime reads the continuation.
 *
 *  - NO bound phone (website-first candidate) → the deeplink body is the
 *    existing BINDING opener token (§2.5.2): the verification-code opener
 *    ("Hi, WeKruit, my verification code is <candidateId>") or, with a job
 *    context, the job opener ("WeKruit_<jobId>_<candidateId>_Job"). The
 *    webhook parses the token and binds the new phone to that candidateId —
 *    never a stranger profile. (This is the same web→phone binding path the
 *    QR/Onboarding Done flows already use; /connect-phone is the INVERSE
 *    direction and requires an existing phone thread.)
 *
 * No candidate-facing prose is composed here (PRD rule 1) — the body strings
 * are existing control tokens, and the runtime turn does the talking.
 */
import { buildHelloWekruitOpenerBody, buildWekruitJobOpenerBody } from "./hello-wekruit.js"

export interface ClaireContinuationInput {
  /** The candidate's sticky WeKruit Sendblue number (the thread recipient). */
  senderNumber?: string | null
  /** pa-users/{uid} — carried in the binding opener when no phone is bound. */
  candidateId?: string | null
  /** True when a phone is already bound to this profile (verified phone handle
   *  / phone-code link / Claire thread started). */
  phoneVerified: boolean
  /** Job/role context when the CTA sits on a job page or role card. */
  jobId?: string | null
}

function cleanSenderNumber(senderNumber?: string | null): string | null {
  const trimmed = typeof senderNumber === "string" ? senderNumber.trim() : ""
  return /^\+\d{8,16}$/.test(trimmed) ? trimmed : null
}

/** The first-message body for the CTA (control token or plain greeting). */
export function buildClaireContinuationBody(input: ClaireContinuationInput): string {
  const candidateId = typeof input.candidateId === "string" ? input.candidateId.trim() : ""
  const jobId = typeof input.jobId === "string" ? input.jobId.trim() : ""
  if (input.phoneVerified && !jobId) return "Hi Claire"
  if (!candidateId) return "Hi Claire"
  if (jobId) return buildWekruitJobOpenerBody(jobId, candidateId)
  if (input.phoneVerified) return "Hi Claire"
  return buildHelloWekruitOpenerBody(candidateId)
}

/**
 * sms: deeplink into the candidate's Claire thread, with the binding opener
 * when no phone is bound yet. Null when no sticky senderNumber exists (the
 * caller should surface a binding path instead of hiding Claire).
 */
export function buildClaireContinuationHref(input: ClaireContinuationInput): string | null {
  const recipient = cleanSenderNumber(input.senderNumber)
  if (!recipient) return null
  const body = buildClaireContinuationBody(input)
  return `sms:${recipient}?&body=${encodeURIComponent(body)}`
}
