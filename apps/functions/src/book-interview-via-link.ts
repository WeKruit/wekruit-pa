/**
 * book-interview-via-link.ts — `paBookInterviewViaLink` public GET CF.
 *
 * The candidate clicks a "Book <time>" link in their interview-offer email
 * (built by the headhunter `email_interview_offer` tool). The link is:
 *
 *   https://us-central1-wekruit-5f89b.cloudfunctions.net/paBookInterviewViaLink
 *     ?u=<userId>&j=<jobId>&t=<offerToken>&s=<encodeURIComponent(iso)>
 *
 * This is an UNAUTHENTICATED candidate-facing SIDE EFFECT (real Cal.com booking
 * + Mailgun confirmation email), so it is hardened:
 *
 *  1. TOKEN GATE — loads the pa-interview-bookings doc by interviewBookingDocId
 *     (NOT recomputed from PII) and constant-time-compares `t` to the persisted
 *     `offerToken`. A mismatch / absent token → friendly 400 HTML, NO booking.
 *  2. SLOT GATE — `s` MUST be one of the persisted `offeredSlots[].iso` (the
 *     same set bookInterviewSlotCore validates against). Not offered → 400 HTML.
 *  3. CONFIRM-ON-CLICK — to avoid email-scanner / link-preview prefetch bots
 *     auto-firing a GET and booking, a bare link click renders a confirmation
 *     page with a one-click POST-style "Confirm" link carrying `&confirm=1`.
 *     Only `confirm=1` calls bookInterviewSlotCore. (HEAD/prefetch never books.)
 *  4. DELEGATES to the EXACT SDK-free `bookInterviewSlotCore` the candidate tool
 *     + headhunter book-on-behalf runner use — same offered-slot resolution,
 *     dedup / reschedule guards, Cal POST, persistence, and confirmation email.
 *     The core does NOT self-gate; the token+slot validation above IS the gate
 *     (the offer only exists for an eligible user the headhunter offered to).
 *
 * Secrets: binds CALCOM_API_KEY + MAILGUN_* (createBooking reads
 * process.env.CALCOM_API_KEY; sendInterviewConfirmationEmail reads MAILGUN_*),
 * hydrated into process.env inside the handler (mirror of public-cv-ingest.ts).
 */
import { timingSafeEqual } from "node:crypto"
import { onRequest } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { InterviewBookingSchema, interviewBookingDocId } from "@pa/core-types"
import {
  bookInterviewSlotCore,
  humanLabel,
} from "./claire-agent/tools/scheduling-tools.js"
import type { ClaireToolContext } from "./claire-agent/types.js"

const INTERVIEW_BOOKINGS_COLLECTION = "pa-interview-bookings"
const DEFAULT_TIMEZONE = "America/New_York"

// Same-name defineSecret() refs hydrate from the same Firebase Secret the
// orchestrator binds (index.ts). createBooking + sendInterviewConfirmationEmail
// read these from process.env, so they must be bound on THIS CF too.
const CALCOM_API_KEY = defineSecret("CALCOM_API_KEY")
const MAILGUN_API_KEY = defineSecret("MAILGUN_API_KEY")
const MAILGUN_DOMAIN = defineSecret("MAILGUN_DOMAIN")
const MAILGUN_FROM = defineSecret("MAILGUN_FROM")
const MAILGUN_REGION = defineSecret("MAILGUN_REGION")

/** Constant-time string compare (defeats timing oracles on the offer token). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  if (ab.length !== bb.length) return false
  try {
    return timingSafeEqual(ab, bb)
  } catch {
    return false
  }
}

/** First value of an Express query param (string | string[] | undefined). */
function q(v: unknown): string {
  if (typeof v === "string") return v.trim()
  if (Array.isArray(v) && typeof v[0] === "string") return v[0].trim()
  return ""
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Branded WeKruit HTML shell. `tone` drives the accent strip color. */
function page(args: { title: string; heading: string; body: string; tone?: "success" | "info" | "error" }): string {
  const accent = args.tone === "success" ? "#16a34a" : args.tone === "error" ? "#dc2626" : "#2563eb"
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(args.title)} · WeKruit</title>
<style>
  body{margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a}
  .wrap{max-width:560px;margin:48px auto;padding:0 20px}
  .card{background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:hidden}
  .strip{height:6px;background:${accent}}
  .pad{padding:32px}
  h1{font-size:22px;margin:0 0 12px}
  p{font-size:16px;line-height:1.55;margin:0 0 14px;color:#333}
  .btn{display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:600;
       padding:13px 22px;border-radius:10px;margin-top:6px}
  .muted{color:#777;font-size:13px;margin-top:22px}
  a.link{color:${accent}}
  .brand{font-weight:700;letter-spacing:.3px;color:#111;font-size:14px;margin-bottom:18px}
</style></head>
<body><div class="wrap"><div class="card"><div class="strip"></div><div class="pad">
<div class="brand">WeKruit</div>
<h1>${escapeHtml(args.heading)}</h1>
${args.body}
<div class="muted">If anything looks off, just reply to your WeKruit text or email and a teammate will help.</div>
</div></div></div></body></html>`
}

/** Reusable friendly-error renderer. */
function sendError(
  res: { set: (k: string, v: string) => unknown; status: (n: number) => { send: (b: string) => unknown } },
  status: number,
  heading: string,
  message: string,
): void {
  res.set("Content-Type", "text/html; charset=utf-8")
  res.status(status).send(
    page({ title: "Booking", heading, tone: "error", body: `<p>${escapeHtml(message)}</p>` }),
  )
}

export const paBookInterviewViaLink = onRequest(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
    cors: false, // browser-navigated GET; no preflight needed
    secrets: [CALCOM_API_KEY, MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM, MAILGUN_REGION],
  },
  async (req, res) => {
    // Only GET (the email link). HEAD/POST/etc. → 405 (and never books).
    if (req.method !== "GET") {
      res.set("Content-Type", "text/html; charset=utf-8")
      res.status(405).send(page({ title: "Booking", heading: "Method not allowed", tone: "error", body: "<p>Use the link from your email.</p>" }))
      return
    }

    // Hydrate secrets into process.env so createBooking (CALCOM_API_KEY) +
    // sendInterviewConfirmationEmail (MAILGUN_*) — both read process.env — work.
    const hydrate = (ref: { value: () => string }, key: string): void => {
      try {
        const v = ref.value().trim()
        if (v) process.env[key] = v
      } catch {
        /* secret unavailable — core fails-open to calcom_unavailable / no email */
      }
    }
    hydrate(CALCOM_API_KEY, "CALCOM_API_KEY")
    hydrate(MAILGUN_API_KEY, "MAILGUN_API_KEY")
    hydrate(MAILGUN_DOMAIN, "MAILGUN_DOMAIN")
    hydrate(MAILGUN_FROM, "MAILGUN_FROM")
    hydrate(MAILGUN_REGION, "MAILGUN_REGION")

    const userId = q(req.query.u)
    const jobId = q(req.query.j)
    const token = q(req.query.t)
    const slotIso = q(req.query.s)
    const confirm = q(req.query.confirm) === "1"

    if (!userId || !jobId || !token || !slotIso) {
      sendError(res, 400, "This link is incomplete", "The booking link is missing some information. Please use the most recent link from your email.")
      return
    }

    const db: Firestore = getFirestore()

    // Load the booking doc by the DETERMINISTIC id (never recomputed from PII).
    const docId = interviewBookingDocId({ userId, jobId })
    let doc: Partial<import("@pa/core-types").InterviewBooking> | null = null
    try {
      const snap = await db.collection(INTERVIEW_BOOKINGS_COLLECTION).doc(docId).get()
      if (snap.exists) {
        const parsed = InterviewBookingSchema.partial().safeParse(snap.data())
        doc = parsed.success ? parsed.data : null
      }
    } catch {
      doc = null
    }

    if (!doc) {
      sendError(res, 404, "We couldn't find this invitation", "This interview invitation may have expired. Reply to your WeKruit message and we'll send a fresh set of times.")
      return
    }

    // (1) TOKEN GATE — constant-time compare against the persisted offerToken.
    const persistedToken = typeof doc.offerToken === "string" ? doc.offerToken : ""
    if (!persistedToken || !safeEqual(token, persistedToken)) {
      sendError(res, 400, "This link is no longer valid", "We couldn't verify this booking link. Please use the most recent invitation email, or reply and we'll resend it.")
      return
    }

    // (2) SLOT GATE — the requested ISO must be one we actually offered.
    const offered = Array.isArray(doc.offeredSlots) ? doc.offeredSlots : []
    const isOffered = offered.some((s) => s.iso === slotIso)
    if (!isOffered) {
      sendError(res, 400, "That time isn't available anymore", "The time on this link is no longer on offer. Reply to your WeKruit message for a fresh set of times.")
      return
    }

    const tz = typeof doc.timeZone === "string" && doc.timeZone ? doc.timeZone : DEFAULT_TIMEZONE
    const when = humanLabel(slotIso, tz)

    // (3) CONFIRM-ON-CLICK — a bare GET (e.g. an email-scanner prefetch) renders
    // a confirmation page and books NOTHING. Only an explicit confirm=1 click
    // (a human pressing the button) actually creates the interview.
    if (!confirm) {
      const confirmUrl = `?u=${encodeURIComponent(userId)}&j=${encodeURIComponent(jobId)}&t=${encodeURIComponent(token)}&s=${encodeURIComponent(slotIso)}&confirm=1`
      res.set("Content-Type", "text/html; charset=utf-8")
      res.status(200).send(
        page({
          title: "Confirm interview",
          heading: "Confirm your interview time",
          tone: "info",
          body:
            `<p>You're about to lock in your interview for:</p>` +
            `<p style="font-size:18px;font-weight:700;color:#111">${escapeHtml(when)}</p>` +
            `<p><a class="btn" href="${escapeHtml(confirmUrl)}">Confirm this time</a></p>`,
        }),
      )
      return
    }

    // (4) BOOK — delegate to the shared SDK-free core. Build the minimal ctx
    // exactly as the headhunter book-on-behalf runner does (bookInterviewSlotCore
    // reads only db/userId/jobId/sessionId/nowIso/log — never `transport`). No
    // toE164 (book-on-behalf): the candidate's email + calendar invite still go.
    const ctx = {
      db,
      userId,
      sessionId: `email-sched-${userId}`,
      lang: "en",
      judgeModel: "gpt-5.4-nano",
      jobId,
      log: (event: string, payload?: Record<string, unknown>) =>
        console.log(JSON.stringify({ event, ...(payload ?? {}) })),
      nowIso: () => new Date().toISOString(),
    } as unknown as ClaireToolContext

    let result: Awaited<ReturnType<typeof bookInterviewSlotCore>>
    try {
      result = await bookInterviewSlotCore(ctx, {
        slotNumber: null,
        slotIso,
        statedTime: null, // the link encodes the exact slot — no AM/PM guard needed
        candidateEmail: typeof doc.candidateEmail === "string" ? doc.candidateEmail : null,
        candidateName: null,
        timeZone: tz,
      })
    } catch {
      // bookInterviewSlotCore is fail-OPEN, but belt-and-suspenders.
      sendError(res, 200, "Something went wrong", "We hit a snag locking in your time. Reply to your WeKruit message and we'll sort it out right away.")
      return
    }

    res.set("Content-Type", "text/html; charset=utf-8")

    if (result.ok && (result.action === "booked" || result.action === "already_booked")) {
      const joinBlock = result.meetingUrl
        ? `<p><a class="btn" href="${escapeHtml(result.meetingUrl)}">Join the interview</a></p>` +
          `<p class="muted" style="margin-top:8px">Or copy this link: <a class="link" href="${escapeHtml(result.meetingUrl)}">${escapeHtml(result.meetingUrl)}</a></p>`
        : `<p>You'll get the meeting link by email shortly.</p>`
      const headline = result.action === "already_booked" ? "You're already confirmed" : "Your interview is confirmed"
      res.status(200).send(
        page({
          title: "Interview confirmed",
          heading: `✅ ${headline}`,
          tone: "success",
          body:
            `<p>Your interview is set for:</p>` +
            `<p style="font-size:18px;font-weight:700;color:#111">${escapeHtml(result.when)}</p>` +
            joinBlock +
            `<p class="muted">A confirmation email is on its way.</p>`,
        }),
      )
      return
    }

    // Failure reasons → friendly, never a raw error.
    if (!result.ok && result.reason === "already_booked_other_slot") {
      res.status(200).send(
        page({
          title: "Already booked",
          heading: "You already have an interview booked",
          tone: "info",
          body:
            `<p>You're already locked in for <strong>${escapeHtml(result.when)}</strong>.</p>` +
            `<p>If you need to change it, reply to your WeKruit message and a teammate will help — we don't reschedule from this link to avoid double-booking the interviewer.</p>`,
        }),
      )
      return
    }

    if (!result.ok && (result.reason === "slots_expired" || result.reason === "slot_unavailable")) {
      res.status(200).send(
        page({
          title: "Time no longer available",
          heading: "That time just got taken",
          tone: "info",
          body: `<p>The slot you picked isn't available anymore. Reply to your WeKruit message and we'll send you a fresh set of times right away.</p>`,
        }),
      )
      return
    }

    if (!result.ok && result.reason === "need_email") {
      res.status(200).send(
        page({
          title: "One more thing",
          heading: "We need your email to confirm",
          tone: "info",
          body: `<p>Reply to your WeKruit message with the best email for the calendar invite and we'll lock this in.</p>`,
        }),
      )
      return
    }

    // calcom_unavailable / slot_not_offered / anything else.
    res.status(200).send(
      page({
        title: "Couldn't confirm",
        heading: "We couldn't lock in that time",
        tone: "error",
        body: `<p>Something went wrong on our side. Reply to your WeKruit message and we'll get your interview booked manually.</p>`,
      }),
    )
  },
)
