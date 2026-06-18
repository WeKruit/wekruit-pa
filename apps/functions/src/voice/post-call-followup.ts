/**
 * Webhook-owned post-call follow-up.
 *
 * The LiveKit/Twilio webhook is the source of truth for `voiceState:
 * "completed"`. This trigger reacts only to that state transition, reads the
 * stored voice turns, and sends one opt-in follow-up through pa-outbound.
 */
import { onDocumentWritten } from "firebase-functions/v2/firestore"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { enqueueOutbound } from "@pa/pa-broker"
import type { OutboundBookingRow } from "./types.js"

export type VoiceTurnForFollowup = {
  userTranscript?: string | null
  claireReply?: string | null
  createdAt?: string | null
}

export function isCompletedCallTransition(
  before: OutboundBookingRow | undefined,
  after: OutboundBookingRow | undefined,
): boolean {
  return before?.voiceState !== "completed" && after?.voiceState === "completed"
}

function cleanSnippet(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.?!]+$/g, "")
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

export function composePostCallFollowup(input: {
  purpose?: "prescreen" | "onboarding" | null
  turns: VoiceTurnForFollowup[]
}): string {
  const snippets = input.turns
    .map((turn) => (typeof turn.userTranscript === "string" ? cleanSnippet(turn.userTranscript) : ""))
    .filter(Boolean)
    .slice(0, 3)
  const prefix = input.purpose === "prescreen" ? "your prescreen answers" : "your background and preferences"
  const summary = snippets.length > 0
    ? `${prefix}: ${truncate(snippets.join("; "), 170)}`
    : prefix
  return `thanks for taking the time — I got: ${summary}. want me to pull a few roles that fit from here?`
}

async function readTurns(db: Firestore, bookingId: string): Promise<VoiceTurnForFollowup[]> {
  const snap = await db
    .collection("outbound-bookings")
    .doc(bookingId)
    .collection("turns")
    .get()
  return snap.docs
    .map((doc) => doc.data() as VoiceTurnForFollowup)
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))
}

async function claimFollowup(db: Firestore, bookingId: string, nowIso: string): Promise<{
  claimed: boolean
  booking: OutboundBookingRow | null
}> {
  const ref = db.collection("outbound-bookings").doc(bookingId)
  const dbAny = db as unknown as {
    runTransaction?: <T>(fn: (tx: {
      get: (ref: unknown) => Promise<{ exists?: boolean; data?: () => Record<string, unknown> | undefined }>
      set: (ref: unknown, data: Record<string, unknown>, opts?: { merge?: boolean }) => void | Promise<unknown>
    }) => Promise<T>) => Promise<T>
  }
  if (typeof dbAny.runTransaction === "function") {
    return dbAny.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists) return { claimed: false, booking: null }
      const booking = snap.data?.() as OutboundBookingRow | undefined
      if (!booking || booking.voiceState !== "completed") return { claimed: false, booking: booking ?? null }
      const status = booking.postCallFollowupStatus
      if (status === "processing" || status === "sent" || status === "skipped") {
        return { claimed: false, booking }
      }
      tx.set(
        ref,
        {
          postCallFollowupStatus: "processing",
          postCallFollowupStartedAt: nowIso,
          postCallFollowupUpdatedAt: nowIso,
        },
        { merge: true },
      )
      return { claimed: true, booking }
    })
  }
  const snap = await ref.get()
  const booking = snap.exists ? snap.data() as OutboundBookingRow : null
  if (!booking || booking.voiceState !== "completed" || booking.postCallFollowupStatus) {
    return { claimed: false, booking }
  }
  await ref.set(
    {
      postCallFollowupStatus: "processing",
      postCallFollowupStartedAt: nowIso,
      postCallFollowupUpdatedAt: nowIso,
    },
    { merge: true },
  )
  return { claimed: true, booking }
}

export async function handleVoicePostCallFollowup(input: {
  bookingId: string
  before: OutboundBookingRow | undefined
  after: OutboundBookingRow | undefined
  db: Firestore
  nowIso?: string
}): Promise<{ action: string; message?: string; reason?: string }> {
  const { bookingId, before, after, db } = input
  if (!isCompletedCallTransition(before, after)) {
    return { action: "skipped", reason: "not_completed_transition" }
  }
  if (after?.postCallFollowupStatus) {
    return { action: "skipped", reason: "already_stamped" }
  }

  const nowIso = input.nowIso ?? new Date().toISOString()
  const claim = await claimFollowup(db, bookingId, nowIso)
  if (!claim.claimed || !claim.booking) {
    return { action: "skipped", reason: "claim_failed_or_already_processed" }
  }

  const booking = claim.booking
  const ref = db.collection("outbound-bookings").doc(bookingId)
  const userId = typeof booking.paUserId === "string" ? booking.paUserId.trim() : ""
  const toE164 = typeof booking.phoneE164 === "string" ? booking.phoneE164.trim() : ""
  if (!userId || !toE164) {
    await ref.set(
      {
        postCallFollowupStatus: "skipped",
        postCallFollowupReason: "missing_user_or_phone",
        postCallFollowupUpdatedAt: nowIso,
      },
      { merge: true },
    )
    return { action: "skipped", reason: "missing_user_or_phone" }
  }

  const turns = await readTurns(db, bookingId)
  const userTurns = turns.filter((turn) => typeof turn.userTranscript === "string" && turn.userTranscript.trim().length > 0)
  if (userTurns.length === 0) {
    await ref.set(
      {
        postCallFollowupStatus: "skipped",
        postCallFollowupReason: "no_voice_turns",
        postCallFollowupUpdatedAt: nowIso,
      },
      { merge: true },
    )
    return { action: "skipped", reason: "no_voice_turns" }
  }

  const purpose = booking.purpose === "prescreen" || booking.purpose === "onboarding"
    ? booking.purpose
    : undefined
  const message = composePostCallFollowup({ purpose, turns: userTurns })
  try {
    await enqueueOutbound(db, {
      userId,
      toE164,
      body: message,
      runtimeApproved: true,
      runtimeSource: "pa_voice_post_call",
      idempotencyKey: `voice-post-call:${bookingId}`,
    })
    await ref.set(
      {
        postCallFollowupStatus: "sent",
        postCallFollowupSentAt: nowIso,
        postCallFollowupUpdatedAt: nowIso,
        postCallFollowupMessage: message,
      },
      { merge: true },
    )
    return { action: "sent", message }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await ref.set(
      {
        postCallFollowupStatus: "failed",
        postCallFollowupReason: truncate(error, 300),
        postCallFollowupUpdatedAt: nowIso,
      },
      { merge: true },
    )
    throw err
  }
}

export const paVoicePostCallFollowup = onDocumentWritten(
  {
    document: "outbound-bookings/{bookingId}",
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 60,
    concurrency: 20,
  },
  async (event) => {
    const bookingId = event.params.bookingId
    const before = event.data?.before?.data() as OutboundBookingRow | undefined
    const after = event.data?.after?.data() as OutboundBookingRow | undefined
    try {
      const result = await handleVoicePostCallFollowup({
        bookingId,
        before,
        after,
        db: getFirestore(),
      })
      logger.info("paVoicePostCallFollowup:result", { bookingId, ...result })
    } catch (err) {
      logger.error("paVoicePostCallFollowup:error", {
        bookingId,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  },
)
