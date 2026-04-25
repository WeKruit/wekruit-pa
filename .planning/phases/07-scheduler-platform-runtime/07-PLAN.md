# Phase 7 Plan: Scheduler and platform runtime

## Tasks

1. Add scheduled job schema and broker helpers for enqueue/list/claim/complete/fail.
2. Add retry/backoff and max-attempt dead-letter behavior.
3. Add runtime heartbeat schema/helpers and stale heartbeat listing.
4. Surface scheduled jobs and heartbeats in Overview/Operations.

## Verification

- `npm run test --workspace=@pa/pa-broker`
- `npm run typecheck --workspace=@pa/pa-broker`
- Dashboard build/typecheck.
