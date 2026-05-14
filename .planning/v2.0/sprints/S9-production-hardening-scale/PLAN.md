# S9 Plan - Production Hardening + Scale

## 1. Purpose / Big Picture

Make the v2 marketplace launch-ready: operators can see production health,
candidates can request privacy actions, outreach has a manual stop switch, and
live smoke/load harnesses prove the marketplace path without accidental contact
or destructive data changes.

## 2. Observable User Outcome

- Candidate can find privacy/export/delete/stop controls in the candidate
  surface and submit a request.
- Operator can open one launch readiness dashboard and see queue health,
  Sendblue capacity, parse/match/outbound failures, eval status, and privacy
  requests.
- Lead can run S9 smoke/load checks in dry-run/count-only mode and prove no
  unintended outbound or destructive privacy action occurred.

## 3. Current Repo Orientation

- Candidate routes live in `apps/pa-landing`.
- Admin routes live in `apps/dashboard-web`.
- Production callables and triggers live in `apps/functions/src`.
- Shared marketplace contracts live in `packages/core-types`.
- Persistence helpers live in `packages/pa-persistence`.
- Existing readiness-adjacent surfaces include:
  - `/admin/sendblue-pool`
  - `/admin/operations`
  - `/admin/qa-evaluator`
  - `/admin/flywheel-eval`
  - `/admin/outreach-ops`
  - `/admin/bulk-resumes`
  - `/admin/passed-candidates`

## 4. Locked Invariants And Non-Goals

- No broad employer candidate browsing.
- No automatic live Sendblue/Instantly/LinkedIn sends.
- No destructive privacy delete without explicit approval.
- No raw PII in eval artifacts, launch reports, logs, or dashboard summary rows.
- No candidate routes on admin hosting.
- No new hosting site.
- No new tag taxonomy.
- No re-litigation of S5 matching score behavior.

## 5. Data Model And Ownership

Likely S9 additions:

- `PrivacyRequest`
  - request id, candidate id, request kind, status, source surface, createdAt,
    updatedAt, requestedBy, redacted evidence, admin resolution fields.
- `LaunchReadinessSnapshot`
  - generatedAt, queue counts, failure counts, capacity summary, eval summary,
    route/callable smoke summary, privacy request summary.
- `OutreachStopControl`
  - global and campaign/batch-level stop flags, reason, actor, updatedAt.

Ownership:

- Privacy request records are append-first and admin-resolved.
- Launch readiness snapshots are read-only summaries over existing collections.
- Stop controls are deterministic gates checked before outbound enqueue/send.

## 6. UI Surface Map

Candidate:

- Extend `/me/profile` or a nearby candidate account/privacy area with
  open-ended privacy/export/delete/stop request actions.
- Keep controls clear and direct; do not create a marketing/legal page instead
  of an actionable surface.

Admin:

- Add `/admin/launch-readiness`.
- Show compact status bands, counts, stale age, and links to source surfaces.
- Include privacy request queue and manual outreach stop state.
- Do not expose non-passed candidate browsing through readiness links.

## 7. Backend/API/Service Map

Likely services/callables:

- `paCandidatePrivacyRequest`
  - authenticated candidate callable;
  - writes privacy request only;
  - no destructive action.
- `paAdminLaunchReadinessSnapshot`
  - admin callable;
  - reads collection counts and recent failure summaries;
  - returns redacted snapshot.
- `paAdminOutreachStopControl`
  - admin callable for toggling stop controls;
  - must be audited.
- outbound gate integration
  - Sendblue/outreach enqueue paths must check stop controls before creating
    contactable rows.

## 8. Executor Topology And Disjoint Write Scopes

Executor A - Contracts + Privacy Data

- Owns `packages/core-types`, `packages/pa-persistence`, privacy/launch
  contract tests.

Executor B - Functions + Stop Gates

- Owns `apps/functions/src/*launch*`, `*privacy*`, `*outreach*` stop gate
  changes, and focused function tests.

Executor C - Admin Launch Readiness UI

- Owns `apps/dashboard-web/src/pages/*Launch*`, admin client wrapper, tests,
  and minimal route/nav wiring.

Executor D - Candidate Privacy Controls

- Owns `apps/pa-landing/src/**` candidate privacy request UI/client wrapper and
  tests.

Executor E - Smoke/Load/Eval Harness

- Owns `tests/eval/s9-production-hardening-scale/**`,
  `tests/scenarios/s9-production-hardening-scale/**`, static guards, and S9
  artifacts.

Shared files:

- `apps/functions/src/index.ts`: B owns exports.
- `apps/dashboard-web/src/App.tsx`: C owns route/nav.
- `packages/core-types/src/index.ts`: A owns exports.

## 9. Agent Plan Handshake

Before implementation, collect `AGENT_PLAN` outputs from A-E and append them to
`EXECUTOR-PLANS.md`. Implementation must not start until an integration note is
added here.

## 10. Milestones

1. Create S9 docs and executor scopes.
2. Collect executor plans.
3. Integrate plans and lock the minimal vertical cut.
4. Wave A: contracts, privacy request persistence, fixtures, failing tests.
5. Wave B: admin/candidate callables and outbound stop gates.
6. Wave C: candidate privacy controls and admin launch readiness dashboard.
7. Wave D: dry-run smoke/load harness, static safety guards, route/callable
   checks.
8. Wave E: docs, deploy, live no-contact smoke, PR, merge.

## 11. Concrete Steps

1. Define S9 contracts for privacy requests, readiness snapshots, and stop
   controls.
2. Add append-only privacy request writer and audited stop-control writer.
3. Add admin launch readiness snapshot callable.
4. Add candidate privacy request callable.
5. Wire outbound stop gate into enqueue/send decision points.
6. Build `/admin/launch-readiness`.
7. Add candidate privacy controls to candidate account/profile surface.
8. Build S9 eval/static guard suite:
   - no live outbound in tests;
   - no destructive delete in tests;
   - no raw PII in readiness artifacts;
   - candidate routes stay on candidate domain.
9. Run dry-run/load/count smoke.
10. Deploy changed functions/hosting.
11. Run live no-contact smoke and count checks.

## 12. Verification Harness

Minimum expected commands:

- `pnpm --filter @pa/core-types test`
- `pnpm --filter @pa/core-types typecheck`
- `pnpm --filter @pa/pa-persistence test`
- `pnpm --filter @pa/pa-persistence typecheck`
- focused S9 functions tests
- focused dashboard tests for launch readiness
- focused landing tests for privacy request wrapper/UI
- `pnpm --dir tests/eval/s9-production-hardening-scale test`
- S5/S6/S7/S8 eval regression subset
- functions/dashboard/landing typecheck/build as touched
- `git diff --check`
- Firebase deploy for changed functions/hosting
- live no-contact smoke:
  - candidate route 200;
  - admin route 200;
  - unauth/admin callable gates;
  - outbound counts unchanged;
  - privacy request dry-run or test request does not delete data.

## 13. HITL And Flywheel Events

- Privacy requests are HITL queue items until resolved.
- Stop-control changes must write correction/audit-style events with actor,
  reason, and before/after state.
- Weekly eval review should surface S8 eval artifacts and correction backlog.

## 14. Safety And Privacy Checks

- Privacy delete implementation starts as request + preview only.
- Export/delete fulfillment requires explicit approval and a separate
  verification stage.
- Readiness artifacts must use counts and redacted summaries, not raw PII.
- Live outbound remains disabled unless Adam explicitly approves a live send
  smoke.
- Stop switch must fail closed for outbound enqueue/send paths.

## 15. Idempotence And Recovery

- Privacy request ids should be deterministic enough to avoid duplicate open
  requests for the same candidate/kind where appropriate.
- Stop-control writes must be audited and reversible.
- Readiness snapshots must be recomputable from source collections.
- Dry-run load tests must be repeatable without creating contactable outbound
  rows.

## 16. Progress

- S9 worktree and branch created from `origin/main` at S8 merge commit
  `90aaf29`.
- Initial context, plan, acceptance ledger, executor plan ledger, and artifacts
  directory created.

## 17. Decision Log

- Start S9 with non-destructive production readiness. Actual delete/export
  fulfillment and live outbound load smoke are approval-gated.

## 18. Surprises And Discoveries

- None yet.

## 19. Outcomes And Retrospective

- Pending implementation.
