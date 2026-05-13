# S7 Executor Plans

Plan-only executor handshakes requested on 2026-05-13. Product code edits are
blocked until all `AGENT_PLAN` outputs are recorded and integrated in `PLAN.md`.

## Lead Integration Decisions

- PASS chain: `prescreen_started` -> `prescreen_passed` -> deterministic
  `EmployerVisibleProfile` -> `employer_snapshot_created`, ending the
  candidate-job state as `employer_visible`.
- Candidate-facing status collapses `employer_visible` to passed. The candidate
  copy must not imply broad employer sharing when consent is incomplete.
- PASS snapshots may omit display name/contact consent fields when PII consent
  is missing. They must never include raw email, phone, LinkedIn URL, handle
  values, resume storage URL, or raw contact values. Admin must show consent
  missing explicitly.
- `prescreenSessionId` is materialized on the candidate-job state through the
  reducer/persistence path; event evidence alone is not enough for S7 because
  the admin transcript projection needs a scoped session link.
- `/admin/passed-candidates` is PA-admin authenticated only in S7. It must
  require `jobId`, read `pa-employer-visible-profiles` as the list source, and
  omit passed state rows that lack snapshots. Missing snapshots are an upstream
  bug covered by evals, not a reason to broaden the query.
- No live outbound is part of S7 verification unless explicitly approved later.

## A - Contracts, Reducers, Persistence

Objective: make PASS create exactly one employer-visible snapshot, keep
NOT_PASS/PAUSE invisible, preserve score-independent interview start, and keep
employer reads snapshot-only.

Exclusive write scope:

- `packages/core-types/src/marketplace.ts`
- `packages/core-types/src/marketplace.test.ts`
- `packages/core-types/src/index.ts` only for new exported helpers/types
- `packages/pa-persistence/src/marketplace.ts`
- `packages/pa-persistence/src/marketplace.test.ts`
- `packages/pa-persistence/src/index.ts` only for exported helpers

Plan:

- Extend candidate-job event/state contracts with `prescreenSessionId` and
  `employerVisibleProfileId`.
- Strengthen `EmployerVisibleProfile` as a safe, deterministic, denormalized
  snapshot with source ids, summaries, consent status, pass reason, and match
  reason.
- Add an idempotent persistence helper for PASS: apply `prescreen_passed`,
  write deterministic snapshot, link state, apply `employer_snapshot_created`.
- Preserve reducer constraints: only passed can become employer-visible; no
  NOT_PASS/PAUSE path can create visibility.
- Test idempotency, conflicting duplicate rejection, raw PII rejection, and no
  score gate.

## B - Backend Prescreen Outcome Wiring

Objective: wire the existing first-interview runtime into candidate-job state
and passed-profile persistence for both direct and outbound entry paths.

Exclusive write scope:

- `apps/functions/src/prescreen-outcome-service.ts`
- `apps/functions/src/prescreen-session-start.ts`
- `apps/functions/src/prescreen-terminal-action.ts`
- `apps/functions/src/prescreen-terminal-action.test.ts`
- focused new prescreen outcome tests under `apps/functions/src`

Plan:

- Add event builders and service functions for `prescreen_started`,
  `prescreen_passed`, `prescreen_not_passed`, and `manual_pause`.
- Call `markFirstInterviewStarted` from `runPreScreenForUser` before the first
  question is sent or re-emitted for active sessions.
- Call terminal outcome persistence before terminal side effects. PASS uses
  A's helper; FAIL/HARD_STOP creates NOT_PASS only; PAUSE creates PAUSE only.
- Use deterministic event ids from `sessionId` so retries are idempotent.
- Never inspect match score or hard-filter evidence before first interview.

## C - Admin Passed Candidate Surface

Objective: build admin-only `/admin/passed-candidates` for a selected job,
using passed snapshots as the source of truth and avoiding broad candidate
browsing.

Exclusive write scope:

- `apps/functions/src/admin-passed-candidates.ts`
- `apps/functions/src/__tests__/admin-passed-candidates.test.ts`
- `apps/dashboard-web/src/pages/PassedCandidates.tsx`
- `apps/dashboard-web/src/pages/PassedCandidates.helpers.ts`
- `apps/dashboard-web/src/pages/__tests__/PassedCandidates.test.ts`

Shared lead-owned files:

- `apps/functions/src/index.ts`
- `apps/dashboard-web/src/App.tsx`

Plan:

- Add callable `paAdminPassedCandidatesSnapshot` with admin auth, required
  `jobId`, clamped `limit`, and snapshot-only list source.
- Join only allowlisted fields from linked state, safe profile/self-profile
  docs, and linked prescreen turns by `prescreenSessionId`.
- Redact email, phone, resume URLs, storage URIs, and handle-like values.
- Add a read-only dashboard page with a required job filter and no outreach,
  scheduling, notes, search, or message controls.

## D - Candidate Status And Direct/Outbound Entry UX

Objective: ensure candidate-domain UX reflects the real candidate-job state for
direct and outbound candidates without reading admin/employer data.

Exclusive write scope:

- `apps/pa-landing/src/pages/PublicJob.tsx`
- `apps/pa-landing/src/pages/CandidateMatches.tsx`
- `apps/pa-landing/src/lib/candidate-job-status.ts`
- `apps/pa-landing/src/lib/candidate-job-status.test.ts`

Shared sequenced file:

- `apps/functions/src/identity/candidate-matches-api.ts`
- `apps/functions/src/identity/candidate-matches-api.test.ts`

Plan:

- Project `pa-candidate-job-states` into `/me/matches` so direct state-only
  rows are visible even without a match or outbound invite.
- Map `prescreen_started` to interview started, `passed` and
  `employer_visible` to passed, `not_passed` to role-specific not passed, and
  `paused` to paused.
- Add candidate-facing status helper and concise next-step copy.
- Keep `PublicJob` post-click copy limited to “continue in iMessage / sign in
  for status” and avoid claiming backend interview state from local click state.

## E - Eval, HITL, Acceptance Harness

Objective: prove direct and outbound candidates can complete first interview,
PASS is visible, NOT_PASS/PAUSE stay invisible, low match score cannot block
entry, domain split remains locked, and S7 verification does not contact real
candidates.

Exclusive write scope:

- `tests/eval/s7-first-interview-passed-surface/**`
- `tests/scenarios/s7-first-interview-passed-surface/**`
- S7 artifacts under
  `.planning/v2.0/sprints/S7-first-interview-passed-surface/artifacts/`

Plan:

- Add offline fake-firestore fixtures for direct PASS, outbound PASS, NOT_PASS,
  PAUSE, snapshot-only query, consent-missing, and domain/no-contact guards.
- Add static guards against Sendblue provider use, direct message sending,
  `pa-outbound` writes, and candidate `/j` routes on the admin domain.
- Emit eval summary artifacts with scenario, terminal, state, snapshot count,
  hidden non-passed count, outbound write count, and domain checks.
