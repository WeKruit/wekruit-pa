/**
 * refer-program.ts — Candidate referral program backend (v2.0).
 *
 * Two-tier reward (Adam directive 2026-05-27):
 *   • $50    "interview" — invitee's first hiring-manager interview confirmed
 *   • $4,000 "placement" — invitee signs an offer
 *
 * Attribution rule (Adam Q5): invitee MUST sign up with the *same email*
 * the inviter sent the invite to. No fuzzy match. Strict lower-cased equality.
 *
 * Payouts (Adam Q4): manual for now — when a reward unlocks, the server emails
 * admin1@wekruit.com / adam.ylol@wekruit.com / noah.liu@wekruit.com with the
 * referral details. Ops reaches out to the inviter to collect bank/PayPal and
 * sends the payment manually. Payout automation deferred.
 *
 * Rate limit (Adam Q6): 25 invites per inviter per 24h rolling window.
 *
 * Exports five Cloud Functions:
 *   - paReferInviteSend       (callable) — send invites + write referral docs
 *   - paReferEnsureSlug       (callable) — idempotent slug creation
 *   - paReferLinkResolve      (callable) — /r/:slug → inviter display name
 *   - paReferDashboardList    (callable) — current user's referrals + totals
 *   - paReferOnPrescreenWrite (Firestore trigger on pa-prescreen-sessions)
 *   - paReferOnEmployerVisibleWrite (Firestore trigger on pa-employer-visible-profiles)
 *
 * Plus identity attribution helper `attachInviteeUserIdByEmail` used by the
 * candidate signup flow.
 *
 * Schema (see packages/core-types/src/collections.ts):
 *   pa-referrals/{id}
 *     inviterId             string  (pa-users/{uid})
 *     inviterSlug           string  (denormalized for fast lookup)
 *     inviteeEmail          string  (lower-cased)
 *     inviteeUserId?        string  (pa-users/{uid}, set on signup)
 *     stage                 "invited" | "joined" | "interviewing" | "placed"
 *     rewardInterviewAmount number  (50)
 *     rewardInterviewPaid   boolean (manual payout flag; true once ops sends)
 *     rewardPlacementAmount number  (4000)
 *     rewardPlacementPaid   boolean
 *     payoutStatus          "none" | "pending_interview" | "pending_placement" | "fully_paid"
 *     note                  string  (personal note shown in the invite)
 *     createdAt             Timestamp
 *     updatedAt             Timestamp
 *     detail?               string  (latest human-readable status snippet)
 *   pa-referral-slugs/{slug}    → { uid, createdAt }
 */
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore"
import { logger } from "firebase-functions/v2"
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https"
import { onDocumentWritten, type FirestoreEvent, type Change, type DocumentSnapshot } from "firebase-functions/v2/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { sendMailgun, type MailgunConfig } from "./email/mailgun.js"

const REWARD_INTERVIEW = 50
const REWARD_PLACEMENT = 4_000
const RATE_LIMIT_INVITES_PER_DAY = 25
const PAYOUT_NOTIFY_RECIPIENTS = "admin1@wekruit.com, adam.ylol@wekruit.com, noah.liu@wekruit.com"
const REFER_PRESCREEN_COLLECTION = "pa-prescreen-sessions"

// ────────────────────────────────────────────────────────────────────────────
// Mailgun helpers
// ────────────────────────────────────────────────────────────────────────────

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
    .replace(/'/g, "&#39;")
}

// ────────────────────────────────────────────────────────────────────────────
// Slug generation — short, URL-safe, derived from display name
// ────────────────────────────────────────────────────────────────────────────

const SLUG_RANDOM_SUFFIX_LEN = 4
const SLUG_BASE_MAX = 32

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, SLUG_BASE_MAX)
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 2 + SLUG_RANDOM_SUFFIX_LEN)
}

async function ensureSlugForUser(uid: string): Promise<string> {
  const db = getFirestore()
  // 1. If user already has a slug indexed, return it.
  const existing = await db
    .collection(PA_COLLECTIONS.referralSlugs)
    .where("uid", "==", uid)
    .limit(1)
    .get()
  if (!existing.empty) return existing.docs[0].id

  // 2. Pull display name from pa-users for a friendly base.
  const userSnap = await db.collection(PA_COLLECTIONS.users).doc(uid).get()
  const userData = userSnap.data() ?? {}
  const display = String(userData.displayName ?? userData.fullName ?? userData.firstName ?? "").trim()
  const base = slugify(display) || `friend-${uid.slice(0, 6)}`

  // 3. Try base, then base-<rand>, up to 5 attempts. Reserve via tx.
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${randomSuffix()}`
    const ref = db.collection(PA_COLLECTIONS.referralSlugs).doc(candidate)
    try {
      await db.runTransaction(async (tx) => {
        const cur = await tx.get(ref)
        if (cur.exists) throw new Error("slug_taken")
        tx.set(ref, { uid, createdAt: FieldValue.serverTimestamp() })
      })
      return candidate
    } catch (err) {
      if (err instanceof Error && err.message === "slug_taken") continue
      throw err
    }
  }
  throw new HttpsError("internal", "Could not allocate a unique referral slug")
}

// ────────────────────────────────────────────────────────────────────────────
// Rate limit (sliding 24h window per inviter)
// ────────────────────────────────────────────────────────────────────────────

async function inviteCountLast24h(uid: string): Promise<number> {
  const db = getFirestore()
  const since = Timestamp.fromDate(new Date(Date.now() - 24 * 60 * 60 * 1000))
  const snap = await db
    .collection(PA_COLLECTIONS.referrals)
    .where("inviterId", "==", uid)
    .where("createdAt", ">=", since)
    .count()
    .get()
  return snap.data().count
}

// ────────────────────────────────────────────────────────────────────────────
// paReferEnsureSlug
// ────────────────────────────────────────────────────────────────────────────

export const paReferEnsureSlug = onCall<unknown, Promise<{ slug: string }>>(
  { region: "us-central1" },
  async (req: CallableRequest<unknown>) => {
    if (!req.auth?.uid) throw new HttpsError("unauthenticated", "Sign in to use referrals")
    const slug = await ensureSlugForUser(req.auth.uid)
    return { slug }
  },
)

// ────────────────────────────────────────────────────────────────────────────
// paReferLinkResolve
// ────────────────────────────────────────────────────────────────────────────

export const paReferLinkResolve = onCall<{ slug: string }, Promise<{ name: string | null }>>(
  { region: "us-central1" },
  async (req: CallableRequest<{ slug: string }>) => {
    const slug = String(req.data?.slug ?? "")
      .trim()
      .toLowerCase()
    if (!slug) return { name: null }
    const db = getFirestore()
    const slugSnap = await db.collection(PA_COLLECTIONS.referralSlugs).doc(slug).get()
    if (!slugSnap.exists) return { name: null }
    const uid = slugSnap.get("uid") as string | undefined
    if (!uid) return { name: null }
    const userSnap = await db.collection(PA_COLLECTIONS.users).doc(uid).get()
    const userData = userSnap.data() ?? {}
    const name =
      (userData.displayName as string | undefined) ??
      (userData.fullName as string | undefined) ??
      (userData.firstName as string | undefined) ??
      null
    return { name: name ?? null }
  },
)

// ────────────────────────────────────────────────────────────────────────────
// paReferInviteSend
// ────────────────────────────────────────────────────────────────────────────

interface InviteSendInput {
  emails: string[]
  note: string
}

interface InviteSendResult {
  sent: number
  skipped: number
  rateLimited?: boolean
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const paReferInviteSend = onCall<InviteSendInput, Promise<InviteSendResult>>(
  { region: "us-central1", secrets: ["MAILGUN_API_KEY", "MAILGUN_DOMAIN", "MAILGUN_FROM", "MAILGUN_REGION"] },
  async (req: CallableRequest<InviteSendInput>) => {
    const uid = req.auth?.uid
    if (!uid) throw new HttpsError("unauthenticated", "Sign in to send invites")

    const rawEmails = Array.isArray(req.data?.emails) ? req.data.emails : []
    const note = String(req.data?.note ?? "").slice(0, 2_000)
    const emails = Array.from(
      new Set(
        rawEmails
          .map((e) => String(e ?? "").trim().toLowerCase())
          .filter((e) => EMAIL_RE.test(e)),
      ),
    )
    if (emails.length === 0) return { sent: 0, skipped: 0 }
    if (emails.length > 50) throw new HttpsError("invalid-argument", "Too many emails in one call")

    // Rate limit
    const sentLast24h = await inviteCountLast24h(uid)
    const budget = Math.max(0, RATE_LIMIT_INVITES_PER_DAY - sentLast24h)
    if (budget === 0) {
      throw new HttpsError("resource-exhausted", `Limit of ${RATE_LIMIT_INVITES_PER_DAY} invites/day reached`)
    }
    const toSend = emails.slice(0, budget)
    const rateLimited = emails.length > budget

    const slug = await ensureSlugForUser(uid)

    // Inviter display + email for the Mailgun copy
    const db = getFirestore()
    const inviterSnap = await db.collection(PA_COLLECTIONS.users).doc(uid).get()
    const inviterData = inviterSnap.data() ?? {}
    const inviterName =
      (inviterData.displayName as string | undefined) ??
      (inviterData.fullName as string | undefined) ??
      (inviterData.firstName as string | undefined) ??
      "a WeKruit candidate"
    const inviterFirstName = inviterName.split(/\s+/)[0]

    // Dedup against existing pa-referrals docs for this inviter+email
    const existingSnaps = await db
      .collection(PA_COLLECTIONS.referrals)
      .where("inviterId", "==", uid)
      .where("inviteeEmail", "in", toSend.slice(0, 10))
      .get()
    const alreadyInvited = new Set(existingSnaps.docs.map((d) => d.get("inviteeEmail") as string))

    const cfg = mailgunConfigFromEnv()
    let sent = 0
    let skipped = 0

    for (const inviteeEmail of toSend) {
      if (alreadyInvited.has(inviteeEmail)) {
        skipped++
        continue
      }
      const referralRef = db.collection(PA_COLLECTIONS.referrals).doc()
      await referralRef.set({
        inviterId: uid,
        inviterSlug: slug,
        inviteeEmail,
        inviteeUserId: null,
        stage: "invited",
        rewardInterviewAmount: REWARD_INTERVIEW,
        rewardInterviewPaid: false,
        rewardPlacementAmount: REWARD_PLACEMENT,
        rewardPlacementPaid: false,
        payoutStatus: "none",
        note,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        detail: "Invite delivered — not opened yet.",
      })

      // Send email
      if (cfg) {
        const link = `https://wekruit.com/r/${slug}?ref=${slug}`
        const subject = `${inviterFirstName} thinks WeKruit could be a fit`
        const text = [
          `Hey —`,
          ``,
          note ||
            `${inviterFirstName} has been using WeKruit (Claire is the AI recruiter that screens you over iMessage and books you with hiring managers directly).`,
          ``,
          `If you take an interview, ${inviterFirstName} earns $${REWARD_INTERVIEW}.`,
          `If you sign an offer, ${inviterFirstName} earns $${REWARD_PLACEMENT}.`,
          `Costs you nothing — same flow every candidate gets.`,
          ``,
          `Start here: ${link}`,
          ``,
          `— WeKruit`,
        ].join("\n")
        const html =
          `<p style="font-family:system-ui;font-size:15px;line-height:1.55;color:#2d1a0a;margin:0 0 14px">Hey —</p>` +
          `<p style="font-family:system-ui;font-size:15px;line-height:1.55;color:#2d1a0a;margin:0 0 18px">${escapeHtml(
            note ||
              `${inviterFirstName} has been using WeKruit. Claire (their AI recruiter) screens you over iMessage and books you with hiring managers directly.`,
          )}</p>` +
          `<p style="font-family:system-ui;font-size:14px;line-height:1.6;color:#5a4636;margin:0 0 22px">` +
          `If you take an interview, <strong>${escapeHtml(inviterFirstName)} earns $${REWARD_INTERVIEW}</strong>. ` +
          `If you sign an offer, <strong>$${REWARD_PLACEMENT}</strong>. Costs you nothing.</p>` +
          `<p style="margin:0 0 28px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#2d1a0a;color:#f5ede3;text-decoration:none;padding:12px 22px;border-radius:999px;font-family:system-ui;font-weight:600">Start with Claire →</a></p>` +
          `<p style="font-family:system-ui;font-size:12px;color:#897462;margin:0">— WeKruit</p>`

        try {
          const res = await sendMailgun(cfg, { to: inviteeEmail, subject, text, html })
          if (!res.ok) {
            logger.warn("paReferInviteSend.mailgun_failed", {
              inviteeEmail,
              status: res.status,
              rawResponse: res.rawResponse,
            })
          }
        } catch (err) {
          logger.error("paReferInviteSend.mailgun_threw", {
            inviteeEmail,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      } else {
        logger.warn("paReferInviteSend.mailgun_not_configured", { uid, inviteeEmail })
      }

      sent++
    }
    return { sent, skipped, rateLimited }
  },
)

// ────────────────────────────────────────────────────────────────────────────
// paReferDashboardList
// ────────────────────────────────────────────────────────────────────────────

interface DashboardItem {
  id: string
  name: string | null
  email: string
  stage: "invited" | "joined" | "interviewing" | "placed"
  detail: string
  paid: number
  pending: number
  when: string
}

interface DashboardOut {
  referrals: DashboardItem[]
  totalEarned: number
  totalPending: number
  activeCount: number
  slug: string | null
}

function relativeWhen(t: Timestamp | undefined): string {
  if (!t) return ""
  const ageMs = Date.now() - t.toMillis()
  const day = 24 * 60 * 60 * 1000
  if (ageMs < 60 * 60 * 1000) return `${Math.max(1, Math.round(ageMs / (60 * 1000)))}m`
  if (ageMs < day) return `${Math.round(ageMs / (60 * 60 * 1000))}h`
  if (ageMs < 7 * day) return `${Math.round(ageMs / day)}d`
  return t.toDate().toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

export const paReferDashboardList = onCall<unknown, Promise<DashboardOut>>(
  { region: "us-central1" },
  async (req: CallableRequest<unknown>) => {
    const uid = req.auth?.uid
    if (!uid) throw new HttpsError("unauthenticated", "Sign in to view your referrals")

    const db = getFirestore()

    // Ensure slug exists (idempotent — first dashboard visit creates it).
    const slug = await ensureSlugForUser(uid).catch((err) => {
      logger.error("paReferDashboardList.ensureSlugFailed", { uid, err: String(err) })
      return null
    })

    const referralsSnap = await db
      .collection(PA_COLLECTIONS.referrals)
      .where("inviterId", "==", uid)
      .orderBy("createdAt", "desc")
      .limit(200)
      .get()

    let totalEarned = 0
    let totalPending = 0
    let activeCount = 0
    const referrals: DashboardItem[] = []

    // Best-effort name lookup for invitees who linked
    const inviteeUids = referralsSnap.docs
      .map((d) => d.get("inviteeUserId") as string | undefined)
      .filter((x): x is string => !!x)
    const nameByUid = new Map<string, string>()
    if (inviteeUids.length > 0) {
      const unique = Array.from(new Set(inviteeUids)).slice(0, 30)
      const userDocs = await db.getAll(
        ...unique.map((u) => db.collection(PA_COLLECTIONS.users).doc(u)),
      )
      for (const d of userDocs) {
        if (!d.exists) continue
        const data = d.data() ?? {}
        const name =
          (data.displayName as string | undefined) ??
          (data.fullName as string | undefined) ??
          (data.firstName as string | undefined)
        if (name) nameByUid.set(d.id, name)
      }
    }

    for (const doc of referralsSnap.docs) {
      const data = doc.data()
      const stage = (data.stage ?? "invited") as DashboardItem["stage"]
      const interviewPaid = !!data.rewardInterviewPaid
      const placementPaid = !!data.rewardPlacementPaid
      const interviewAmount = Number(data.rewardInterviewAmount ?? REWARD_INTERVIEW)
      const placementAmount = Number(data.rewardPlacementAmount ?? REWARD_PLACEMENT)
      const paid = (interviewPaid ? interviewAmount : 0) + (placementPaid ? placementAmount : 0)
      const pending =
        (interviewPaid ? 0 : interviewAmount) + (placementPaid ? 0 : placementAmount)

      totalEarned += paid
      if (stage !== "placed") {
        totalPending += pending
        activeCount++
      }

      const inviteeUserId = data.inviteeUserId as string | undefined
      const name = inviteeUserId ? nameByUid.get(inviteeUserId) ?? null : null

      referrals.push({
        id: doc.id,
        name,
        email: data.inviteeEmail as string,
        stage,
        detail: (data.detail as string | undefined) ?? defaultDetailForStage(stage),
        paid,
        pending,
        when: relativeWhen(data.updatedAt as Timestamp | undefined),
      })
    }

    return { referrals, totalEarned, totalPending, activeCount, slug }
  },
)

function defaultDetailForStage(stage: DashboardItem["stage"]): string {
  switch (stage) {
    case "invited":
      return "Invite delivered — not opened yet."
    case "joined":
      return "Joined. Claire is matching them now."
    case "interviewing":
      return "Interviewing with a hiring manager."
    case "placed":
      return "Placed. Offer signed."
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Identity attribution — called from candidate signup flow
// (Phase C7 — onboarding code path; export so it can be re-used.)
// ────────────────────────────────────────────────────────────────────────────

/**
 * On candidate signup, attach the new user's uid to any pending referral row
 * matched by lower-cased email. Marks stage=joined and writes the inviter's
 * referralSource for downstream attribution. Idempotent.
 */
export async function attachInviteeUserIdByEmail(args: {
  uid: string
  email: string
}): Promise<{ matchedReferralId?: string }> {
  const email = args.email.trim().toLowerCase()
  if (!email) return {}
  const db = getFirestore()
  const snap = await db
    .collection(PA_COLLECTIONS.referrals)
    .where("inviteeEmail", "==", email)
    .where("inviteeUserId", "==", null)
    .orderBy("createdAt", "desc")
    .limit(1)
    .get()
  if (snap.empty) return {}
  const docRef = snap.docs[0].ref
  await docRef.update({
    inviteeUserId: args.uid,
    stage: "joined",
    detail: "Joined. Claire is matching them now.",
    updatedAt: FieldValue.serverTimestamp(),
  })
  logger.info("refer.attachInviteeUserIdByEmail.matched", {
    referralId: docRef.id,
    uid: args.uid,
  })
  return { matchedReferralId: docRef.id }
}

// ────────────────────────────────────────────────────────────────────────────
// paReferOnPrescreenWrite — Firestore trigger
// On pa-prescreen-sessions write where terminal status becomes "pass" or
// "passed", find the referral by candidate email, mark stage=interviewing
// + rewardInterviewPaid (= unlocked, ops pays manually) and email admins.
// ────────────────────────────────────────────────────────────────────────────

type PrescreenDoc = {
  status?: string
  candidateId?: string
  candidateEmail?: string
  jobId?: string
  jobTitle?: string
  companyName?: string
}

export const paReferOnPrescreenWrite = onDocumentWritten(
  {
    document: `${REFER_PRESCREEN_COLLECTION}/{sessionId}`,
    region: "us-central1",
    secrets: ["MAILGUN_API_KEY", "MAILGUN_DOMAIN", "MAILGUN_FROM", "MAILGUN_REGION"],
  },
  async (event: FirestoreEvent<Change<DocumentSnapshot> | undefined>) => {
    const after = event.data?.after.data() as PrescreenDoc | undefined
    const before = event.data?.before.data() as PrescreenDoc | undefined
    if (!after) return
    const status = (after.status ?? "").toLowerCase()
    const beforeStatus = (before?.status ?? "").toLowerCase()
    if (status !== "pass" && status !== "passed") return
    if (status === beforeStatus) return // already handled

    const email = (after.candidateEmail ?? "").trim().toLowerCase()
    const candidateId = after.candidateId
    if (!email && !candidateId) return

    const db = getFirestore()
    const query = email
      ? db.collection(PA_COLLECTIONS.referrals).where("inviteeEmail", "==", email)
      : db.collection(PA_COLLECTIONS.referrals).where("inviteeUserId", "==", candidateId)
    const snap = await query.where("stage", "in", ["invited", "joined"]).limit(1).get()
    if (snap.empty) return

    const refDoc = snap.docs[0]
    await refDoc.ref.update({
      stage: "interviewing",
      rewardInterviewPaid: true, // unlocked; ops queue pays manually
      payoutStatus: "pending_interview",
      detail: after.jobTitle
        ? `Interviewing with ${after.companyName ?? "an employer"} — ${after.jobTitle}.`
        : `Interviewing now.`,
      updatedAt: FieldValue.serverTimestamp(),
    })

    await notifyAdminsPayoutDue({
      stage: "interview",
      amount: REWARD_INTERVIEW,
      referralId: refDoc.id,
      inviterId: refDoc.get("inviterId") as string,
      inviteeEmail: email,
      jobTitle: after.jobTitle,
      companyName: after.companyName,
    })
  },
)

// ────────────────────────────────────────────────────────────────────────────
// paReferOnEmployerVisibleWrite — Firestore trigger
// On pa-employer-visible-profiles write with outcome === "offer_signed",
// mark referral stage=placed + rewardPlacementPaid + email admins.
// ────────────────────────────────────────────────────────────────────────────

type EmployerVisibleDoc = {
  outcome?: string
  candidateId?: string
  candidateEmail?: string
  jobId?: string
  jobTitle?: string
  companyName?: string
}

export const paReferOnEmployerVisibleWrite = onDocumentWritten(
  {
    document: `${PA_COLLECTIONS.employerVisibleProfiles}/{evpId}`,
    region: "us-central1",
    secrets: ["MAILGUN_API_KEY", "MAILGUN_DOMAIN", "MAILGUN_FROM", "MAILGUN_REGION"],
  },
  async (event: FirestoreEvent<Change<DocumentSnapshot> | undefined>) => {
    const after = event.data?.after.data() as EmployerVisibleDoc | undefined
    const before = event.data?.before.data() as EmployerVisibleDoc | undefined
    if (!after) return
    if ((after.outcome ?? "").toLowerCase() !== "offer_signed") return
    if ((before?.outcome ?? "").toLowerCase() === "offer_signed") return // dedupe

    const email = (after.candidateEmail ?? "").trim().toLowerCase()
    const candidateId = after.candidateId
    if (!email && !candidateId) return

    const db = getFirestore()
    const query = email
      ? db.collection(PA_COLLECTIONS.referrals).where("inviteeEmail", "==", email)
      : db.collection(PA_COLLECTIONS.referrals).where("inviteeUserId", "==", candidateId)
    const snap = await query.limit(1).get()
    if (snap.empty) return

    const refDoc = snap.docs[0]
    await refDoc.ref.update({
      stage: "placed",
      rewardPlacementPaid: true,
      payoutStatus: refDoc.get("rewardInterviewPaid") ? "fully_paid" : "pending_placement",
      detail: after.jobTitle
        ? `Placed at ${after.companyName ?? "an employer"} as ${after.jobTitle}.`
        : `Placed. Offer signed.`,
      updatedAt: FieldValue.serverTimestamp(),
    })

    await notifyAdminsPayoutDue({
      stage: "placement",
      amount: REWARD_PLACEMENT,
      referralId: refDoc.id,
      inviterId: refDoc.get("inviterId") as string,
      inviteeEmail: email,
      jobTitle: after.jobTitle,
      companyName: after.companyName,
    })
  },
)

// ────────────────────────────────────────────────────────────────────────────
// Manual payout notification (Adam Q4)
// ────────────────────────────────────────────────────────────────────────────

async function notifyAdminsPayoutDue(args: {
  stage: "interview" | "placement"
  amount: number
  referralId: string
  inviterId: string
  inviteeEmail: string
  jobTitle?: string
  companyName?: string
}): Promise<void> {
  const cfg = mailgunConfigFromEnv()
  if (!cfg) {
    logger.warn("refer.notifyAdminsPayoutDue.mailgun_not_configured", args)
    return
  }
  const db = getFirestore()
  const inviterSnap = await db.collection(PA_COLLECTIONS.users).doc(args.inviterId).get()
  const inviterData = inviterSnap.data() ?? {}
  const inviterName =
    (inviterData.displayName as string | undefined) ??
    (inviterData.fullName as string | undefined) ??
    args.inviterId
  const inviterEmail = (inviterData.email as string | undefined) ?? "—"

  const subject = `Referral payout due — $${args.amount} (${args.stage}) for ${inviterName}`
  const lines = [
    `Stage:    ${args.stage}`,
    `Amount:   $${args.amount}`,
    `Inviter:  ${inviterName} (${inviterEmail})`,
    `Invitee:  ${args.inviteeEmail || "(via candidateId)"}`,
    args.companyName ? `Company:  ${args.companyName}` : null,
    args.jobTitle ? `Role:     ${args.jobTitle}` : null,
    ``,
    `Referral doc: pa-referrals/${args.referralId}`,
    `Inviter uid:  ${args.inviterId}`,
    ``,
    `Reach out to ${inviterName} for payout details (bank or PayPal).`,
  ]
    .filter((x): x is string => x !== null)
    .join("\n")
  const html =
    `<h2 style="font-family:system-ui;margin:0 0 12px">Referral payout due — $${args.amount}</h2>` +
    `<p style="font-family:system-ui;font-size:14px;color:#5a4636;margin:0 0 16px">` +
    `Stage: <b>${args.stage}</b><br>` +
    `Inviter: <b>${escapeHtml(inviterName)}</b> &lt;${escapeHtml(inviterEmail)}&gt;<br>` +
    `Invitee email: ${escapeHtml(args.inviteeEmail || "(via candidateId)")}<br>` +
    (args.companyName ? `Company: ${escapeHtml(args.companyName)}<br>` : "") +
    (args.jobTitle ? `Role: ${escapeHtml(args.jobTitle)}<br>` : "") +
    `</p>` +
    `<p style="font-family:system-ui;font-size:13px;color:#897462;margin:0">Referral doc: <code>pa-referrals/${escapeHtml(args.referralId)}</code></p>`

  try {
    await sendMailgun(cfg, { to: PAYOUT_NOTIFY_RECIPIENTS, subject, text: lines, html })
  } catch (err) {
    logger.error("refer.notifyAdminsPayoutDue.send_threw", {
      err: err instanceof Error ? err.message : String(err),
      referralId: args.referralId,
    })
  }
}
