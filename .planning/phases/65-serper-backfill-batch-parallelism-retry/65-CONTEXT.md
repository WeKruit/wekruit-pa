# Phase 65: Serper backfill batch parallelism + retry queue - Context

**Gathered:** 2026-05-06
**Status:** Shipped 2026-05-06 (`a0b6029`). Verified: [.planning/v1.7-MILESTONE-AUDIT.md](../../v1.7-MILESTONE-AUDIT.md).

REQ-IDs: ATSURL-01..04 (4)

**Goal:** Refactor `paBackfillMatchingJobsAtsUrl` from inline-in-liveness-sweep to dedicated batch CF `paBackfillAtsUrlsBatch`. Process 200/run hourly, 5-concurrent Serper, retry queue, cost ledger.

**In scope:**
- New CF `paBackfillAtsUrlsBatch` Cloud Scheduler hourly (`0 * * * *`)
- 200 jobs/run cap, 5-concurrent Serper calls (avoid rate-limit)
- Retry queue: `pa-ats-resolve-priority/{jobId}` TTL 7d for failed; next run picks up
- Fallback to LinkedIn URL extraction when Serper miss
- Cost ledger entries to `pa-cost-ledger` per Serper call (~$0.001/call)
- Weekly summary email if >$10/week
- Tests + deploy

**Existing:**
- `apps/functions/src/backfill-ats-urls.ts` — current admin-callable, single-pass; refactor logic into shared lib + dedicate scheduled CF
- Liveness sweep currently does inline 33/run; remove from there + dedicated batch handles it
