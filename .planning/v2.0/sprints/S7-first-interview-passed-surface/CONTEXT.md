# S7 Context - First Interview + Passed Candidate Surface

## Repo State

- Date: 2026-05-13.
- Worktree: `.claude/worktrees/v2-S7-first-interview-passed-surface`.
- Branch: `codex/v2-S7-first-interview-passed-surface`.
- Base: `16ab52b feat(v2): add S6 outreach platform (#30)` from `origin/main`.
- Root `main` checkout is dirty with unrelated local edits, so S7 was created
  directly from `origin/main` to preserve those changes.

## Upstream S6

S6 is merged on `main` and provides the safe outreach base:

- `pa-outbound-invites` decision rows and deterministic invite ids.
- Capacity-aware Sendblue selection and transactional capacity reservation.
- `paAdminOutreachOpsSnapshot` and read-only `/admin/outreach-ops`.
- Candidate-job transitions to `outbound_queued` and `outbound_sent` require
  queue/provider delivery evidence.
- No live contact happened in S6 acceptance; route/auth/count smokes passed.

## Current S7 Primitives

- `packages/core-types/src/marketplace.ts`
  - `CandidateJobState` already includes `prescreen_started`, `passed`,
    `not_passed`, `paused`, and `employer_visible`.
  - `EmployerVisibleProfileSchema` exists and is snapshot-based.
  - `reduceCandidateJobState` already allows first interview from
    `candidate_matched`, `outbound_queued`, `outbound_sent`,
    `candidate_interested`, and `paused`.
- `packages/pa-persistence/src/marketplace.ts`
  - `writeEmployerVisibleProfile` exists and requires a linked
    `CandidateJobStateDoc` whose state is `passed`.
  - `applyCandidateJobEvent` writes deterministic candidate-job transitions.
- `apps/functions/src/prescreen-turn-handler.ts`
  - Routes active prescreen replies through `PreScreenPipeline`.
  - Calls `runPrescreenTerminalAction` after PASS / FAIL / HARD_STOP / PAUSE.
- `apps/functions/src/prescreen-terminal-action.ts`
  - PASS sends Level 1 reveal, starts PII confirm, and chains job recs.
  - FAIL and HARD_STOP start PII confirm and job recs for other jobs.
  - PAUSE writes `pausedAt`.
  - It does not yet materialize S7 candidate-job outcome or employer-visible
    snapshots.
- `apps/functions/src/prescreen-session-start.ts`
  - Creates `pa-prescreen-sessions` and sends first question.
- `apps/functions/src/sendblue/triggers/prescreen.ts`
  - Direct job page / iMessage trigger starts prescreen.
  - Public-page pending invite binds random `wkr_uid` to phone-resolved real
    candidate id.
- `apps/functions/src/identity/candidate-matches-api.ts`
  - Candidate `/me/matches` maps candidate-job state to candidate-facing
    statuses.
- `apps/dashboard-web/src/pages/CandidateMarketplace.tsx`
  - Admin marketplace summary counts passed/employer-visible and not-passed
    states separately.

## S7 Product Invariants

- First interview is never blocked by match score once a candidate enters a
  job flow.
- Direct candidate and outbound candidate paths must both reach the same
  prescreen outcome machinery.
- PASS creates an employer-visible snapshot; NOT_PASS and PAUSE do not.
- NOT_PASS candidates remain retained in the global marketplace pool.
- Employer/admin passed surface shows only passed snapshots, not a broad
  candidate browser.
- Employer-visible data is a snapshot, not arbitrary live reads of global
  candidate profile documents.
- Candidate routes remain on `candidate.wekruit.com` / `pa.wekruit.com`; admin
  routes remain under `wekruit-pa.web.app/admin/**`.
- PII consent state must be visible and respected before employer review.

## S7 Product Shape

The shortest correct path is:

1. Treat direct job page triggers and S6 outbound invite responses as entry
   points into the same first-interview prescreen flow.
2. On prescreen start, apply a `prescreen_started` candidate-job event without
   checking match score.
3. On terminal outcome:
   - PASS applies `prescreen_passed`, builds `EmployerVisibleProfile`, writes
     a `employer_snapshot_created` event, and shows it in admin.
   - FAIL / HARD_STOP applies `prescreen_not_passed`, preserves global
     candidate state, and does not write employer-visible profile.
   - PAUSE applies `manual_pause` and does not write employer-visible profile.
4. Admin `/admin/passed-candidates` reads only employer-visible snapshots,
   with joined safe display data from jobs/profile artifacts as needed.
5. Candidate-facing status shows clear interview/passed/not-passed/paused
   state without exposing employer-only fields prematurely.

## Open Risks To Resolve In Plan

- Exact snapshot source fields: how much profile, resume, transcript, Level 1,
  and match evidence can be copied into `EmployerVisibleProfile` without
  overexposing global profile data.
- Whether PASS snapshot creation should wait for PII confirm completion or
  create a snapshot immediately with explicit `consentAt` missing/HITL flag.
- How to connect outbound reply interest to `candidate_interested` before
  `prescreen_started` without accidental live sending.
- Which existing prescreen transcript fields are stable enough for the passed
  dashboard.
