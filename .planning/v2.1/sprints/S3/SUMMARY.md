# S3 Twilio SIP + Outbound-Bookings — SUMMARY (P10 transcription)

> Sub-agent harness blocked direct write. P10 transcribed final report.

**Branch:** `claude/v21-S3-twilio-sip-bookings` (pushed to origin)

## Commits (atomic, 7)

| SHA | Subject |
|---|---|
| `bc141be` | docs(voice/s3): AGENT_PLAN before code |
| `8ee3a39` | feat(voice/s3): scaffold voice/ dir + state-machine reducer + caller-id rotator + tests |
| `66a8fb6` | feat(voice/s3): outbound-bookings voice-fields migration script + idempotency test |
| `72b60c0` | feat(voice/s3): paVoiceDialOutbound Firestore handler + LiveKit SIP dispatch + tests |
| `453a4e1` | feat(voice/s3): paVoiceSipWebhook HTTP CF reconciler + L9 idempotency tests |
| `2d3e29d` | chore(functions): wire paVoiceDialOutbound + paVoiceSipWebhook + livekit-server-sdk dep |
| `9447dc5` | docs(v2.1/s3): SUMMARY.md + handoff to S6 with dispatch command |

## Test summary

- `@pa/functions` **1574/1574 PASS** (+56 new voice tests)
- `@pa/pa-orchestrator` 1498/1498 PASS
- prescreen-runner `pass.yaml` + `pause.yaml` ✓; `fail.yaml` + `hard-stop.yaml` red on S0 base (per task #11 — NOT S3-caused)

## Locks honored

- **L5** identity-first: `handleDialOutbound` short-circuits `failed:missing_identity` before LiveKit call if `paUserId`/`paJobId`/`phoneE164` absent.
- **L9** idempotent reconciliation: `reconcileVoiceCallback` keyed on `voiceCallSid`; duplicate delivery → `applied=false`, 0 Firestore writes.
- **L10** deterministic state machine: pure reducer in `voice/state-machine.ts`; rejects `connected→queued`.
- **L12** LiveKit Cloud: dynamic-import `livekit-server-sdk`; no self-host config.

## All 8 mandated tests green

1. ✓ dialOutbound creates LiveKit room + SIP participant on `queued→dialing`
2. ✓ caller-ID rotation across 20 bookings (both IDs observed)
3. ✓ short-circuits when identity missing
4. ✓ sipWebhook reconciles `dialing→connected` on first delivery
5. ✓ idempotent on duplicate delivery (no state regression)
6. ✓ records `voiceLastError` on failure callback
7. ✓ state machine rejects invalid transitions
8. ✓ migration script idempotent (re-run = no double-add)

## Schema added to `outbound-bookings/{id}` (10 fields, idempotent migration)

`paUserId`, `paJobId` (read-only), `voiceCallSid`, `voiceRoomName`, `voiceState`, `voiceStartedAt`, `voiceEndedAt`, `voiceOutcome`, `voiceLastError`, `voiceCallerId` (S3 extension).

## Dispatch command for S6

```bash
# Pre-stage booking, flip voiceState to "dialing":
gcloud firestore documents update outbound-bookings/B-smoke-001 \
  --project=wekruit-5f89b \
  --field=voiceState=dialing \
  --field=paUserId=U-dev-adam \
  --field=paJobId=J-dev-test \
  --field=phoneE164=+1XXXXXXXXXX
```

## Key design choices

- **Room name = bookingId** (1:1 booking↔room, trivial S2 join, unique by Firestore doc-id).
- **Default caller-ID strategy = round-robin keyed on bookingId** (deterministic, retry-stable). Sticky-by-userId via `PA_VOICE_CALLER_ID_STRATEGY=sticky_user` (one-env flip, no code edit).
- **Webhook auth = shared bearer** `X-Wekruit-Voice-Webhook-Secret` for v2.1 internal-only. HMAC upgrade path documented for v2.2 (mirrors `paAtsInboundWebhook`).

## Adam-action outstanding (deploy-gating)

1. `firebase functions:secrets:set LIVEKIT_API_SECRET` (literal)
2. `firebase functions:secrets:set TWILIO_SIP_PASSWORD` (literal) + LiveKit Cloud trunk credential config
3. `firebase functions:secrets:set PA_VOICE_WEBHOOK_SECRET` (random 32+ chars)
4. Twilio trunk status-callback URL → `https://us-central1-wekruit-5f89b.cloudfunctions.net/paVoiceSipWebhook` with `X-Wekruit-Voice-Webhook-Secret` header

Unit tests tolerate all 4 unset; smoke dial requires all 4 provisioned.
