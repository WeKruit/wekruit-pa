/**
 * interview-confirmation-email.ts — WeKruit-branded interview confirmation.
 *
 * Reuses `sendMailgun` (email/mailgun.js) and builds a MailgunConfig from
 * process.env EXACTLY like send-mailgun-email.ts (MAILGUN_API_KEY / MAILGUN_DOMAIN
 * default "wekruit.com" / MAILGUN_FROM default "WeKruit <hi@wekruit.com>" /
 * MAILGUN_REGION). Audits a successful send to the existing `sent_emails`
 * collection (same shape as runSendMailgunEmail).
 *
 * Fail-OPEN: returns { ok, messageId?, reason? } and NEVER throws — a Mailgun
 * outage must never break the chat turn (the Cal.com booking is already made).
 *
 * NOTE: Cal.com ALSO auto-sends its own confirmation email on an accepted
 * booking, so this WeKruit email is a supplement — the candidate may receive two
 * emails. Acceptable for v1.
 */

import { FieldValue, type Firestore } from "firebase-admin/firestore"

import { sendMailgun, type MailgunConfig, type MailgunSendResult } from "../email/mailgun.js"

export interface SendInterviewConfirmationEmailInput {
  to: string
  name: string
  /** chosen slot ISO (w/ offset). */
  whenIso: string
  /** IANA tz used to render the human-readable time. */
  timeZone: string
  jobId: string
  eventTypeId: number
  /**
   * Video-call join link (e.g. Google Meet) from the Cal booking. When present,
   * we render the ACTUAL link in the email; when absent we fall back to the
   * "you'll find the link in your calendar invite" line.
   */
  meetingUrl?: string
  db: Firestore
  /** pa-users doc id (internal; for the sent_emails audit row). */
  userId: string
  /** Inject for unit tests; defaults to the real sendMailgun. */
  sendMail?: typeof sendMailgun
  /** Inject for unit tests; defaults to (key) => process.env[key]. */
  readEnv?: (key: string) => string | undefined
}

export interface SendInterviewConfirmationEmailResult {
  ok: boolean
  messageId?: string
  reason?: string
}

/** Build the MailgunConfig from env exactly like send-mailgun-email.ts. */
function readMailgunConfig(readEnv: (key: string) => string | undefined): MailgunConfig | null {
  const apiKey = readEnv("MAILGUN_API_KEY")?.trim()
  const domain = readEnv("MAILGUN_DOMAIN")?.trim() || "wekruit.com"
  const from = readEnv("MAILGUN_FROM")?.trim() || "WeKruit <hi@wekruit.com>"
  const region = readEnv("MAILGUN_REGION")?.trim() === "eu" ? "eu" : "us"
  if (!apiKey) return null
  return { apiKey, domain, from, region }
}

/**
 * Escape HTML-special chars before interpolating candidate-controlled values
 * (firstName, rendered when) into the HTML body. Same helper the rest of the
 * repo's Mailgun HTML senders use (openLayoff.ts / refer-program.ts). The email
 * is self-targeted (sent only to the candidate's own address), but unescaped
 * interpolation is exactly the class the codebase already guards against, and it
 * persists if/when the dev-uid gate is lifted for GA.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** Render the chosen slot instant in the candidate's tz. Falls back to the raw ISO. */
function formatWhen(whenIso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone,
    }).format(new Date(whenIso))
  } catch {
    return whenIso
  }
}

export async function sendInterviewConfirmationEmail(
  input: SendInterviewConfirmationEmailInput,
): Promise<SendInterviewConfirmationEmailResult> {
  const readEnv = input.readEnv ?? ((key: string) => process.env[key])
  const sendMail = input.sendMail ?? sendMailgun
  const cfg = readMailgunConfig(readEnv)
  if (!cfg) {
    return { ok: false, reason: "mailgun_not_configured" }
  }

  const when = formatWhen(input.whenIso, input.timeZone)
  const firstName = (input.name ?? "").trim().split(/\s+/)[0] || "there"
  const subject = "Your WeKruit interview is confirmed"
  // Only render an explicit join link when it's a real http(s) URL; otherwise
  // fall back to the calendar-invite line (Cal still sends its own invite email).
  const joinUrl = (input.meetingUrl ?? "").trim()
  const hasJoinUrl = /^https?:\/\//i.test(joinUrl)
  const videoLineText = hasJoinUrl
    ? `It's a quick video call. Join here: ${joinUrl}`
    : `It's a quick video call — you'll find the link in your calendar invite.`
  const videoLineHtml = hasJoinUrl
    ? `<p>It's a quick video call. <a href="${escapeHtml(joinUrl)}">Join the video call</a></p>`
    : `<p>It's a quick video call — you'll find the link in your calendar invite.</p>`
  const text = [
    `Hi ${firstName},`,
    ``,
    `Your interview is confirmed for ${when}.`,
    ``,
    videoLineText,
    `See you then!`,
    ``,
    `— Claire @ WeKruit`,
  ].join("\n")
  const html =
    `<p>Hi ${escapeHtml(firstName)},</p>` +
    `<p>Your interview is confirmed for <strong>${escapeHtml(when)}</strong>.</p>` +
    videoLineHtml +
    `<p>See you then!</p>` +
    `<p>— Claire @ WeKruit</p>`

  let result: MailgunSendResult
  try {
    result = await sendMail(cfg, { to: input.to, subject, text, html })
  } catch (err) {
    // Fail-open: the booking is real; never break the turn on an email throw.
    return { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : "mailgun_threw" }
  }

  if (!result.ok) {
    return { ok: false, reason: `mailgun_status_${result.status}` }
  }

  const messageId = result.messageId ?? ""
  // Audit the successful send (same shape as runSendMailgunEmail). Best-effort —
  // a Firestore write hiccup must not flip a real send to ok:false.
  try {
    await input.db.collection("sent_emails").add({
      uid: input.userId,
      to: input.to,
      messageId,
      subject,
      sentAt: FieldValue.serverTimestamp(),
      status: "sent",
      provider: "mailgun",
      kind: "interview_confirmation",
      jobId: input.jobId,
      eventTypeId: input.eventTypeId,
    })
  } catch {
    /* best-effort audit — the email DID send */
  }

  return { ok: true, messageId }
}
