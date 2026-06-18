/**
 * tools/voice-call-tools.ts — explicit opt-in voice calls for thin Claire.
 *
 * Two-step contract:
 *   1. offer_voice_call writes a pending offer and sends "can I call you now?"
 *   2. resolve_voice_call_offer turns only an active confirmed offer into one
 *      immediate outbound call row. Expired or declined offers never dial.
 */
import { randomUUID } from "node:crypto"
import { tool, z } from "../sdk.js"
import type { ClaireToolContext } from "../types.js"
import { runPreScreenForUser } from "../../prescreen-session-start.js"
import { isClaireVoiceDevPhone } from "../../voice/dev-phone-gate.js"
import { loadCandidateRoles, type CollabRole } from "./matching-tools.js"

export type VoiceCallPurpose = "prescreen" | "onboarding"
export type VoiceCallOfferStatus = "pending" | "confirmed" | "declined" | "expired"

export const VOICE_CALL_OFFERS_COLLECTION = "pa-voice-call-offers"
export const OUTBOUND_BOOKINGS_COLLECTION = "outbound-bookings"
export const VOICE_CALL_OFFER_TTL_MS = 10 * 60 * 1000

type VoiceCallOfferDoc = {
  userId: string
  sessionId: string
  purpose: VoiceCallPurpose
  paJobId?: string
  phoneE164: string
  status: VoiceCallOfferStatus
  createdAt: string
  expiresAt: string
  updatedAt: string
  outboundBookingId?: string
  prescreenSessionId?: string
  matchedRoleValidatedAt?: string
}

type PendingOffer = {
  id: string
  data: VoiceCallOfferDoc
  ref: {
    get?: () => Promise<{ exists?: boolean; data?: () => Record<string, unknown> | undefined }>
    set: (data: Record<string, unknown>, opts?: { merge?: boolean }) => Promise<unknown>
  }
}

function stripUndefined<T extends Record<string, unknown>>(input: T): T {
  for (const key of Object.keys(input)) {
    if (input[key] === undefined) delete input[key]
  }
  return input
}

function maskPhone(phoneE164: string): string {
  const last4 = phoneE164.replace(/\D/g, "").slice(-4)
  return last4 ? `the number ending in ${last4}` : "your verified phone number"
}

function normalizePurpose(raw: unknown): VoiceCallPurpose | null {
  return raw === "prescreen" || raw === "onboarding" ? raw : null
}

function offerText(input: { purpose: VoiceCallPurpose; phoneE164: string }): string {
  const phone = maskPhone(input.phoneE164)
  if (input.purpose === "prescreen") {
    return `Want to do the prescreen as a quick call now? I can call you at ${phone}. Reply yes and I'll call now, or no and we'll keep it over text.`
  }
  return `Want to do a quick 2 minute call now so I can understand you better? I can call you at ${phone}. Reply yes and I'll call now, or no and we'll keep it over text.`
}

async function resolvePhoneE164(ctx: ClaireToolContext): Promise<string> {
  const fromTurn = (ctx.toE164 ?? "").trim()
  if (fromTurn) return fromTurn
  const snap = await ctx.db.collection("pa-users").doc(ctx.userId).get()
  const data = snap.exists ? snap.data() as { phoneE164?: unknown } | undefined : undefined
  return typeof data?.phoneE164 === "string" ? data.phoneE164.trim() : ""
}

function parseOfferDoc(id: string, raw: Record<string, unknown>, ref: PendingOffer["ref"]): PendingOffer | null {
  const purpose = normalizePurpose(raw.purpose)
  const status = raw.status === "pending" || raw.status === "confirmed" || raw.status === "declined" || raw.status === "expired"
    ? raw.status
    : null
  if (!purpose || !status) return null
  if (typeof raw.userId !== "string" || typeof raw.sessionId !== "string") return null
  if (typeof raw.phoneE164 !== "string" || typeof raw.createdAt !== "string" || typeof raw.expiresAt !== "string") return null
  return {
    id,
    ref,
    data: stripUndefined({
      userId: raw.userId,
      sessionId: raw.sessionId,
      purpose,
      paJobId: typeof raw.paJobId === "string" ? raw.paJobId : undefined,
      phoneE164: raw.phoneE164,
      status,
      createdAt: raw.createdAt,
      expiresAt: raw.expiresAt,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : raw.createdAt,
      outboundBookingId: typeof raw.outboundBookingId === "string" ? raw.outboundBookingId : undefined,
      prescreenSessionId: typeof raw.prescreenSessionId === "string" ? raw.prescreenSessionId : undefined,
      matchedRoleValidatedAt: typeof raw.matchedRoleValidatedAt === "string" ? raw.matchedRoleValidatedAt : undefined,
    }),
  }
}

function roleLabel(role: CollabRole): string {
  const title = role.title.trim() || "this role"
  const company = role.company.trim()
  return company ? `${title} @ ${company}` : title
}

function isStartablePrescreenRole(role: CollabRole): boolean {
  return role.status !== "passed" && role.status !== "not_passed" && role.status !== "under_review"
}

function roleClarificationText(roles: CollabRole[]): string {
  const startable = roles.filter(isStartablePrescreenRole)
  if (startable.length === 0) {
    return "I need to anchor the phone screen to the exact role first. Which role should I call you about?"
  }
  const choices = startable.slice(0, 5).map(roleLabel).join(", ")
  return `I need to anchor the phone screen to the exact matched role first. Which role should I call you about: ${choices}?`
}

async function validatePrescreenRoleForCall(ctx: ClaireToolContext, paJobId: string): Promise<{
  ok: boolean
  role?: CollabRole
  roles: CollabRole[]
  reason?: "role_needs_clarification" | "role_already_completed"
}> {
  const roles = await loadCandidateRoles(ctx.db, ctx.userId, ctx.log)
  const role = roles.find((r) => r.jobId === paJobId)
  if (!role) return { ok: false, roles, reason: "role_needs_clarification" }
  if (!isStartablePrescreenRole(role)) return { ok: false, role, roles, reason: "role_already_completed" }
  return { ok: true, role, roles }
}

async function sendPrescreenRoleClarification(ctx: ClaireToolContext, roles: CollabRole[]): Promise<void> {
  await ctx.transport.sendText(roleClarificationText(roles))
}

async function findLatestPendingOffer(ctx: ClaireToolContext): Promise<PendingOffer | null> {
  const snap = await ctx.db
    .collection(VOICE_CALL_OFFERS_COLLECTION)
    .where("userId", "==", ctx.userId)
    .where("status", "==", "pending")
    .limit(20)
    .get()
  const offers: PendingOffer[] = []
  for (const doc of snap.docs ?? []) {
    const data = doc.data() as Record<string, unknown>
    if (data.sessionId !== ctx.sessionId) continue
    const parsed = parseOfferDoc(doc.id, data, doc.ref as PendingOffer["ref"])
    if (parsed) offers.push(parsed)
  }
  offers.sort((a, b) => b.data.createdAt.localeCompare(a.data.createdAt))
  return offers[0] ?? null
}

function isExpired(offer: VoiceCallOfferDoc, nowMs: number): boolean {
  const expiresMs = Date.parse(offer.expiresAt)
  return Number.isFinite(expiresMs) && expiresMs <= nowMs
}

async function ensurePrescreenSessionForOffer(ctx: ClaireToolContext, offer: PendingOffer): Promise<{
  ok: boolean
  sessionId?: string
  reason?: string
}> {
  if (offer.data.purpose !== "prescreen") return { ok: true }
  if (offer.data.prescreenSessionId) return { ok: true, sessionId: offer.data.prescreenSessionId }
  const paJobId = offer.data.paJobId ?? ""
  if (!paJobId) return { ok: false, reason: "missing_jobId" }
  const result = await runPreScreenForUser({
    db: ctx.db,
    jobId: paJobId,
    userId: offer.data.userId,
    toE164: offer.data.phoneE164,
    suppressFirstQuestion: true,
    skipProfileReadinessHold: true,
    ...(offer.data.matchedRoleValidatedAt ? { allowMatchedBypass: true } : {}),
    sendSms: async () => undefined,
    log: ctx.log,
  })
  if (!result.ok) {
    return { ok: false, reason: result.reason ?? "prescreen_start_failed", sessionId: result.sessionId }
  }
  return { ok: true, sessionId: result.sessionId }
}

async function createBookingForOffer(ctx: ClaireToolContext, offer: PendingOffer, nowIso: string, opts: {
  prescreenSessionId?: string
} = {}): Promise<{
  ok: boolean
  bookingId?: string
  reason?: string
}> {
  const bookingId = offer.data.outboundBookingId ?? `voice-${offer.id}`
  const booking = stripUndefined({
    id: bookingId,
    source: "thin_claire_voice_offer",
    offerId: offer.id,
    paUserId: offer.data.userId,
    sessionId: offer.data.sessionId,
    phoneE164: offer.data.phoneE164,
    purpose: offer.data.purpose,
    paJobId: offer.data.purpose === "prescreen" ? offer.data.paJobId : undefined,
    prescreenSessionId: offer.data.purpose === "prescreen" ? opts.prescreenSessionId : undefined,
    voiceState: "dialing",
    voiceRequestedAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  })
  const bookingRef = ctx.db.collection(OUTBOUND_BOOKINGS_COLLECTION).doc(bookingId)
  const db = ctx.db as unknown as {
    runTransaction?: <T>(fn: (tx: {
      get: (ref: unknown) => Promise<{ exists?: boolean; data?: () => Record<string, unknown> | undefined }>
      set: (ref: unknown, data: Record<string, unknown>, opts?: { merge?: boolean }) => void | Promise<unknown>
    }) => Promise<T>) => Promise<T>
  }

  if (typeof db.runTransaction === "function") {
    return db.runTransaction(async (tx) => {
      const currentSnap = await tx.get(offer.ref)
      const current = currentSnap.exists ? currentSnap.data?.() : undefined
      const currentOffer = current ? parseOfferDoc(offer.id, current, offer.ref) : null
      if (!currentOffer || currentOffer.data.status !== "pending") {
        return {
          ok: false,
          bookingId: currentOffer?.data.outboundBookingId,
          reason: "offer_not_pending",
        }
      }
      if (isExpired(currentOffer.data, Date.parse(nowIso))) {
        tx.set(offer.ref, { status: "expired", expiredAt: nowIso, updatedAt: nowIso }, { merge: true })
        return { ok: false, reason: "offer_expired" }
      }
      if (currentOffer.data.purpose === "prescreen" && !currentOffer.data.paJobId) {
        return { ok: false, reason: "missing_jobId" }
      }
      tx.set(bookingRef, booking)
      tx.set(
        offer.ref,
        {
          status: "confirmed",
          confirmedAt: nowIso,
          updatedAt: nowIso,
          outboundBookingId: bookingId,
          ...(opts.prescreenSessionId ? { prescreenSessionId: opts.prescreenSessionId } : {}),
        },
        { merge: true },
      )
      return { ok: true, bookingId }
    })
  }

  if (offer.data.purpose === "prescreen" && !offer.data.paJobId) {
    return { ok: false, reason: "missing_jobId" }
  }
  await bookingRef.set(booking)
  await offer.ref.set(
    {
      status: "confirmed",
      confirmedAt: nowIso,
      updatedAt: nowIso,
      outboundBookingId: bookingId,
      ...(opts.prescreenSessionId ? { prescreenSessionId: opts.prescreenSessionId } : {}),
    },
    { merge: true },
  )
  return { ok: true, bookingId }
}

export async function offerVoiceCallNow(
  ctx: ClaireToolContext,
  input: { purpose: VoiceCallPurpose; jobId?: string | null },
): Promise<
  | { ok: true; delivered: true; offerId: string; expiresAt: string }
  | {
      ok: false
      delivered: boolean
      reason:
        | "missing_jobId"
        | "missing_phoneE164"
        | "voice_call_not_enabled"
        | "role_needs_clarification"
        | "role_already_completed"
      roles?: Array<{ jobId: string; company: string; title: string; status: CollabRole["status"] | null }>
    }
> {
  const { purpose, jobId } = input
  const paJobId = purpose === "prescreen" ? (jobId ?? ctx.jobId ?? "").trim() : undefined
  if (purpose === "prescreen" && !paJobId) {
    return { ok: false as const, delivered: false as const, reason: "missing_jobId" as const }
  }
  const phoneE164 = await resolvePhoneE164(ctx)
  if (!phoneE164) {
    return { ok: false as const, delivered: false as const, reason: "missing_phoneE164" as const }
  }
  if (!isClaireVoiceDevPhone(phoneE164)) {
    ctx.log("pa.claire.voice.dev_phone_gate", { userId: ctx.userId, purpose })
    return { ok: false as const, delivered: false as const, reason: "voice_call_not_enabled" as const }
  }

  const nowIso = ctx.nowIso()
  const offerId = randomUUID()
  const createdMs = Date.parse(nowIso)
  const expiresAt = new Date((Number.isFinite(createdMs) ? createdMs : Date.now()) + VOICE_CALL_OFFER_TTL_MS).toISOString()
  const validation = purpose === "prescreen" ? await validatePrescreenRoleForCall(ctx, paJobId ?? "") : null
  if (validation && !validation.ok) {
    await sendPrescreenRoleClarification(ctx, validation.roles)
    ctx.log("pa.claire.voice.offer_role_not_startable", {
      userId: ctx.userId,
      purpose,
      paJobId,
      reason: validation.reason ?? "role_needs_clarification",
    })
    return {
      ok: false as const,
      delivered: true as const,
      reason: validation.reason ?? "role_needs_clarification" as const,
      roles: validation.roles.map((r) => ({ jobId: r.jobId, company: r.company, title: r.title, status: r.status ?? null })),
    }
  }
  const offer = stripUndefined({
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    purpose,
    paJobId,
    phoneE164,
    status: "pending" as const,
    createdAt: nowIso,
    expiresAt,
    updatedAt: nowIso,
    matchedRoleValidatedAt: purpose === "prescreen" ? nowIso : undefined,
  })
  await ctx.db.collection(VOICE_CALL_OFFERS_COLLECTION).doc(offerId).set(offer)
  const text = offerText({ purpose, phoneE164 })
  await ctx.transport.sendText(text)
  ctx.log("pa.claire.voice.offer_created", { userId: ctx.userId, offerId, purpose, paJobId: paJobId ?? null })
  return { ok: true as const, delivered: true as const, offerId, expiresAt }
}

export function buildVoiceCallTools(ctx: ClaireToolContext) {
  // Voice calls are dev-phone-only while this is being validated. If the
  // current turn does not carry a known dev phone, do not expose the tools.
  if (!isClaireVoiceDevPhone(ctx.toE164)) return []

  const offerVoiceCall = tool({
    name: "offer_voice_call",
    description:
      "Create a pending Claire voice-call offer and ask explicit permission before calling. " +
      "Use when the candidate wants or would benefit from doing the prescreen/onboarding by phone. " +
      "This tool only asks 'can I call you now?'; it never schedules a future time and never starts a call. " +
      "For purpose='prescreen', pass the exact jobId.",
    parameters: z.object({
      purpose: z.enum(["prescreen", "onboarding"]),
      jobId: z.string().nullable(),
    }),
    async execute({ purpose, jobId }) {
      return offerVoiceCallNow(ctx, { purpose, jobId })
    },
  })

  const resolveVoiceCallOffer = tool({
    name: "resolve_voice_call_offer",
    description:
      "Resolve the candidate's yes/no answer to Claire's active voice-call offer. " +
      "Call with confirmed=true only after an explicit yes to the immediate call ask. " +
      "A confirmed active offer creates exactly one immediate outbound call record with voiceState='dialing'. " +
      "Declined or expired offers never start a call.",
    parameters: z.object({
      confirmed: z.boolean(),
    }),
    async execute({ confirmed }) {
      const nowIso = ctx.nowIso()
      const offer = await findLatestPendingOffer(ctx)
      if (!offer) {
        await ctx.transport.sendText("I don't have an active call offer right now. Want me to ask again before calling?")
        return { ok: false as const, delivered: true as const, reason: "no_active_offer" as const }
      }
      if (!isClaireVoiceDevPhone(offer.data.phoneE164)) {
        await offer.ref.set({ status: "declined", declinedAt: nowIso, updatedAt: nowIso, declineReason: "voice_call_not_enabled" }, { merge: true })
        ctx.log("pa.claire.voice.resolve_dev_phone_gate", { userId: ctx.userId, offerId: offer.id, purpose: offer.data.purpose })
        return { ok: false as const, delivered: false as const, reason: "voice_call_not_enabled" as const, offerId: offer.id }
      }
      const nowMs = Date.parse(nowIso)
      if (isExpired(offer.data, Number.isFinite(nowMs) ? nowMs : Date.now())) {
        await offer.ref.set({ status: "expired", expiredAt: nowIso, updatedAt: nowIso }, { merge: true })
        await ctx.transport.sendText("That call offer expired, so I won't call from that yes. Want me to ask again before calling?")
        return { ok: false as const, delivered: true as const, reason: "offer_expired" as const, offerId: offer.id }
      }
      if (!confirmed) {
        await offer.ref.set({ status: "declined", declinedAt: nowIso, updatedAt: nowIso }, { merge: true })
        await ctx.transport.sendText("No worries — we'll keep it over text.")
        return { ok: true as const, delivered: true as const, offerId: offer.id, status: "declined" as const }
      }

      if (offer.data.purpose === "prescreen" && !offer.data.matchedRoleValidatedAt) {
        const roles = await loadCandidateRoles(ctx.db, ctx.userId, ctx.log)
        await offer.ref.set(
          {
            status: "expired",
            expiredAt: nowIso,
            updatedAt: nowIso,
            expireReason: "unvalidated_prescreen_role",
          },
          { merge: true },
        )
        await sendPrescreenRoleClarification(ctx, roles)
        return {
          ok: false as const,
          delivered: true as const,
          reason: "role_needs_clarification" as const,
          offerId: offer.id,
        }
      }

      const prescreen = await ensurePrescreenSessionForOffer(ctx, offer)
      if (!prescreen.ok) {
        if (offer.data.purpose === "prescreen" && (prescreen.reason === "not_matched" || prescreen.reason === "missing_jobId")) {
          const roles = await loadCandidateRoles(ctx.db, ctx.userId, ctx.log)
          await offer.ref.set(
            {
              status: "expired",
              expiredAt: nowIso,
              updatedAt: nowIso,
              expireReason: prescreen.reason,
            },
            { merge: true },
          )
          await sendPrescreenRoleClarification(ctx, roles)
          return {
            ok: false as const,
            delivered: true as const,
            reason: prescreen.reason ?? "prescreen_start_failed",
            offerId: offer.id,
          }
        }
        await ctx.transport.sendText("I can't start that phone screen yet, so I won't call from this yes. We can keep it over text for now.")
        return {
          ok: false as const,
          delivered: true as const,
          reason: prescreen.reason ?? "prescreen_start_failed",
          offerId: offer.id,
        }
      }
      const result = await createBookingForOffer(ctx, offer, nowIso, { prescreenSessionId: prescreen.sessionId })
      if (!result.ok) {
        const reason = result.reason ?? "booking_not_created"
        if (reason === "offer_expired") {
          await ctx.transport.sendText("That call offer expired, so I won't call from that yes. Want me to ask again before calling?")
          return { ok: false as const, delivered: true as const, reason, offerId: offer.id }
        }
        return { ok: false as const, delivered: false as const, reason, offerId: offer.id }
      }
      await ctx.transport.sendText("Calling you now.")
      ctx.log("pa.claire.voice.booking_created", {
        userId: ctx.userId,
        offerId: offer.id,
        bookingId: result.bookingId,
        purpose: offer.data.purpose,
      })
      return {
        ok: true as const,
        delivered: true as const,
        offerId: offer.id,
        bookingId: result.bookingId,
        voiceState: "dialing" as const,
      }
    },
  })

  return [offerVoiceCall, resolveVoiceCallOffer]
}
