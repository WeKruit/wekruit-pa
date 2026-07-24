/**
 * headhunter-mcp/email-interview-offer.ts — `email_interview_offer` tool runner.
 *
 * Emails a CANDIDATE their real Cal.com interview times as one-click "Book <time>"
 * links (each link → the public paBookInterviewViaLink GET CF, token+slot gated).
 *
 * This is a NEW candidate-outreach channel, so it is hardened like the rest of
 * the scheduling write-path ([[outbound_safety_rules_locked]]):
 *  - Eligibility-gated (isSchedulingEligible — dev cohort / paSchedulingEnabled).
 *  - CONFIRM-FIRST (deterministic): confirm !== true → dry-run, sends NOTHING.
 *  - Reuses buildInterviewOffer (the SAME persisted-offer + offerToken path the
 *    candidate / proactive / headhunter offer use), so the email's links resolve
 *    against the same pa-interview-bookings doc the candidate's pick books.
 *  - Mailgun transport reused (claire@mg.wekruit.com), audited to
 *    pa-headhunter-emails (source: "email_interview_offer").
 *
 * The operator supplies candidateEmail explicitly (the agent restates it on the
 * confirm-first round); we do NOT auto-resolve+cold-email an address here.
 */
import type { Firestore } from "firebase-admin/firestore"
import { FieldValue } from "firebase-admin/firestore"
import type { ClaireToolContext } from "../claire-agent/types.js"
import { buildInterviewOffer } from "../claire-agent/tools/scheduling-tools.js"
import { isSchedulingEligible } from "../claire-agent/scheduling-gate.js"
import { isYcPeopleUser } from "@pa/core-types"
import { sendMailgun, type MailgunConfig } from "../email/mailgun.js"
import {
  generateConvToken,
  persistEmailThread,
  verpReplyToAddress,
} from "../email/email-thread.js"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Base URL of the public booking CF (us-central1, project wekruit-5f89b). */
const BOOK_FN_BASE_URL =
  "https://us-central1-wekruit-5f89b.cloudfunctions.net/paBookInterviewViaLink"

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

/** Build the token-gated public booking link for one offered slot. */
function bookLink(args: { userId: string; jobId: string; offerToken: string; iso: string }): string {
  const p = new URLSearchParams({
    u: args.userId,
    j: args.jobId,
    t: args.offerToken,
    s: args.iso,
  })
  return `${BOOK_FN_BASE_URL}?${p.toString()}`
}

export type EmailInterviewOfferArgs = {
  userId?: string
  candidateEmail?: string
  jobId?: string
  confirm?: boolean
}

export type EmailInterviewOfferResult = {
  sent: boolean
  reason?: string
  note?: string
  to?: string
  slotCount?: number
  jobId?: string
  messageId?: string
  auditId?: string
}

/**
 * Email a candidate their interview slots as one-click booking links.
 * Confirm-first; eligibility-gated; reuses the persisted-offer + offerToken path.
 */
export async function runEmailInterviewOffer(
  args: EmailInterviewOfferArgs,
  deps: { db: Firestore },
): Promise<EmailInterviewOfferResult> {
  const userId = (args.userId ?? "").trim()
  const to = (args.candidateEmail ?? "").trim().toLowerCase()
  if (!userId) return { sent: false, reason: "missing_userId" }
  if (!EMAIL_RE.test(to)) return { sent: false, reason: "invalid_recipient_email" }

  // YC PEOPLE LANE — never email a YC founder/investor a JOB interview offer (Adam-LOCKED
  // 2026-07-24). The candidate-pool tools now exclude YC users, but this send takes a userId
  // directly from an operator/agent call, so it needs its own gate. Fail-CLOSED: an unreadable user
  // cannot be proven non-YC, and this is an outbound job offer to a real person.
  try {
    const snap = await deps.db.collection("pa-users").doc(userId).get()
    if (isYcPeopleUser(snap.data() ?? {})) {
      return { sent: false, reason: "yc_people_no_job_interview", to }
    }
  } catch {
    return { sent: false, reason: "yc_people_check_failed", to }
  }

  // GATE — dev cohort / paSchedulingEnabled only (real candidates no-op).
  if (!(await isSchedulingEligible(deps.db, userId, { env: process.env }))) {
    return {
      sent: false,
      reason: "scheduling_not_enabled",
      to,
      note: "candidate is not in the scheduling dev cohort and the paSchedulingEnabled flag is off (today: dev users only). No email was sent.",
    }
  }

  // Build the minimal ctx for the SDK-free offer core (mirror runScheduleInterview).
  const ctx = {
    db: deps.db,
    userId,
    sessionId: `hh-email-sched-${userId}`,
    lang: "en" as const,
    judgeModel: "gpt-5.4-nano",
    jobId: args.jobId,
    log: () => undefined,
    nowIso: () => new Date().toISOString(),
  } as unknown as ClaireToolContext

  // Build (and persist) the real offer FIRST — needed both to preview the slot
  // count on the dry-run and to mint/reuse the offerToken for the links. This is
  // a READ on Cal.com + a persist of the offer doc; it sends no email and books
  // nothing (the candidate-facing side effect is only the email below).
  const offer = await buildInterviewOffer(ctx, {
    timeZone: null,
    partOfDay: null,
    jobChoice: args.jobId ?? null,
  })
  if (!offer.ok) {
    // Surface the offer-failure reason verbatim (no_schedulable_job /
    // needs_job_choice / calcom_unavailable / no_slots).
    return { sent: false, reason: offer.reason, to, note: "Could not build interview slots to email." }
  }

  // CONFIRM-FIRST — dry-run sends NOTHING. Restate recipient + slot count.
  if (args.confirm !== true) {
    return {
      sent: false,
      reason: "not_confirmed",
      to,
      slotCount: offer.count,
      jobId: offer.jobId,
      note: `Dry run — this EMAILS the candidate at ${to} ${offer.count} interview time${offer.count === 1 ? "" : "s"} as one-click booking links (a real candidate-facing message). Restate the recipient + slot count to the operator, get an explicit yes, then call again with confirm:true.`,
    }
  }

  // Compose the email. Each slot is a "Book <label>" link to the public CF.
  const linkRows = offer.slots
    .map((s) => {
      const href = bookLink({ userId, jobId: offer.jobId, offerToken: offer.offerToken, iso: s.iso })
      return `<tr><td style="padding:6px 0"><a href="${escapeHtml(href)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:9px;font-size:15px">Book ${escapeHtml(s.label)}</a></td></tr>`
    })
    .join("")
  const textLines = offer.slots
    .map((s) => `• ${s.label}\n  ${bookLink({ userId, jobId: offer.jobId, offerToken: offer.offerToken, iso: s.iso })}`)
    .join("\n\n")

  const subject = "Pick a time for your WeKruit interview"
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a;max-width:560px">
<p>Hi,</p>
<p>Great news — the team would love to interview you. Pick whichever time works best and you're booked instantly:</p>
<table cellpadding="0" cellspacing="0" role="presentation">${linkRows}</table>
<p style="color:#777;font-size:13px;margin-top:20px">All times are shown in ${escapeHtml(offer.timeZone)}. Just click a button to confirm — if none of these work, reply and we'll find another time.</p>
<p style="margin-top:18px">— Claire @ WeKruit</p>
</div>`
  const text = `Hi,\n\nGreat news — the team would love to interview you. Pick whichever time works best and you're booked instantly:\n\n${textLines}\n\nAll times are shown in ${offer.timeZone}. Just open a link to confirm — if none of these work, reply and we'll find another time.\n\n— Claire @ WeKruit`

  // Mint a VERP conversation token + persist the thread mapping so candidate
  // replies route back to us (TWO-WAY). The token is the Reply-To local-part.
  const convToken = generateConvToken()
  const replyTo = verpReplyToAddress(convToken)
  await persistEmailThread(deps.db, {
    convToken,
    userId,
    jobId: offer.jobId,
    candidateEmail: to,
    subject,
    lastDirection: "outbound",
    source: "email_interview_offer",
  }).catch(() => undefined) // fail-open: a missing thread doc only loses reply-threading

  // Audit FIRST (fail-open), then send.
  const ref = deps.db.collection("pa-headhunter-emails").doc()
  await ref.set({
    to,
    subject,
    userId,
    jobId: offer.jobId,
    slotCount: offer.count,
    convToken,
    status: "pending",
    source: "email_interview_offer",
    createdAt: FieldValue.serverTimestamp(),
  })

  const cfg = mailgunConfigFromEnv()
  if (!cfg) {
    await ref.set({ status: "not_configured", updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    return { sent: false, reason: "email_not_configured", to, slotCount: offer.count, jobId: offer.jobId, auditId: ref.id }
  }

  try {
    const res = await sendMailgun(cfg, { to, subject, text, html, replyTo })
    if (res.ok) {
      await ref.set(
        { status: "sent", mailgunMessageId: res.messageId ?? null, mailgunStatus: res.status, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      )
      return { sent: true, to, slotCount: offer.count, jobId: offer.jobId, messageId: res.messageId, auditId: ref.id }
    }
    await ref.set({ status: "failed", mailgunStatus: res.status, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    return { sent: false, reason: `mailgun_status_${res.status}`, to, slotCount: offer.count, jobId: offer.jobId, auditId: ref.id }
  } catch {
    await ref.set({ status: "error", updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    return { sent: false, reason: "email_send_error", to, slotCount: offer.count, jobId: offer.jobId, auditId: ref.id }
  }
}
