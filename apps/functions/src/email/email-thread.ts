/**
 * email/email-thread.ts — VERP thread-token helpers for TWO-WAY email replies.
 *
 * When an outbound email is sent to a candidate, we mint an opaque random
 * conversation token (`convToken`) and persist a `pa-email-threads/{convToken}`
 * doc mapping the token → { userId?, jobId?, candidateEmail, subject }. The
 * email's Reply-To is set to a VERP address `reply+<convToken>@<INBOUND_DOMAIN>`.
 *
 * Mailgun's inbound route (configured separately, MX + route → our webhook)
 * POSTs the reply with `recipient = reply+<convToken>@<INBOUND_DOMAIN>`. The
 * inbound webhook extracts the token from the local-part, loads the thread
 * doc, and recovers the candidate to compose + send a contextual reply on the
 * SAME thread (same Reply-To token).
 *
 * Identity rules: the token is a random hex (crypto.randomBytes — NEVER
 * Math.random, NEVER derived from raw PII), and it is the Firestore doc id;
 * raw PII (email/phone/userId) is never used as a doc id.
 */
import { randomBytes } from "node:crypto"
import { FieldValue, type Firestore } from "firebase-admin/firestore"

/** Collection holding token → candidate-thread mappings. */
export const EMAIL_THREADS_COLLECTION = "pa-email-threads"

/**
 * Inbound VERP domain. The Mailgun inbound route + MX is configured for this
 * domain (defaults to the sending domain `mg.wekruit.com`; a dedicated
 * subdomain like `inbound.mg.wekruit.com` can be set via env).
 */
export function inboundDomain(): string {
  return (process.env.MAILGUN_INBOUND_DOMAIN ?? "mg.wekruit.com").trim() || "mg.wekruit.com"
}

/** Generate a url-safe opaque conversation token (hex, crypto-random). */
export function generateConvToken(): string {
  return randomBytes(16).toString("hex")
}

/** Build the VERP Reply-To address for a conversation token. */
export function verpReplyToAddress(convToken: string): string {
  return `reply+${convToken}@${inboundDomain()}`
}

/**
 * Extract the conversation token from a Mailgun inbound `recipient` address of
 * the form `reply+<token>@<domain>`. Returns null if it doesn't match.
 */
export function extractConvTokenFromRecipient(recipient: string | undefined): string | null {
  if (!recipient) return null
  // Take the address local-part (handle "Name <addr>" display form too).
  const m = recipient.match(/<([^>]+)>/)
  const addr = (m ? m[1] : recipient).trim().toLowerCase()
  const local = addr.split("@")[0] ?? ""
  const plus = local.match(/^reply\+([a-f0-9]{8,64})$/)
  return plus ? plus[1]! : null
}

export interface EmailThreadDoc {
  convToken: string
  userId?: string
  jobId?: string
  candidateEmail: string
  subject: string
  lastDirection: "outbound" | "inbound"
  /** Source discriminator mirroring pa-headhunter-emails. */
  source?: string
}

/**
 * Persist a `pa-email-threads/{convToken}` doc at outbound send time. Returns
 * the convToken (already known by caller) for convenience. Best-effort: this
 * is the durable mapping the inbound webhook depends on, so callers should
 * write it BEFORE/at the same place they audit the send.
 */
export async function persistEmailThread(
  db: Firestore,
  doc: EmailThreadDoc,
): Promise<void> {
  const ref = db.collection(EMAIL_THREADS_COLLECTION).doc(doc.convToken)
  await ref.set(
    {
      convToken: doc.convToken,
      ...(doc.userId ? { userId: doc.userId } : {}),
      ...(doc.jobId ? { jobId: doc.jobId } : {}),
      candidateEmail: doc.candidateEmail,
      subject: doc.subject,
      lastDirection: doc.lastDirection,
      ...(doc.source ? { source: doc.source } : {}),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
}
