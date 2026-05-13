# S4 Summary

**Status:** Implemented, deployed, and live-smoked.
**Date:** 2026-05-13.

## Current State

- Branch: `codex/v2-S4-job-enrichment`.
- Base: merged S3 commit `8484a36 feat(v2): add bulk resume intake (#26)`.
- Implemented S4 job enrichment contracts, private draft persistence, admin callables, admin review route, and Firestore rules.
- Deployed functions, Firestore rules/indexes, and dashboard hosting to project `wekruit-5f89b`.
- Live route checks passed:
  - `https://wekruit-pa.web.app/admin/job-enrichment` -> HTTP 200.
  - `https://wekruit-pa.web.app/j/s4-smoke` -> HTTP 301 to `https://candidate.wekruit.com/j/s4-smoke`, then HTTP 200.
  - `https://candidate.wekruit.com/j/s4-smoke` -> HTTP 200.
  - `paPublicCvIngest` empty payload -> HTTP 400 with `missing_userId_or_tempUserId`.
- No-outbound smoke passed: `pa-outbound` count stayed `190 -> 190` across deployed route/CV smoke.

## Implemented Scope

- `packages/core-types`: job opportunity, public-safe projection, draft, HITL/correction/event fixture contracts.
- `packages/pa-persistence`: append-only `pa-jobs/{jobId}/enrichment/{draftId}` drafts, approval/rejection, public-safe root promotion, correction events.
- `packages/pa-job-tag-enricher`: pure job-opportunity draft derivation with sponsorship silence, seniority evidence, role/industry separation, prescreen/rubric/brief draft outputs, and eval fixtures.
- `apps/functions`: admin-only generate/refresh/approve/reject/save-corrections callables.
- `apps/dashboard-web`: `/admin/job-enrichment` review surface with filter/list/detail, refresh, save corrections, reject, and approve actions.
- `config/firebase/firestore.rules`: operator-only read for enrichment draft and eval fixture subcollections; writes remain server-only.

## Verification

See `ACCEPTANCE.md` for exact commands and outputs. High-signal checks:

- `pnpm --filter @pa/functions test` -> 1,189 pass, 0 fail.
- `pnpm --filter @pa/dashboard-web test` -> 35 pass, 0 fail.
- `pnpm --filter @pa/dashboard-web build` -> pass; existing Vite large-chunk warning only.
- `git diff --check` -> pass.

## Notes For Next Sprint

- S4 intentionally does not send outbound.
- Approval promotes public-safe job fields only; raw snapshot, HITL flags, soft scoring weights, prescreen draft, scoring rubric, and candidate brief remain private draft internals unless separately approved into safe public fields.
- `sponsorshipAvailable` remains `null` when source text is silent.
