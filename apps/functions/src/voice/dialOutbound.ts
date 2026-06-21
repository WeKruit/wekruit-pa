/**
 * S3 (v2.1) — paVoiceDialOutbound dispatcher.
 *
 * Fired by Firestore on every `outbound-bookings/{id}` write. Reacts ONLY
 * when the row transitions `before.voiceState !== "dialing"` → `after.voiceState === "dialing"`.
 *
 * Lock contract:
 *   L5  — short-circuit + transition to failed if required booking identity
 *         is missing. Every call requires `paUserId` + phone; prescreen also
 *         requires `paJobId`. LLM never sees missing-identity
 *         rows.
 *   L10 — only deterministic transitions touch the row (dialing → connected
 *         only on webhook callback, never optimistically from here).
 *   L12 — LiveKit Cloud SDK call; no self-host config.
 *
 * The function exposes the pure handler `handleDialOutbound` (used by the
 * Cloud Functions wrapper AND by unit tests with fake Firestore + fake
 * LiveKit SDK).
 */

import type { VoiceState } from "./state-machine.js"
import { isForwardTransition } from "./state-machine.js"
import type {
  OutboundBookingRow,
  SipClientLike,
  SipParticipantInfo,
} from "./types.js"
import type { CallerIdStrategy } from "./caller-id-rotator.js"
import { isClaireVoiceDevPhone } from "./dev-phone-gate.js"

/**
 * Minimal Firestore document/ref surface dialOutbound depends on. Tests pass
 * a fake; production wires the real `firebase-admin/firestore` `DocumentReference`.
 */
export interface BookingDocRef {
  set(data: Partial<OutboundBookingRow>, opts?: { merge?: boolean }): Promise<unknown>
}

export interface DialOutboundDeps {
  sipClient: SipClientLike
  callerIdStrategy: CallerIdStrategy
  trunkSid: string
  /**
   * Dispatch the named voice agent to the room BEFORE the SIP call (LiveKit
   * telephony best practice — https://docs.livekit.io/sip/outbound-calls/).
   * The agent connects + warms (context, STT/LLM/TTS) during the ring so it
   * greets the instant the candidate answers, instead of cold-starting on the
   * live call (~20s dead air). Optional so tests / legacy paths skip it.
   */
  dispatchAgent?: (args: { roomName: string; metadata: string }) => Promise<void>
  /**
   * Optional override of how the room name is derived from a booking id.
   * Default = identity (room name === bookingId), per AGENT_PLAN §3.2.
   */
  deriveRoomName?: (bookingId: string) => string
  /**
   * Optional injected clock for deterministic timestamps in tests.
   */
  now?: () => Date
  /**
   * Optional sink for structured log lines. Production wires to firebase
   * logger; tests can capture into an array.
   */
  log?: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void
}

export interface DialOutboundInput {
  bookingId: string
  before: OutboundBookingRow | undefined
  after: OutboundBookingRow | undefined
  bookingRef: BookingDocRef
}

export interface DialOutboundResult {
  action:
    | "skipped:no_transition"
    | "skipped:missing_data"
    | "failed:missing_identity"
    | "failed:dev_phone_gate"
    | "failed:agent_dispatch"
    | "failed:sip_dispatch"
    | "dispatched"
  bookingId: string
  voiceCallSid?: string
  callerId?: string
  errorMessage?: string
}

const DEFAULT_DERIVE_ROOM = (id: string) => id

/**
 * Returns true when the write looks like a `queued → dialing` (or
 * anything-not-dialing → dialing) gate trip. Self-no-ops and writes that
 * already have dialing state in `before` are skipped.
 */
export function isDialGate(
  before: OutboundBookingRow | undefined,
  after: OutboundBookingRow | undefined,
): boolean {
  if (!after) return false
  if (after.voiceState !== "dialing") return false
  const beforeState: VoiceState | undefined = before?.voiceState as VoiceState | undefined
  // Allow `undefined → dialing` (doc-create case where booker set dialing
  // straight away), as well as `queued → dialing`. Reject `dialing → dialing`
  // (idempotent re-write).
  if (beforeState === "dialing") return false
  return true
}

/**
 * Core handler — pure logic, no Firebase Functions dependency, fully unit-
 * testable.
 */
export async function handleDialOutbound(
  input: DialOutboundInput,
  deps: DialOutboundDeps,
): Promise<DialOutboundResult> {
  const { bookingId, before, after, bookingRef } = input
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => new Date())
  const deriveRoom = deps.deriveRoomName ?? DEFAULT_DERIVE_ROOM

  // Gate 1 — only react to the `→ dialing` transition.
  if (!isDialGate(before, after)) {
    return { action: "skipped:no_transition", bookingId }
  }

  // Gate 2 — booking row sanity (after must exist by isDialGate, but be
  // defensive).
  if (!after) {
    return { action: "skipped:missing_data", bookingId }
  }

  // Gate 3 — Lock L5 identity-first. Missing required fields → mark the row
  // failed and stop. No LLM, no LiveKit call.
  const paUserId = typeof after.paUserId === "string" ? after.paUserId.trim() : ""
  const paJobId = typeof after.paJobId === "string" ? after.paJobId.trim() : ""
  const purpose = after.purpose === "onboarding" ? "onboarding" : "prescreen"
  if (!paUserId || (purpose === "prescreen" && !paJobId)) {
    const missing = []
    if (!paUserId) missing.push("paUserId")
    if (purpose === "prescreen" && !paJobId) missing.push("paJobId")
    log("warn", "dialOutbound:missing_identity", { bookingId, missing })
    // Only flip if the forward transition `dialing → failed` is legal.
    if (isForwardTransition("dialing", "failed")) {
      await bookingRef.set(
        {
          voiceState: "failed",
          voiceOutcome: "failed:missing_identity",
          voiceLastError: `missing_identity_fields:${missing.join(",")}`,
          voiceEndedAt: now().toISOString(),
        },
        { merge: true },
      )
    }
    return {
      action: "failed:missing_identity",
      bookingId,
      errorMessage: `missing:${missing.join(",")}`,
    }
  }

  const phoneE164 = typeof after.phoneE164 === "string" ? after.phoneE164.trim() : ""
  if (!phoneE164) {
    log("warn", "dialOutbound:missing_phone", { bookingId })
    await bookingRef.set(
      {
        voiceState: "failed",
        voiceOutcome: "failed:missing_phone",
        voiceLastError: "missing_phone_e164",
        voiceEndedAt: now().toISOString(),
      },
      { merge: true },
    )
    return {
      action: "failed:missing_identity",
      bookingId,
      errorMessage: "missing:phoneE164",
    }
  }
  if (!isClaireVoiceDevPhone(phoneE164)) {
    log("warn", "dialOutbound:dev_phone_gate", { bookingId })
    await bookingRef.set(
      {
        voiceState: "failed",
        voiceOutcome: "failed:dev_phone_gate",
        voiceLastError: "voice_calls_enabled_only_for_dev_phones",
        voiceEndedAt: now().toISOString(),
      },
      { merge: true },
    )
    return {
      action: "failed:dev_phone_gate",
      bookingId,
      errorMessage: "voice_calls_enabled_only_for_dev_phones",
    }
  }

  // Pick caller ID + derive room name.
  const callerId = deps.callerIdStrategy.pick({ bookingId, paUserId })
  const roomName = deriveRoom(bookingId)

  // ── AGENT-FIRST (LiveKit telephony best practice) ──────────────────────────
  // Dispatch the named voice agent to the room and let it connect + WARM (load
  // context, start STT/LLM/TTS) BEFORE we place the call, so the candidate hears
  // the greeting the instant they answer rather than ~20s of dead air while the
  // agent cold-starts on the live call. A NAMED agent disables auto-dispatch, so
  // if this dispatch fails NO agent would ever join — we must NOT place the call.
  if (deps.dispatchAgent) {
    try {
      await deps.dispatchAgent({
        roomName,
        metadata: JSON.stringify({ bookingId, purpose, paUserId, paJobId }),
      })
      log("info", "dialOutbound:agent_dispatched", { bookingId, roomName })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log("error", "dialOutbound:agent_dispatch_failed", { bookingId, error: message })
      await bookingRef.set(
        {
          voiceState: "failed",
          voiceOutcome: "failed:agent_dispatch_error",
          voiceLastError: truncate(message, 500),
          voiceEndedAt: now().toISOString(),
          voiceCallerId: callerId,
          voiceRoomName: roomName,
        },
        { merge: true },
      )
      return { action: "failed:agent_dispatch", bookingId, callerId, errorMessage: message }
    }
  }

  // Dispatch the SIP call (the candidate's phone rings; the agent is warming).
  let info: SipParticipantInfo
  try {
    info = await deps.sipClient.createSipParticipant({
      sipTrunkId: deps.trunkSid,
      sipCallTo: phoneE164,
      roomName,
      participantIdentity: `candidate-${paUserId}`,
      participantName: `candidate-${paUserId}`,
      fromNumber: callerId,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("error", "dialOutbound:sip_dispatch_failed", { bookingId, error: message })
    await bookingRef.set(
      {
        voiceState: "failed",
        voiceOutcome: "failed:sip_dispatch_error",
        voiceLastError: truncate(message, 500),
        voiceEndedAt: now().toISOString(),
        voiceCallerId: callerId,
        voiceRoomName: roomName,
      },
      { merge: true },
    )
    return {
      action: "failed:sip_dispatch",
      bookingId,
      callerId,
      errorMessage: message,
    }
  }

  // Record the SDK output back to the booking row. Stays in `dialing` state —
  // a webhook will move it forward to `connected`.
  await bookingRef.set(
    {
      voiceCallSid: info.sipCallId,
      voiceRoomName: info.roomName ?? roomName,
      voiceCallerId: callerId,
    },
    { merge: true },
  )

  log("info", "dialOutbound:dispatched", {
    bookingId,
    voiceCallSid: info.sipCallId,
    callerId,
    roomName,
  })

  return {
    action: "dispatched",
    bookingId,
    voiceCallSid: info.sipCallId,
    callerId,
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
