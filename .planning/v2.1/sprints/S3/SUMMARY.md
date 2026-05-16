# S3 Twilio SIP + Outbound-Bookings — SUMMARY

> Sprint: v2.1 S3
> Branch: `claude/v21-S3-twilio-sip-bookings` (from `claude/v21-S0-foundation`)
> Worktree: `.claude/worktrees/v21-S3-twilio-sip-bookings`
> Status: Code-complete, tests green, dispatch handoff ready for S6.

## What landed

| Commit | Subject |
|---|---|
| bc141be | docs(voice/s3): AGENT_PLAN before code |
| 8ee3a39 | feat(voice/s3): scaffold voice/ dir + state-machine reducer + caller-id rotator + tests |
| 66a8fb6 | feat(voice/s3): outbound-bookings voice-fields migration script + idempotency test |
| 72b60c0 | feat(voice/s3): paVoiceDialOutbound Firestore handler + LiveKit SIP dispatch + tests |
| 453a4e1 | feat(voice/s3): paVoiceSipWebhook HTTP CF reconciler + L9 idempotency tests |
| 2d3e29d | chore(functions): wire paVoiceDialOutbound + paVoiceSipWebhook + livekit-server-sdk dep |

## Files added / modified

- apps/functions/src/voice/state-machine.ts — L10 reducer + canTransition / isForwardTransition / assertTransition / InvalidVoiceTransitionError.
- apps/functions/src/voice/caller-id-rotator.ts — CallerIdStrategy interface + RoundRobinCallerIdStrategy (default) + StickyByUserIdCallerIdStrategy (env-selectable).
- apps/functions/src/voice/types.ts — OutboundBookingRow, SipClientLike SDK shim, VoiceCallbackEvent discriminated union, ReconcileResult.
- apps/functions/src/voice/dialOutbound.ts — pure handleDialOutbound + isDialGate. Reacts only on *→dialing transitions, short-circuits on missing identity (L5), captures SDK failure into voiceLastError / voiceOutcome="failed:sip_dispatch_error".
- apps/functions/src/voice/sipWebhook.ts — pure reconcileVoiceCallback + mapEventToTargetState. CAS-safe Twilio/LiveKit event reduction (L9). Replay-safe via reducer isForwardTransition check.
- apps/functions/src/voice/index.ts — Firebase Functions wrappers: paVoiceDialOutbound (onDocumentWritten) + paVoiceSipWebhook (onRequest) + dynamic-import LiveKit SDK adapter + Firestore txn context.
- apps/functions/src/voice/__tests__/*.test.ts — 4 test files (state machine 11, caller-id 12, dialOutbound 12, sipWebhook 13) = 48 unit tests.
- apps/functions/scripts/migrate-outbound-bookings-voice-fields.mjs — idempotent schema migration. Pure computeMigrationUpdate exported for tests.
- apps/functions/scripts/__tests__/migrate-outbound-bookings-voice-fields.test.mjs — 8 idempotency tests.
- apps/functions/src/index.ts — wires new exports under `// v2.1 S3` block.
- apps/functions/package.json — adds livekit-server-sdk: ^2.13.2; adds voice tests + migration test to the test glob.

## Schema added to outbound-bookings/{id}

| Field | Type | Default |
|---|---|---|
| voiceState | "queued" \| "dialing" \| "connected" \| "completed" \| "failed" \| "reconciled" | "queued" |
| voiceCallSid | string \| null | null |
| voiceRoomName | string \| null | null |
| voiceStartedAt | ISO string \| null | null |
| voiceEndedAt | ISO string \| null | null |
| voiceOutcome | string \| null | null |
| voiceLastError | string \| null | null |
| voiceCallerId | string \| null | null (S3 extension — lets S4 join cost-per-caller analytics; lets a sticky-by-user retry re-pick the same number) |

paUserId and paJobId are read-only from S3's perspective. Booker owns them.

## Locks honored

- L5 (identity bridge) — handleDialOutbound short-circuits with failed:missing_identity before LiveKit when paUserId or paJobId is empty/missing. Tests: "short-circuits if paUserId missing", "short-circuits if paJobId missing", "short-circuits if phoneE164 missing".
- L9 (idempotency) — reconcileVoiceCallback uses the state-machine reducer's isForwardTransition; duplicate deliveries return applied=false with reason="no_op_self_transition" and zero Firestore writes. Test: "idempotent on duplicate delivery — no state regression, no second write".
- L10 (state machine) — pure reducer in state-machine.ts. No LLM, no SDK. Invalid transitions (e.g. connected→queued) return reason="invalid_transition". Tests: "rejects invalid backward transition" + "rejects connected → queued (regression-attempt)".
- L12 (LiveKit Cloud) — livekit-server-sdk dynamic-import only; no self-host config.

## Room-naming choice (AGENT_PLAN §3.2)

Room name = bookingId. sipWebhook resolves LiveKit events first by getById(room.name) and falls back to findByRoomName(...) for safety if a future caller chooses a different convention.

## Caller-ID rotation choice (Task Prompt §3)

Default = round-robin keyed on bookingId (deterministic per booking; a dispatch retry of the same booking always picks the same caller ID, avoiding "two outbound calls from two different numbers"). Sticky-by-userId implemented as StickyByUserIdCallerIdStrategy and selectable via PA_VOICE_CALLER_ID_STRATEGY=sticky_user env. Flipping is a one-env-var change with no code edit, per V2.0 rule #10 ("sticky load balancing").

## Tests

- Voice unit (S3 new): 56 tests green via
  node --import tsx --test src/voice/__tests__/*.test.ts scripts/__tests__/migrate-outbound-bookings-voice-fields.test.mjs
- pnpm --filter pa-functions test: 1574/1574 green (was ~1518 pre-S3, +56 voice).
- pnpm --filter pa-orchestrator test: 1498/1498 green (S3 does not touch orchestrator).
- Prescreen scenarios: pass.yaml ✓, pause.yaml ✓; fail.yaml ✗, hard-stop.yaml ✗. **Inherited red from claude/v21-S0-foundation** — confirmed by running same scenarios on main (all 4 green) and on claude/v21-S0-foundation (same 2 red). NOT a S3 regression. Logged as a claude/v21-S0-foundation ship-blocker for whoever lands S0.

## Live dial dry-run handoff (S6 owner)

Task Prompt §5 marked live dial OPTIONAL for S3. We did not attempt it because LIVEKIT_API_SECRET, TWILIO_SIP_PASSWORD, and PA_VOICE_WEBHOOK_SECRET are not yet provisioned (Adam-action open per .env).

Once those three are filled, S6 can run the smoke dial via:

```bash
# (Adam, one-time) provision secrets:
firebase functions:secrets:set LIVEKIT_API_KEY --project wekruit-5f89b
firebase functions:secrets:set LIVEKIT_API_SECRET --project wekruit-5f89b
firebase functions:secrets:set PA_VOICE_WEBHOOK_SECRET --project wekruit-5f89b   # random 32+ chars

# (Adam, one-time) configure Twilio status callback URL on the trunk to:
#   https://us-central1-wekruit-5f89b.cloudfunctions.net/paVoiceSipWebhook
#   with header X-Wekruit-Voice-Webhook-Secret: <same value>

# Deploy CFs (existing predeploy gate runs):
cd apps/functions && pnpm run deploy

# Run migration first (DRY-RUN by default — re-runs are no-ops):
node apps/functions/scripts/migrate-outbound-bookings-voice-fields.mjs
# Then apply:
node apps/functions/scripts/migrate-outbound-bookings-voice-fields.mjs --apply

# Smoke dial — pre-stage a booking row in Firestore with the dev recipient,
# then flip its voiceState to "dialing":
gcloud firestore documents update outbound-bookings/B-smoke-001 \
  --project=wekruit-5f89b \
  --field-mask=voiceState,paUserId,paJobId,phoneE164 \
  --field=voiceState=dialing \
  --field=paUserId=U-dev-adam \
  --field=paJobId=J-dev-test \
  --field=phoneE164=+1XXXXXXXXXX
# Expected: paVoiceDialOutbound fires, LiveKit SIP participant created,
# Twilio dials the recipient, callbacks reconcile booking row to "completed".
```

The HTTP webhook URL is the same for Twilio's voice status callback and for LiveKit's room webhook configuration (LiveKit Cloud → Project Settings → Webhooks).

## Open items (handoff list)

1. Adam-action: fill LIVEKIT_API_SECRET, TWILIO_SIP_PASSWORD, generate PA_VOICE_WEBHOOK_SECRET.
2. S6 owner: execute the smoke-dial command above, capture call SID + reconciled row, paste into S6 SUMMARY.
3. S5 owner: TCPA gate must run before queued → dialing. S3 only owns the dispatch reaction; the booker (or future TCPA gate) flips voiceState to dialing.
4. S4 owner: voice-call-metrics/{voiceCallSid} joins cleanly — S3 stamps voiceCallSid on every booking row at dispatch time.
5. HMAC upgrade: v2.1 uses a shared bearer header on paVoiceSipWebhook. AGENT_PLAN §3.4 documents the upgrade path to per-source HMAC for v2.2 production hardening (mirrors paAtsInboundWebhook).
6. Inherited prescreen scenario reds: fail.yaml and hard-stop.yaml red on claude/v21-S0-foundation (and therefore on this branch). Not S3-caused.

## Done-criteria checklist

- [x] AGENT_PLAN.md written before code (commit bc141be)
- [x] Migration script idempotent — second run no-op (8 pure unit tests)
- [x] Schema fields present (paUserId, paJobId, voiceCallSid, voiceRoomName, voiceState, voiceStartedAt, voiceEndedAt, voiceOutcome, voiceLastError, voiceCallerId)
- [x] L5 identity-first short-circuit + test
- [x] L9 idempotent reconciliation + test
- [x] L10 deterministic state machine + invalid-transition rejection test
- [x] L12 LiveKit Cloud SDK only (no self-host)
- [x] Caller-ID round-robin default + sticky-user strategy + factory + tests
- [x] pnpm --filter pa-functions test green (1574/1574)
- [x] pnpm --filter pa-orchestrator test green (1498/1498)
- [x] All eight Task-Prompt-mandated tests written and green
- [x] Branch ready to push
- [x] SUMMARY.md filled
