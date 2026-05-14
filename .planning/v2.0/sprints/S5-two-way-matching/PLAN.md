# S5 Plan - Two-Way Matching

## Status

Implemented, deployed, and live-smoked. PR preparation is next.

## Target Outcome

Given one retained candidate, the system can produce top job matches with
hard-filter explanations, soft-score reasons, risks, and status. Given one
approved enriched job, the system can produce top retained-candidate matches
with the same evidence and a recommended action:
`auto_outbound`, `hitl_review`, or `do_not_contact`.

S5 does not enqueue or send outbound. `auto_outbound` is a policy output for S6,
not a side effect in S5.

## Wave Plan

### Wave A - Contracts, Reducers, Fixtures

- Extend `CandidateJobMatch` only as needed for two-way match evidence:
  direction, hard-filter results, soft-score breakdown, risks, missing info, and
  recommended action.
- Keep candidate-job state transitions deterministic and separate from ranking.
- Add fixtures for:
  - obvious strong candidate -> job match
  - obvious strong job -> candidate match
  - hard-filter suppression
  - promising missing-info HITL case
  - role/industry mismatch suppression
- Preserve `roleFunction` and `industrySector` as separate axes.

### Wave B - Matching Service

- Reuse the existing candidate -> jobs ranking path instead of creating a
  parallel recommender.
- Add job -> candidates retrieval over retained candidate profiles using the
  same shared tag vocabulary and v1.6 cascade constraints.
- Compute explainable hard-filter and soft-score evidence for both directions.
- Add recommended action as a pure decision result:
  - `auto_outbound` when match is strong and policy-safe
  - `hitl_review` when promising but missing info or borderline
  - `do_not_contact` when hard filters fail or mismatch is clear
- Store or return match evidence without creating `pa-outbound` rows.

### Wave C - Admin Debug UI/API

- Extend admin Match Debug to run:
  - candidate -> jobs
  - job -> candidates
- Show hard filters, soft score, LLM/semantic score when available, missing
  info, risks, and recommended action.
- Keep the UI operator-dense and admin-only.
- Add focused tests for route/helper behavior and API shape.

### Wave D - Candidate Matches UI

- Add candidate-facing `/me/matches` under `apps/pa-landing`.
- Show recommended jobs, invited jobs, why matched, and current job-specific
  status.
- Use existing candidate identity/handle state; do not invent employer browsing
  or a separate candidate store.
- Keep the first-interview entry path intact for any listed job.

### Wave E - Eval, Rules, Deploy, Land

- Add regression tests for both ranking directions.
- Add Firestore rules/index updates only for the minimal new reads/writes.
- Run package tests, functions tests/typecheck, dashboard tests/build, landing
  tests/build if touched, and route/domain regressions.
- Deploy directly if code changes affect Firebase Functions or Hosting.
- PR checks and merge completed; S5 landed as
  `16705a5 feat(v2): add S5 two-way matching` through PR #28. S6 has already
  landed after S5.

## Executor Split

- A: contracts, fixtures, and persistence shape.
- B: candidate -> jobs and job -> candidates matching service.
- C: admin Match Debug API/UI.
- D: candidate `/me/matches` route.
- E: evals, rules/indexes, acceptance, deploy, and landing.

## Implementation Gate

Satisfied. Five executor plans were collected for contracts/persistence,
matching service, admin debug, candidate matches, and eval/deploy. The executor
outputs were reconciled, verified, deployed to Firebase Functions/Hosting, and
checked against the route/domain/no-outbound acceptance ledger.
