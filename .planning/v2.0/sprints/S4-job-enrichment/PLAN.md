# S4 Plan - Job Enrichment

## Status

Planning in progress. Executor AGENT_PLAN handshakes are being collected before
implementation.

## Target Outcome

A raw job can produce an enriched job draft with shared-tag-aligned tags, hard
filters, soft scoring weights, prescreen config draft, scoring rubric, Claire
brief, eval fixtures, confidence metadata, and HITL review state. An operator
can approve or correct the enrichment before it is treated as matching and
prescreen ready.

## Wave Plan

### Wave A - Contracts, Reducers, Fixtures

- Add `JobOpportunity` / enrichment draft schemas in core types.
- Define approval/review states and deterministic status transitions.
- Add test fixtures for strong, weak, ambiguous, visa mismatch, location
  mismatch, and salary mismatch cases.
- Add correction-event helpers for job enrichment edits.
- Store drafts in `pa-jobs/{jobId}/enrichment/{draftId}` so public
  `pa-jobs/{jobId}` reads cannot see unpublished review state.

### Wave B - Service/API

- Reuse `@pa/job-tag-enricher` and sponsorship inference.
- Generate the full draft output: tags, hard filters, soft weights, prescreen
  draft, rubric, Claire brief, eval fixtures, confidence, HITL flags.
- Add admin-only callable or HTTP endpoint for draft generation and approval.
- Keep failures reviewable; do not silently publish partial demand.
- Promote only public-safe approved fields to `pa-jobs/{jobId}`.

### Wave C - Admin UI

- Add `/admin/job-enrichment` review surface.
- Show extracted tags, hard filters, soft signals, draft questions, rubric,
  Claire brief, confidence, and review flags.
- Allow approve/correct actions through server APIs only.
- Keep UI operator-dense and consistent with existing dashboard pages.

### Wave D - HITL, Eval, Rules, Acceptance

- Write correction events for job tag/question/rubric/brief edits.
- Store generated eval fixtures and make corrections reusable as regression
  fixtures.
- Review Firestore rules/indexes for new admin-only collections or fields.
- Add dry-run and live-smoke acceptance steps.

## Lead Decisions

- Draft/review docs: `pa-jobs/{jobId}/enrichment/{draftId}`.
- Eval fixture docs: `pa-jobs/{jobId}/enrichment-eval-fixtures/{fixtureId}`.
- First-class scoring rubric stays on the draft.
- Claire brief stays separate from public job page copy.
- `approvalReady` means machine coverage/confidence is high enough for operator
  review; it is never the same as admin approval.

### Wave E - Integration, Deploy, Land

- Run package tests, functions tests, dashboard tests/typecheck/build, rules
  dry-run, route regressions, and live admin/candidate smoke as needed.
- Deploy directly if code changes touch Firebase-hosted or functions behavior.
- PR checks and merge completed; S4 landed as
  `e27edf6 feat(v2): add job enrichment review pipeline` through PR #27. S5
  has already landed after S4.

## Executor Split

- A: contracts and persistence.
- B: enrichment service/API.
- C: admin review UI.
- D: prescreen draft, rubric, Claire brief, eval fixtures.
- E: rules, indexes, correction events, acceptance ledger.

## Implementation Gate

No implementation begins until executor AGENT_PLANs are integrated into
`EXECUTOR-PLANS.md`.
