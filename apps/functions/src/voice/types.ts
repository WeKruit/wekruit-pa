/**
 * S3 (v2.1) — shared types for the outbound-voice dispatch + reconciliation
 * paths.
 *
 * Kept in a separate module so dialOutbound and sipWebhook can share without
 * either importing the other, and so unit tests can construct typed fakes.
 */

import type { VoiceState } from "./state-machine.js"

/**
 * Subset of `outbound-bookings/{id}` shape that S3 reads/writes. Other
 * fields (purpose, phoneE164, scheduledAt, etc.) may exist; S3 ignores them.
 */
export interface OutboundBookingRow {
  paUserId?: string | null
  paJobId?: string | null
  phoneE164?: string | null
  voiceState?: VoiceState
  voiceCallSid?: string | null
  voiceRoomName?: string | null
  voiceStartedAt?: string | null
  voiceEndedAt?: string | null
  voiceOutcome?: string | null
  voiceLastError?: string | null
  voiceCallerId?: string | null
  // Allow extra fields without losing typing on the ones we touch.
  [k: string]: unknown
}

/**
 * Result returned by the LiveKit SipClient when we successfully dispatch a
 * SIP participant. The official @livekit/server-sdk type lives behind a
 * dynamic import; we reify the minimal subset we care about so tests don't
 * need the real SDK installed.
 */
export interface SipParticipantInfo {
  /** Twilio call SID — used as the CAS / idempotency key. */
  sipCallId: string
  /** LiveKit room name the participant was added to. */
  roomName: string
  /** Participant identity LiveKit assigned. */
  participantIdentity: string
}

/**
 * Minimal SipClient surface that dialOutbound depends on. Real impl
 * delegates to `import("livekit-server-sdk").SipClient`. Tests pass a fake.
 */
export interface SipClientLike {
  createSipParticipant(opts: {
    sipTrunkId: string
    sipCallTo: string // E.164 dial target
    roomName: string
    participantIdentity: string
    participantName?: string
    /**
     * E.164 of the From: number. NOTE: LiveKit SDK exposes this as
     * `numberAlias` / `fromNumber` depending on version; this shim normalizes
     * to `fromNumber` and the runtime adapter maps to whatever the SDK
     * accepts.
     */
    fromNumber: string
  }): Promise<SipParticipantInfo>
}

/**
 * Event shape feeded to sipWebhook reducer. Discriminator `source`.
 */
export type VoiceCallbackEvent =
  | {
      source: "twilio"
      CallSid: string
      CallStatus:
        | "initiated"
        | "ringing"
        | "in-progress"
        | "completed"
        | "busy"
        | "failed"
        | "no-answer"
        | "canceled"
      ErrorCode?: string
      ErrorMessage?: string
      /**
       * Optional booking id; when Twilio is configured with a status-callback
       * URL containing the bookingId path/query we pass it through. When
       * absent we fall back to lookup by `voiceCallSid == CallSid`.
       */
      bookingId?: string
    }
  | {
      source: "livekit"
      event:
        | "participant_joined"
        | "participant_left"
        | "room_finished"
        | "room_started"
      room: { name: string }
      participant?: { identity?: string }
      sipCallId?: string
    }

/**
 * Result of attempting to reconcile a single event against a booking row.
 * `applied=false` is a successful no-op (idempotent replay), not an error.
 */
export interface ReconcileResult {
  applied: boolean
  bookingId: string | null
  fromState: VoiceState | null
  toState: VoiceState | null
  reason?: string
}
