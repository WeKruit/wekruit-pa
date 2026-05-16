# S3 Twilio SIP + Outbound-Bookings — ACCEPTANCE

## Functional

- [ ] Migration script runs idempotently (2 runs = 1 schema state).
- [ ] `dialOutbound` CF deploys to Firebase project `wekruit-5f89b`.
- [ ] Trigger on `outbound-bookings/{id}` `queued → dialing` creates LiveKit room + dispatches SIP participant.
- [ ] Caller ID rotates per call across `TWILIO_OUTBOUND_CALLER_IDS`.
- [ ] Status webhook updates `voiceState` per state machine.
- [ ] Duplicate webhook delivery = idempotent (no state regression, no double-row).

## Lock compliance

- [ ] L5 identity bridge: `paUserId` + `paJobId` always populated on booking row before dial.
- [ ] L9 idempotency: webhook keyed by `voiceCallSid`; CAS-protected updates.
- [ ] L10 state machine: only allowed transitions occur; rejects e.g. `connected → queued`.
- [ ] L12 LiveKit Cloud: dispatch SDK call, no self-host config.

## Regression gate

- [ ] `pnpm --filter pa-orchestrator test` green
- [ ] `pnpm --filter pa-functions test` green
- [ ] Four prescreen scenarios green
- [ ] New voice function tests green

## Hand-off

- [ ] SUMMARY.md captures dispatch command + how S6 triggers smoke dials.
- [ ] `voiceCallSid` always present on connected rows so S4 metrics can join.
