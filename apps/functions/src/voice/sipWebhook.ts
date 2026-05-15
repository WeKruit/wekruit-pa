/**
 * S3 (v2.1) — paVoiceSipWebhook reconciler.
 *
 * Receives status callbacks from BOTH Twilio (`CallSid` + `CallStatus`) and
 * LiveKit (room/participant events). Reconciles the corresponding
 * `outbound-bookings/{id}` row via a deterministic reducer over the L10
 * state machine.
 *
 * Idempotency contract (Lock L9):
 *   - Key on `voiceCallSid` (Twilio CallSid; LiveKit's `sipCallId` is the
 *     same value because LiveKit threads it through).
 *   - Inside a Firestore transaction read the current `voiceState`, compare
 *     to the target the event maps to, and write only on a forward
 *     transition.
 *   - Duplicate delivery → no-op `applied=false` 200 OK.
 *
 * No LLM. No SDK egress. Pure data join + state-machine apply.
 */

import { canTransition, isForwardTransition } from "./state-machine.js"
import type { VoiceState } from "./state-machine.js"
import type {
  OutboundBookingRow,
  ReconcileResult,
  VoiceCallbackEvent,
} from "./types.js"

/**
 * Minimal Firestore transactional surface sipWebhook depends on. Tests pass
 * a fake; production wires the real Admin SDK firestore.
 */
export interface BookingDocSnap {
  exists: boolean
  id: string
  data(): OutboundBookingRow | undefined
  ref: { set(data: Partial<OutboundBookingRow>, opts?: { merge?: boolean }): Promise<unknown> }
}

export interface BookingTxnContext {
  /** Get a snapshot by booking id. */
  getById(bookingId: string): Promise<BookingDocSnap | null>
  /** Find by voiceCallSid (used when callback only carries the CallSid). */
  findByCallSid(callSid: string): Promise<BookingDocSnap | null>
  /** Find by voiceRoomName (used by LiveKit callbacks). */
  findByRoomName(roomName: string): Promise<BookingDocSnap | null>
}

export interface ReconcileDeps {
  txnContext: BookingTxnContext
  now?: () => Date
  log?: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void
}

/**
 * Map an incoming voice callback to its target voice state + side-effect
 * fields. Pure — does NOT touch Firestore.
 */
export function mapEventToTargetState(event: VoiceCallbackEvent, now: Date): {
  target: VoiceState | null
  sideEffects: Partial<OutboundBookingRow>
  outcome?: string
} {
  if (event.source === "twilio") {
    switch (event.CallStatus) {
      case "initiated":
      case "ringing":
        return { target: "dialing", sideEffects: {} }
      case "in-progress":
        return {
          target: "connected",
          sideEffects: { voiceStartedAt: now.toISOString() },
        }
      case "completed":
        return {
          target: "completed",
          sideEffects: {
            voiceEndedAt: now.toISOString(),
            voiceOutcome: "completed:ok",
          },
          outcome: "completed:ok",
        }
      case "busy":
      case "no-answer":
      case "failed":
      case "canceled": {
        const reason = event.CallStatus
        const err =
          event.ErrorMessage || event.ErrorCode
            ? `${event.ErrorCode ?? ""} ${event.ErrorMessage ?? ""}`.trim()
            : `twilio_${reason}`
        return {
          target: "failed",
          sideEffects: {
            voiceEndedAt: now.toISOString(),
            voiceOutcome: `failed:${reason}`,
            voiceLastError: err,
          },
          outcome: `failed:${reason}`,
        }
      }
      default:
        return { target: null, sideEffects: {} }
    }
  }
  // LiveKit events
  switch (event.event) {
    case "participant_joined":
      // SIP participant joined room → call is connected (Twilio in-progress
      // analog).
      return {
        target: "connected",
        sideEffects: { voiceStartedAt: now.toISOString() },
      }
    case "room_finished":
      return {
        target: "completed",
        sideEffects: { voiceEndedAt: now.toISOString() },
      }
    case "participant_left":
    case "room_started":
    default:
      // Not a state-changing event in S3 scope. Telemetry (S4) will handle.
      return { target: null, sideEffects: {} }
  }
}

/**
 * Resolve which booking row the event refers to.
 *
 * Twilio: prefer `bookingId` (if status-callback URL passed it as a query
 * param), else look up by `voiceCallSid == CallSid`.
 * LiveKit: room name is the booking id (per S3 convention) — use directly,
 * fallback to `findByRoomName` if the SDK is configured to use a different
 * room id.
 */
async function resolveBookingSnap(
  event: VoiceCallbackEvent,
  ctx: BookingTxnContext,
): Promise<BookingDocSnap | null> {
  if (event.source === "twilio") {
    if (event.bookingId) {
      const direct = await ctx.getById(event.bookingId)
      if (direct?.exists) return direct
    }
    return ctx.findByCallSid(event.CallSid)
  }
  // LiveKit
  const roomName = event.room?.name
  if (!roomName) return null
  const direct = await ctx.getById(roomName)
  if (direct?.exists) return direct
  return ctx.findByRoomName(roomName)
}

/**
 * Pure-ish reconciler. Deps inject the txn context + clock; tests fake them.
 */
export async function reconcileVoiceCallback(
  event: VoiceCallbackEvent,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const now = (deps.now ?? (() => new Date()))()
  const log = deps.log ?? (() => {})

  const snap = await resolveBookingSnap(event, deps.txnContext)
  if (!snap?.exists) {
    log("warn", "sipWebhook:booking_not_found", {
      source: event.source,
      callSid: event.source === "twilio" ? event.CallSid : undefined,
      roomName: event.source === "livekit" ? event.room?.name : undefined,
    })
    return { applied: false, bookingId: null, fromState: null, toState: null, reason: "booking_not_found" }
  }

  const data = snap.data() ?? {}
  const fromState: VoiceState = (data.voiceState as VoiceState | undefined) ?? "queued"

  const { target, sideEffects, outcome } = mapEventToTargetState(event, now)
  if (target === null) {
    return { applied: false, bookingId: snap.id, fromState, toState: null, reason: "event_ignored" }
  }

  if (!canTransition(fromState, target)) {
    log("info", "sipWebhook:transition_rejected", {
      bookingId: snap.id,
      from: fromState,
      to: target,
      source: event.source,
    })
    return {
      applied: false,
      bookingId: snap.id,
      fromState,
      toState: target,
      reason: "invalid_transition",
    }
  }

  if (!isForwardTransition(fromState, target)) {
    // Self-transition → idempotent replay. Record nothing, return ok.
    return {
      applied: false,
      bookingId: snap.id,
      fromState,
      toState: target,
      reason: "no_op_self_transition",
    }
  }

  const update: Partial<OutboundBookingRow> = {
    voiceState: target,
    ...sideEffects,
  }
  // Never overwrite an existing voiceStartedAt with a later identical event.
  if (update.voiceStartedAt && data.voiceStartedAt) {
    delete update.voiceStartedAt
  }
  // Same for voiceEndedAt.
  if (update.voiceEndedAt && data.voiceEndedAt) {
    delete update.voiceEndedAt
  }

  // If Twilio gave us a CallSid we hadn't recorded yet (e.g. dispatch race),
  // stamp it so future lookups work.
  if (event.source === "twilio" && !data.voiceCallSid) {
    update.voiceCallSid = event.CallSid
  }

  await snap.ref.set(update, { merge: true })

  log("info", "sipWebhook:applied", {
    bookingId: snap.id,
    from: fromState,
    to: target,
    outcome,
  })

  return { applied: true, bookingId: snap.id, fromState, toState: target, reason: outcome }
}
