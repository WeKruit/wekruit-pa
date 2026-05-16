# S3 Twilio SIP + Outbound-Bookings — CONTEXT

**Status:** PENDING. Parallel with S2 (no S2 dependency for S3 dial-out plumbing; only voice-bridge hookup at smoke time in S6).
**Wave:** B (services).
**Worktree (to create):** `.claude/worktrees/v21-S3-twilio-sip-bookings`.

## What S3 inherits

| Source | Artifact | Use |
|---|---|---|
| S0 | Identity bridge schema (`outbound-bookings.paUserId`, `paJobId`) | Bookings collection mutation |
| S0 lock L5 | Identity-first contract | Booking row reconciliation |
| S0 lock L9 | Hangup reconciliation idempotent (`voiceCallSid` CAS) | Webhook handler design |
| S0 lock L10 | Deterministic state machine `queued → dialing → connected → completed → failed → reconciled` | Reducer |
| `.env` | `LIVEKIT_*`, `TWILIO_SIP_*`, `TWILIO_OUTBOUND_CALLER_IDS` | Trunk + dispatch config |

## What S3 produces

- Cloud Function `paVoiceDialOutbound` (Firestore trigger on `outbound-bookings/{id}` transition `queued → dialing`).
- LiveKit SIP outbound dispatch via SDK: creates SIP participant in a fresh LiveKit room, routes through `TWILIO_SIP_TERMINATION_URI` trunk to dialed E.164.
- Caller ID rotation: round-robin across `TWILIO_OUTBOUND_CALLER_IDS`.
- Hangup webhook receiver (LiveKit + Twilio status callbacks) that reconciles booking row via CAS.
- Firestore schema migration: adds `paUserId`, `paJobId`, `voiceCallSid`, `voiceRoomName`, `voiceState`, `voiceStartedAt`, `voiceEndedAt`, `voiceOutcome`, `voiceLastError` to `outbound-bookings/{id}`.

## What S3 explicitly does NOT do

- ❌ Worker logic / STT / TTS / LLM — that's S2.
- ❌ Telemetry emission — that's S4.
- ❌ TCPA gate enforcement — that's S5.
- ❌ Place real prescreen content — bookings collection lifecycle only.

## Open questions for Adam at spawn time

- Twilio status callback URL — Firebase HTTP CF endpoint or Sendblue-style separate ingest?
- Caller ID rotation strategy — round-robin OK, or sticky-by-userId like Sendblue pattern (CLAUDE.md mentions "sticky load balancing")?
