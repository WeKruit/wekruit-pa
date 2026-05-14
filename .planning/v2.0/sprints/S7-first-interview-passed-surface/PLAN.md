# S7 Plan - First Interview + Passed Candidate Surface

## Status

Sprint selected and worktree created from updated `origin/main`. Initial context
is written. Executor `AGENT_PLAN` handshakes are complete and integrated.
Implementation is unblocked under the write scopes in `EXECUTOR-PLANS.md`.

## Purpose

S7 closes the marketplace loop from candidate activation to employer-visible
passed profiles. Candidates who arrive directly from a job page or through S6
outreach must get the same first interview. PASS becomes a passed-profile
snapshot for employer review. NOT_PASS and PAUSE stay retained but invisible to
employers.

## Observable Outcome

- A direct candidate can enter a job flow, complete Claire's first interview,
  and, on PASS, appear in `/admin/passed-candidates`.
- An outbound candidate can enter the same first-interview flow and produce the
  same candidate-job outcome.
- NOT_PASS remains in the global pool and candidate-job history but does not
  create employer-visible data.
- Admin/employer surface shows only passed snapshots.

## Locked Invariants And Non-Goals

- No match score gate before first interview.
- No broad employer candidate browsing.
- No candidate routes on the admin domain.
- No live outbound smoke without explicit approval.
- No destructive migration or deletion.
- No direct provider/send path changes outside existing Sendblue/outbox
  primitives.
- No compatibility patch that leaves PASS visibility as an ad hoc admin query
  over global candidate docs.

## Data Model And Ownership

- `CandidateJobStateDoc` remains the per-job source of truth for interview
  lifecycle.
- `EmployerVisibleProfile` is the employer-facing snapshot. It must be created
  from a `passed` candidate-job state and must not expose live global docs.
- Prescreen session docs remain the runtime transcript/outcome source.
- Global `pa-users` remains candidate profile source but should be copied into
  snapshots only through explicitly selected safe fields.
- Feedback/correction events from employer actions belong to S8 unless a narrow
  S7 event is needed for dashboard visibility.

## UI Surface Map

- Candidate:
  - Existing job page and iMessage trigger remain on `apps/pa-landing`.
  - Candidate `/me/matches` should reflect interview/passed/not-passed/paused
    state clearly.
- Admin:
  - New `/admin/passed-candidates` page.
  - Filters by job.
  - Shows passed snapshot fields: profile summary, PII consent, resume summary,
    Level 1, transcript reference/summary, pass reason, and match reason.

## Backend/API Map

- Prescreen start path should apply `prescreen_started`.
- Prescreen terminal action should apply PASS / NOT_PASS / PAUSE events and
  snapshot creation where allowed.
- New admin callable should return passed snapshots only, with backend joins for
  safe display fields.
- Existing `writeEmployerVisibleProfile` should be reused or strengthened
  rather than bypassed.

## Executor Topology

- A: contracts, reducers, snapshot schema, persistence helpers.
- B: prescreen start/terminal outcome wiring and backend snapshot creation.
- C: admin passed-candidates callable and dashboard UI.
- D: candidate-side status/direct-outbound entry UX.
- E: evals, HITL, acceptance, route/auth/no-outbound smoke harness.

## Agent Plan Handshake

Executor `AGENT_PLAN` requests are complete. `EXECUTOR-PLANS.md` records A-E
plans and the lead decisions that unblock implementation.

## Lead Integration Note

Implementation decisions:

1. Write scopes are disjoint by executor. Shared files are lead-owned or
   sequenced: `apps/functions/src/index.ts`,
   `apps/dashboard-web/src/App.tsx`, and candidate matches projection.
2. PASS snapshot creation has one backend owner: A exposes the persistence
   helper; B calls it from the prescreen terminal path.
3. PASS ends as `employer_visible` after snapshot creation. Candidate-facing
   status maps both `passed` and `employer_visible` to passed.
4. `prescreenSessionId` is persisted on candidate-job state for transcript
   linkage. `employerVisibleProfileId` links the state back to the snapshot.
5. PASS snapshots may exist without contact PII when consent is incomplete.
   They must show consent missing and must never include raw phone, email,
   LinkedIn URL, handles, resume storage URLs, or normalized contact values.
6. NOT_PASS and PAUSE invisibility is enforced in reducer, persistence, admin
   query, and eval coverage.
7. `/admin/passed-candidates` is PA-admin only for S7, requires `jobId`, and
   lists only `pa-employer-visible-profiles`. Passed rows without snapshots are
   omitted and treated as upstream bugs in evals.
8. Candidate status remains on the candidate domain and reads candidate-safe
   projections only.
9. S7 does not require Adam approval because implementation is offline,
   non-destructive, no live outbound, no paid operation, and no employer-scope
   expansion beyond read-only passed profiles.

## Wave Plan

### Wave A - Contracts And Persistence Tests

- Strengthen `EmployerVisibleProfile` as needed for S7 display fields.
- Add helpers for snapshot idempotency and employer-visible transition.
- Add reducer/schema tests for PASS, NOT_PASS, PAUSE, and no score gate.

### Wave B - Prescreen Outcome Services

- Wire `prescreen_started` at session start.
- Wire PASS / NOT_PASS / PAUSE terminal candidate-job events.
- Create employer-visible snapshot only on PASS and only through persistence.

### Wave C - Admin And Candidate UI

- Add admin passed-candidates callable and dashboard page.
- Add or adjust candidate match/status display for interview and outcome state.

### Wave D - Eval, HITL, And Safety Harness

- Add deterministic S7 eval fixtures for direct and outbound paths.
- Add static/query guard that admin surface reads only passed snapshots.
- Add no-outbound and domain regression smokes.

### Wave E - Integration, Deploy, Acceptance

- Run package gates and acceptance harness.
- Deploy functions/admin hosting if changed.
- Run non-sending live smokes.
- Update `ACCEPTANCE.md`, `SUMMARY.md`, and artifacts.

## Verification Harness

Minimum local gates:

- `pnpm --filter @pa/core-types test`
- `pnpm --filter @pa/core-types typecheck`
- `pnpm --filter @pa/pa-persistence test`
- `pnpm --filter @pa/pa-persistence typecheck`
- focused functions tests for prescreen outcome and passed profile callable
- `pnpm --filter @pa/functions test`
- `pnpm --filter @pa/functions typecheck`
- `pnpm --filter @pa/functions build`
- dashboard tests and build if admin UI touched
- landing tests/build if candidate UI touched
- `node --import tsx --test tests/eval/s7-first-interview-passed-surface/*.test.ts`
- route smoke for candidate domain and admin redirect
- auth-blocked callable smoke
- outbound count before/after non-sending smoke

## HITL And Flywheel

- PASS with incomplete PII must be visible as a review state or explicit
  consent-missing field; it must not silently overexpose.
- Transcript/reason mismatch and sensitive/safety concerns should be represented
  as flags for S8 HITL even if S7 only writes the field.
- Employer view/advance/reject events are S8 scope unless needed as read-only
  placeholders in S7.

## Progress

- [x] Merged S6 PR #30 to `main`.
- [x] Fetched updated `origin/main`.
- [x] Created S7 worktree from `origin/main@16ab52b`.
- [x] Read S7 roadmap section and upstream S6 acceptance.
- [x] Wrote initial S7 context.
- [x] Requested executor `AGENT_PLAN` outputs.
- [x] Integrate executor plans.
- [ ] Implement.
- [ ] Verify locally.
- [ ] Deploy and smoke if code changes.
- [ ] PR, checks, merge.

## Decision Log

- S7 starts from `origin/main`, not the dirty root `main` checkout.
- PASS snapshot is the employer boundary; admin pages must not query arbitrary
  global candidate docs as the primary employer surface.
- Non-sending smoke remains the default live verification boundary for S7.
- `/admin/passed-candidates` requires a job id and is PA-admin authenticated in
  S7.
- PASS snapshot creation immediately advances the job state to
  `employer_visible`; candidate surfaces still render it as passed.
- Missing PII consent is displayed as consent missing, not filled by exposing
  raw contact fields.

## Surprises And Discoveries

- Existing S1 primitives already include `EmployerVisibleProfile` and a
  persistence helper that requires passed state. S7 should wire and harden this
  path rather than inventing a second passed-profile model.

## Outcomes And Retrospective

Pending.
