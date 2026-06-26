/**
 * headhunter-mcp/email.ts — `send_email` tool runner.
 *
 * Gives the headhunter an EMAIL channel (the QA scorecard flagged email=absent).
 * Scope is deliberate: this emails a CLIENT / hiring manager / internal recipient
 * (e.g. a candidate brief or prescreen summary the operator dictates) — it is NOT
 * a candidate-outreach channel. Candidates stay SMS-only via `send_candidate_message`
 * (one-channel-per-user + consent rules, see [[outbound_safety_rules_locked]]).
 *
 * SAFETY: the operator supplies the recipient explicitly; the tool is MUTATING and
 * the agent restates + gets confirmation before calling. Every send is audited to
 * `pa-headhunter-emails`. Reuses the canonical Mailgun transport (claire@mg.wekruit.com),
 * the same sender proven live by the onboarding invite / connect-request emails.
 */
import type { Firestore } from "firebase-admin/firestore"
import { FieldValue } from "firebase-admin/firestore"
import { sendMailgun, type MailgunConfig } from "../email/mailgun.js"
import {
  generateConvToken,
  persistEmailThread,
  verpReplyToAddress,
} from "../email/email-thread.js"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Build the Mailgun config from env (same shape every prod caller inlines). */
function mailgunConfigFromEnv(): MailgunConfig | null {
  const apiKey = process.env.MAILGUN_API_KEY ?? ""
  const domain = process.env.MAILGUN_DOMAIN ?? ""
  if (!apiKey || !domain) return null
  const from = process.env.MAILGUN_FROM ?? `WeKruit Claire <claire@${domain}>`
  const region = (process.env.MAILGUN_REGION === "eu" ? "eu" : "us") as "us" | "eu"
  return { apiKey, domain, from, region }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export type SendEmailArgs = { to?: string; subject?: string; body?: string; confirm?: boolean }
export type SendEmailResult = {
  sent: boolean
  reason?: string
  note?: string
  to?: string
  subject?: string
  messageId?: string
  auditId?: string
}

/**
 * Send ONE email to an operator-specified recipient (client / hiring manager /
 * internal). Records an audit doc first (fail-open), then sends via Mailgun.
 * `sent` reflects the real Mailgun result — never a fake success.
 */
export async function runSendEmail(args: SendEmailArgs, deps: { db: Firestore }): Promise<SendEmailResult> {
  const to = (args.to ?? "").trim()
  const subject = (args.subject ?? "").trim()
  const body = (args.body ?? "").trim()
  if (!EMAIL_RE.test(to)) return { sent: false, reason: "invalid_recipient_email" }
  if (!subject) return { sent: false, reason: "empty_subject" }
  if (subject.length > 200) return { sent: false, reason: "subject_too_long" }
  if (!body) return { sent: false, reason: "empty_body" }
  if (body.length > 8000) return { sent: false, reason: "body_too_long" }

  // CONFIRM-FIRST gate (deterministic — persona instructions alone don't hold a
  // weak model). First call (confirm omitted/false) sends NOTHING and records
  // nothing; it returns the recipient/subject for the operator to approve. Only
  // confirm:true actually sends. Mirrors confirm_interview_booking.
  if (args.confirm !== true) {
    return {
      sent: false,
      reason: "not_confirmed",
      to,
      subject,
      note: `Dry run — this sends a REAL email to ${to} (subject: "${subject}"). Restate the recipient + subject to the operator, get an explicit yes, then call again with confirm:true.`,
    }
  }

  // Mint a VERP conversation token + persist the thread mapping so replies
  // route back to us (TWO-WAY). The token is the Reply-To local-part.
  const convToken = generateConvToken()
  const replyTo = verpReplyToAddress(convToken)
  await persistEmailThread(deps.db, {
    convToken,
    candidateEmail: to,
    subject,
    lastDirection: "outbound",
    source: "headhunter_mcp",
  }).catch(() => undefined) // fail-open: a missing thread doc only loses reply-threading

  const ref = deps.db.collection("pa-headhunter-emails").doc()
  await ref.set({
    to,
    subject,
    body: body.slice(0, 8000),
    convToken,
    status: "pending",
    source: "headhunter_mcp",
    createdAt: FieldValue.serverTimestamp(),
  })

  const cfg = mailgunConfigFromEnv()
  if (!cfg) {
    await ref.set({ status: "not_configured", updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    return { sent: false, reason: "email_not_configured", to, subject, auditId: ref.id }
  }

  try {
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">${escapeHtml(
      body,
    ).replace(/\n/g, "<br>")}</div>`
    const res = await sendMailgun(cfg, { to, subject, text: body, html, replyTo })
    if (res.ok) {
      await ref.set(
        { status: "sent", mailgunMessageId: res.messageId ?? null, mailgunStatus: res.status, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      )
      return { sent: true, to, subject, messageId: res.messageId, auditId: ref.id }
    }
    await ref.set({ status: "failed", mailgunStatus: res.status, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    return { sent: false, reason: `mailgun_status_${res.status}`, to, subject, auditId: ref.id }
  } catch {
    await ref.set({ status: "error", updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    return { sent: false, reason: "email_send_error", to, subject, auditId: ref.id }
  }
}
