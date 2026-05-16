# S3 Twilio SIP + Outbound-Bookings — EXECUTOR-PLANS

## 6-Element Task Prompt — S3

### 1. Objective
Wire LiveKit Cloud SIP outbound dispatch through Twilio trunk `wekruit-prescreen-outbound`, gated by `outbound-bookings/{id}` state transitions. Reconcile each call's lifecycle into the booking row idempotently via webhook.

### 2. Context
- Locks L5 (identity bridge), L9 (idempotent reconciliation), L10 (deterministic state machine), L12 (LiveKit Cloud).
- Twilio trunk + caller IDs already provisioned (`.env` has `TWILIO_SIP_TRUNK_SID`, `TWILIO_OUTBOUND_CALLER_IDS=+14157075057,+16468594057`).
- S2 voice bridge will join the room S3 creates (room name = booking id is the suggested convention; verify in `AGENT_PLAN.md`).

### 3. Constraints
- Cloud Function lives under `apps/functions/src/voice/` (new dir). Do NOT touch existing functions.
- State transitions are deterministic reducers; no LLM call sites in this sprint.
- Webhook idempotency keyed on `voiceCallSid`. Replay-safe: 2× delivery = 1 state change.
- Reuse LiveKit Node SDK if already in repo; otherwise add `livekit-server-sdk` to `apps/functions/package.json`.
- Schema migration is a one-shot script (idempotent), run before first deploy.
- Atomic commits: schema migration → CF stub → dispatcher → webhook → tests.

### 4. Deliverables
- `apps/functions/src/voice/dialOutbound.ts` Firestore trigger.
- `apps/functions/src/voice/sipWebhook.ts` HTTP CF for status callbacks (LiveKit + Twilio).
- `apps/functions/scripts/migrate-outbound-bookings-voice-fields.mjs` idempotent migration.
- Tests:
  - `dialOutbound creates LiveKit room + SIP participant on queued→dialing`
  - `dialOutbound rotates caller IDs across calls`
  - `sipWebhook reconciles dialing→connected on first delivery`
  - `sipWebhook idempotent on duplicate delivery (no state regression)`
  - `sipWebhook records voiceLastError on failure callback`
  - `state machine rejects invalid transitions (connected→queued)`
- `AGENT_PLAN.md` BEFORE code.
- `.planning/v2.1/sprints/S3/SUMMARY.md` on completion.

### 5. Verification
```bash
cd /Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/v21-S3-twilio-sip-bookings
pnpm --filter pa-orchestrator test
pnpm --filter pa-functions test
node tests/scenarios/runner-prescreen.mjs pass.yaml
node tests/scenarios/runner-prescreen.mjs fail.yaml
node tests/scenarios/runner-prescreen.mjs hard-stop.yaml
node tests/scenarios/runner-prescreen.mjs pause.yaml
# Plus live dial dry-run against internal dev number (document command in SUMMARY)
```

### 6. Done-criteria
- [ ] `AGENT_PLAN.md` first
- [ ] Schema migration idempotent (re-run does not double-add fields)
- [ ] One real dispatch dry-run to internal dev number completes (LiveKit room created, SIP rings, hangup reconciled)
- [ ] Regression gate green
- [ ] Branch pushed
- [ ] SUMMARY.md filled
- [ ] Report to P10: dispatch command, dial-readiness handoff to S6
