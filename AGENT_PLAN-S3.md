# S3 — Twilio SIP + Outbound-Bookings — AGENT_PLAN

> P8 sub-agent. Wave B. Worktree: `.claude/worktrees/v21-S3-twilio-sip-bookings`.
> Branch: `claude/v21-S3-twilio-sip-bookings` (from `claude/v21-S0-foundation`).
> Owner: P8 (this loop). P10 lead: Claude (Opus 4.7, 1M).

This plan is written **before** any code per Adam's prompt-protocol. It is the
contract for the rest of this sprint. Anything not listed here is out of scope.

---

## 1. Objective (verbatim from Task Prompt)

Wire LiveKit Cloud SIP outbound dispatch through Twilio trunk
`wekruit-prescreen-outbound`, gated by `outbound-bookings/{id}` state
transitions. Reconcile each call's lifecycle into the booking row idempotently
via webhook.

## 2. Locks compliance

| Lock | What it means for S3 | How this sprint honors it |
|---|---|---|
| **L5** identity-first | `outbound-bookings.{paUserId, paJobId}` must be present before any dial | `dialOutbound` short-circuits if either field missing; test `dialOutbound short-circuits if missing paUserId or paJobId` |
| **L9** idempotency | Webhook keyed on `voiceCallSid`; CAS-protected updates | `sipWebhook` uses `runTransaction` over the booking row, no-op if `voiceState` already at target; test `sipWebhook idempotent on duplicate delivery` |
| **L10** deterministic state machine | `queued → dialing → connected → completed → failed → reconciled` | Pure reducer in `state-machine.ts`; no LLM; rejects invalid transitions (test `state machine rejects invalid transitions`) |
| **L12** LiveKit Cloud | No self-host config; SDK calls only | `livekit-server-sdk` SipClient against `LIVEKIT_URL` (Cloud wss endpoint) |

## 3. Design

### 3.1 Schema additions to `outbound-bookings/{id}`

Idempotent migration (`apps/functions/scripts/migrate-outbound-bookings-voice-fields.mjs`)
adds default values **only if the field is undefined**. Schema:

| Field | Type | Default | Notes |
|---|---|---|---|
| `paUserId` | string | (unchanged) | Already set by booker; migration leaves as-is, only verifies presence in audit log |
| `paJobId` | string | (unchanged) | Same |
| `voiceState` | enum | `"queued"` | One of: queued / dialing / connected / completed / failed / reconciled |
| `voiceCallSid` | string \| null | `null` | Twilio Call SID after dispatch; CAS key |
| `voiceRoomName` | string \| null | `null` | LiveKit room id (= bookingId by convention; see §3.2) |
| `voiceStartedAt` | ISO timestamp \| null | `null` | Set on first `connected` |
| `voiceEndedAt` | ISO timestamp \| null | `null` | Set on terminal (completed / failed) |
| `voiceOutcome` | string \| null | `null` | e.g. `"completed:ok"`, `"failed:no_answer"`, `"failed:cost_ceiling"` |
| `voiceLastError` | string \| null | `null` | Last error captured from a callback (truncated to 500 chars) |
| `voiceCallerId` | string \| null | `null` | Which `+1...` we dialed from this call — useful for sticky strategies |

Migration is "fields-only": never overwrites an existing value, never
introduces secondary docs. Re-run = no-op.

Audit log written to `outbound-bookings-voice-migration-audit/{bookingId}`
in dry-run mode (default); `--apply` writes the field defaults.

### 3.2 Room-naming convention (Task Prompt asks final choice)

**Room name = bookingId.** Rationale:

- 1:1 mapping booking↔room makes S2 (voice-bridge) trivially correlate dispatch
  jobs back to a booking.
- Already globally unique because Firestore doc ids are unique.
- Easier debugging: a search of LiveKit room logs for a bookingId returns
  exactly the right session.

Documented in `SUMMARY.md` at completion.

### 3.3 `dialOutbound` Firestore trigger

- **Path:** `apps/functions/src/voice/dialOutbound.ts`
- **Registration in `apps/functions/src/index.ts`:** new export
  `paVoiceDialOutbound` (mirroring naming style of `paMatchingJobsAutoEnrich`).
- **Trigger:** `onDocumentWritten("outbound-bookings/{bookingId}")`.
- **Gate condition:** fire only when `before.voiceState !== "dialing"` AND
  `after.voiceState === "dialing"`. We do NOT auto-flip queued→dialing; the
  booker (or S5 TCPA gate) is responsible for that. S3 just reacts.
- **Body:**
  1. Read `paUserId`, `paJobId`, `phoneE164` from `after`. If any missing →
     transition state to `failed`, set `voiceLastError = "missing_identity_fields"`, return.
  2. Pick caller ID via `CallerIdRotator.pick(bookingId, after.paUserId)`.
  3. Create LiveKit SIP participant via `SipClient.createSipParticipant({
     sipTrunkId: TWILIO_SIP_TRUNK_SID,
     sipCallTo: phoneE164,
     roomName: bookingId,
     participantIdentity: `candidate-${paUserId}`,
     participantName: `candidate-${paUserId}`,
     fromNumber: chosenCallerId,
   })`.
  4. CAS-write booking row with `voiceCallSid` (returned by SDK), `voiceRoomName`,
     `voiceCallerId`. Use `runTransaction` so a concurrent webhook delivery
     can't race.
  5. On SDK failure → reducer transitions to `failed` with `voiceLastError`.

### 3.4 `sipWebhook` HTTP CF

- **Path:** `apps/functions/src/voice/sipWebhook.ts`
- **Registration:** new export `paVoiceSipWebhook` (HTTP, `onRequest`).
- **URL convention:** Cloud Functions default URL
  `https://us-central1-wekruit-5f89b.cloudfunctions.net/paVoiceSipWebhook`.
  Receives **both** LiveKit room webhooks and Twilio voice status callbacks.
  Both producers post JSON or form-encoded; webhook discriminates by shape:
  - LiveKit: `event` field (e.g. `participant_joined`, `room_finished`),
    `room.name`, `participant.identity`.
  - Twilio: `CallSid`, `CallStatus` (`initiated|ringing|in-progress|completed|busy|failed|no-answer|canceled`).
- **Idempotency:** every accepted event resolves to `(bookingId, targetState)`.
  Inside a transaction, read current `voiceState`; if reducer's
  `canTransition(current, target)` is false → return 200 (replay-safe). If true
  → update.
- **Auth:** LiveKit and Twilio both support signed webhooks. v2.1 internal-only
  → start with **shared-secret bearer header `X-Wekruit-Voice-Webhook-Secret`**
  (env `PA_VOICE_WEBHOOK_SECRET`); document HMAC upgrade path in SUMMARY for
  S5/v2.2 production hardening. This is consistent with the
  "internal-numbers-only" v2.1 scope.
- **Mapping table:**

| Source | Event | Target `voiceState` | Side-effect |
|---|---|---|---|
| Twilio | `initiated` / `ringing` | `dialing` (no-op if already) | none |
| Twilio | `in-progress` | `connected` | set `voiceStartedAt = now` |
| Twilio | `completed` | `completed` | set `voiceEndedAt = now`, `voiceOutcome = "completed:ok"` |
| Twilio | `busy` / `no-answer` / `failed` / `canceled` | `failed` | set `voiceEndedAt`, `voiceOutcome = "failed:<reason>"`, `voiceLastError` |
| LiveKit | `participant_joined` (the candidate SIP participant) | `connected` (alias of Twilio in-progress) | set `voiceStartedAt` if null |
| LiveKit | `room_finished` | `completed` if currently `connected`; else leave | set `voiceEndedAt` if null |

The reducer makes both producers safe to deliver in either order; replay-safe
because the booking row never regresses.

### 3.5 State machine reducer

`apps/functions/src/voice/state-machine.ts`:

```
queued    → dialing
dialing   → connected | failed
connected → completed | failed
completed → reconciled
failed    → reconciled
```

- `canTransition(from, to)` returns boolean (pure).
- `reconcile()` is a terminal step S6 (smoke) or operator can call once
  recordings + metrics are archived; S3 does not auto-run it — only validates
  the transition is allowed.
- Invalid transitions throw `InvalidVoiceTransitionError`; webhook catches
  and returns 200 + no-op (idempotency).

### 3.6 Caller ID rotator

`apps/functions/src/voice/caller-id-rotator.ts`:

- Interface `CallerIdStrategy { pick(bookingId, paUserId): string }`.
- Default impl `RoundRobinCallerIdStrategy` — chooses
  `TWILIO_OUTBOUND_CALLER_IDS[hash(bookingId) % N]`. Hash so the same
  bookingId always picks the same number (useful if dispatch retries).
- Stub `StickyByUserIdStrategy` for Adam to flip on later (uses
  `hash(paUserId) % N`). Documented but not selected by default — round-robin
  is the Task Prompt default.
- Strategy chosen via env `PA_VOICE_CALLER_ID_STRATEGY=roundrobin|sticky_user`
  (default `roundrobin`).

### 3.7 LiveKit SDK choice

Add `livekit-server-sdk` ^2.x to `apps/functions/package.json` because:

- No existing LiveKit dependency in the repo (`grep -rn livekit` confirmed).
- It is the official Node SDK and exposes `SipClient.createSipParticipant`.
- Pure server-side; no native deps; works in Node 24.

### 3.8 Tests (located in `apps/functions/src/voice/__tests__/`)

1. `dialOutbound creates LiveKit room + SIP participant on queued→dialing` —
   fake SDK, assert called with expected trunk + caller ID + room name.
2. `dialOutbound rotates caller IDs across calls` — call dispatcher with three
   distinct booking ids, assert distinct caller IDs in expected order.
3. `dialOutbound short-circuits if missing paUserId or paJobId` — booking
   row missing `paJobId`; assert SDK never called, booking transitions to
   `failed`, `voiceLastError = "missing_identity_fields"`.
4. `sipWebhook reconciles dialing→connected on first delivery` — feed Twilio
   `in-progress` event, assert booking row state moves to `connected`,
   `voiceStartedAt` set.
5. `sipWebhook idempotent on duplicate delivery (no state regression)` —
   replay the same event; assert state still `connected`, `voiceStartedAt`
   unchanged.
6. `sipWebhook records voiceLastError on failure callback` — feed Twilio
   `failed` event; assert `voiceState=failed`, `voiceLastError` populated,
   `voiceOutcome` matches.
7. `state machine rejects invalid transitions (connected→queued)` — pure unit
   test.
8. `migration script idempotent (re-run = no double-add)` — fake Firestore,
   run migration twice over same bookings, assert second run is no-op
   (`writes === 0` on second run).

Test harness mirrors `apps/functions/src/sendblue/__tests__/webhook.test.ts`:
in-memory fake Firestore + fake LiveKit SDK client passed via dependency
injection. No live network in unit tests.

### 3.9 Live dial dry-run

Task Prompt §5 marks live dial OPTIONAL for this sprint (S6 will execute it).
This sprint will:

- Document the exact dispatch command (`tsx scripts/voice-dial-dryrun.mjs --booking <id>`)
  in `SUMMARY.md`.
- Hand off to S6 with prerequisite list: `TWILIO_SIP_PASSWORD` literal and
  `LIVEKIT_API_SECRET` literal set in Firebase Secrets before first dial.

If those secrets are available at time of S3 implementation we will attempt
one live dial to an internal number; otherwise SUMMARY will list the exact
command and the secrets gate.

---

## 4. Atomic commit plan

1. `feat(voice/s3): scaffold voice/ dir + state-machine reducer + caller-id rotator + tests`
2. `feat(voice/s3): outbound-bookings voice-fields migration script + idempotency test`
3. `feat(voice/s3): paVoiceDialOutbound Firestore trigger + LiveKit SIP dispatch + tests`
4. `feat(voice/s3): paVoiceSipWebhook HTTP CF for Twilio/LiveKit callbacks + idempotency tests`
5. `chore(functions): wire new exports in index.ts + add livekit-server-sdk dep`
6. `docs(v2.1/s3): SUMMARY.md + handoff to S6 with dispatch command`

Each commit will run `pnpm --filter pa-functions test` and the prescreen
regression scenarios before landing.

## 5. Out-of-scope guards (will NOT do)

- No edits to `agent-runtime`, `PreScreenPipeline`, or any S2/S4/S5 file.
- No telemetry emission (S4's job; we only set `voiceState` fields).
- No TCPA gate logic (S5's job; we just read whatever state the gate left).
- No prescreen content; webhook will never invoke `runTurn`.
- No new Firestore collection. Only `outbound-bookings` fields added.
- No automatic `queued→dialing` transition: booker (or future S5 gate) owns
  that; S3 only reacts.

## 6. Adam-action items expected

- `LIVEKIT_API_SECRET` literal in Firebase Secrets (currently commented in `.env`).
- `TWILIO_SIP_PASSWORD` literal in Firebase Secrets (currently commented).
- `PA_VOICE_WEBHOOK_SECRET` Firebase Secret (new — S3 generates random; documents
  set command in SUMMARY).
- Configure Twilio voice status callback URL → `paVoiceSipWebhook` HTTPS
  endpoint, post-deploy. SUMMARY documents the curl command.

S3 code path tolerates all three being unset at unit-test time (envs are read
inside the trigger body, not at module import). Deployment of CF will fail
gracefully via the `firebase functions:secrets:set` workflow Adam already uses
elsewhere (`ATS_HANDSHAKE_HMAC_SECRET` pattern).

---

## 7. Done-criteria self-check

- [ ] AGENT_PLAN.md written (this file)
- [ ] Migration script idempotent (test asserts re-run no-op)
- [ ] Eight tests above all green
- [ ] `pnpm --filter pa-orchestrator test` green
- [ ] `pnpm --filter pa-functions test` green
- [ ] Four prescreen scenarios green
- [ ] Schema fields exactly: `paUserId`, `paJobId`, `voiceCallSid`, `voiceRoomName`, `voiceState`, `voiceStartedAt`, `voiceEndedAt`, `voiceOutcome`, `voiceLastError`, plus `voiceCallerId` (S3 extension, documented)
- [ ] Branch pushed to origin
- [ ] SUMMARY.md filled with dispatch command + S6 handoff + room-naming choice
- [ ] Final report to P10
