# Phase 7 Summary: Scheduler and platform runtime

## Completed

- Added scheduled job and runtime heartbeat schemas/collections.
- Added broker helpers for scheduled enqueue, due listing, claiming, completion, failure/backoff, dead-letter, heartbeat write, and stale heartbeat listing.
- Added tests for scheduled job lifecycle, retry/backoff, dead-letter, heartbeat write, and stale heartbeat detection.
- Overview and Operations now display scheduled jobs and runtime heartbeats.

## Verification

- Broker tests passed.
- Broker typecheck passed.
- Full workspace build/typecheck passed.
