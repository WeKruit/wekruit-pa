# Phase 1 Plan: Broker correctness + echo suppression

## Goal

Make broker-managed iMessage replies stop polluting transcripts and keep the verified E2E path reliable.

## Tasks

1. Add worker tests proving broker-managed outbound does not append a duplicate `role=user` transcript message.
2. Implement outbox suppression for `out-imessage-in-*` idempotency keys.
3. Verify a fresh real iMessage shows no assistant-as-user echo.
4. Keep live model config stable until provider support is verified.

## Verification

- `npm run test --workspace=@pa/macos-imessage-worker`
- `npm test`
- `npm run build`
- `npm run typecheck`
- Real iMessage transcript inspection.
