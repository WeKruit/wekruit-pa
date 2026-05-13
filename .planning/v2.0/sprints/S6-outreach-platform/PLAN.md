# S6 Plan - Outreach Platform

## Status

Implementation, local verification, targeted S6 deploy, and non-sending smoke
checks are complete. PR checks and merge are pending. Broad project-wide
functions deploy is flagged on unrelated Cloud Run regional memory quota.

## Target Outcome

Given one approved enriched job and S5 candidate-job matches, the system can
produce audited outreach decisions, queue safe Sendblue invites for selected
candidates, and show admins the queue, capacity, cooldown, and failure state.

S6 must make outbound possible but safe. It must not turn S5 `auto_outbound`
into an unbounded send. Policy, idempotency, capacity, cooldowns, and HITL gates
come before `pa-outbound` writes.

## Non-Goals

- No employer candidate browsing.
- No scheduling, notes, or message-on-behalf-of features.
- No candidate route migration.
- No raw candidate list reads from candidate-facing client code.
- No direct Sendblue REST calls outside the existing outbox path.
- No compatibility patch that leaves the old reverse-match notify path as the
  primary S6 system.

## Wave Plan

### Wave A - Contracts And Policy State

- Extend `OutboundInvite` for policy evidence:
  - `matchId`
  - `policyVersion`
  - `decisionReason`
  - `blockedSignals`
  - `cooldownUntil`
  - `stickyAccountGroupId`
  - `capacitySnapshot`
  - `approvalState`
  - `dryRun`
- Add deterministic invite id helper.
- Add persistence helpers:
  - write invite decision idempotently
  - transition `CandidateJobState` to `outbound_queued` only after queueing
  - transition to `outbound_sent` only from delivery evidence

### Wave B - Outreach Policy And Queue Service

- Build a pure policy evaluator:
  - opted out / do-not-contact
  - candidate lifecycle not reachable
  - S5 low score or `do_not_contact`
  - cooldown active
  - duplicate company/role/job
  - recent decline
  - account capacity full
  - warmup/HITL-required batch
- Build a service that reads job + matches + candidate profiles and creates
  invite decisions.
- Queue `pa-outbound` only through existing broker/outbox primitives and only
  after policy allows it.

### Wave C - Sendblue Capacity And Delivery Integration

- Make Sendblue pool capacity enforceable, not decorative.
- Preserve sticky candidate -> group/number assignment.
- Track daily/rolling utilization per group.
- Connect Sendblue delivery status back to `OutboundInvite` and
  `CandidateJobState` without duplicating provider logic.

### Wave D - Admin Outreach Ops

- Add or extend admin surface for:
  - job outreach preview
  - invite queue
  - policy blocks
  - HITL approval batches
  - capacity and cooldown state
  - retry/dead-letter state
- Keep UI dense and operator-focused.

### Wave E - Eval, Safety, Deploy

- Tests for all policy branches in the S6 roadmap.
- Dry-run integration fixture from approved job -> invite decisions.
- No duplicate sends and capacity cap tests.
- Static guard that S6 does not call Sendblue directly outside outbox.
- Deploy functions/admin hosting after code changes.
- Live smoke uses dry-run or auth-blocked probes first. Any actual outbound
  requires explicit approval unless a test-only allowlisted candidate path is
  already documented.

## Executor Split

- A: contracts, invite ids, reducers, persistence helpers.
- B: pure policy evaluator and queue service.
- C: Sendblue capacity/utilization and delivery-state wiring.
- D: admin Outreach Ops UI.
- E: evals, static guards, acceptance, deploy/smoke harness.

## Implementation Gate

Passed. Executor plans are recorded in `EXECUTOR-PLANS.md`.

## Lead Integration Note

S6 is not a CI sprint. CI is only the final verification layer. The product
path is: S5 match -> deterministic outreach policy -> typed invite decision
row -> capacity/cooldown/HITL gate -> optional approved queue row -> existing
Sendblue outbox -> delivery evidence -> invite/candidate-job state.

Locked decisions:

- No live candidate contact in S6 acceptance. Deploy and smoke only dry-run or
  auth-blocked paths unless a later sprint defines an allowlisted live path.
- Dry-run may persist `pa-outbound-invites` rows with `dryRun: true`; it must
  not create `pa-outbound`.
- Live queueing requires server-side `dryRun: false` and
  `approvalMode: "approved"`.
- Capacity-full blocks live queueing; warmup requires HITL and cannot auto-send.
- Missing/invalid capacity blocks S6 outbound.
- Per-group UTC daily accepted outbound count is the hard cap. Rolling 24h is
  display/debug only.
- Candidate cooldown is 7 days; same-company/role cooldown is 30 days.
- `outbound_queued` requires queue evidence. `outbound_sent` requires outbox or
  provider delivery evidence. Policy approval is not delivery evidence.
- Legacy `paReverseMatch` notify/bulk notify remains legacy and must not be the
  S6 primary path.

Shared write ownership:

- Lead owns `apps/functions/src/index.ts`, `apps/functions/src/sendblue/outbox.ts`,
  `apps/functions/src/sendblue/webhook.ts`, and `apps/dashboard-web/src/App.tsx`
  integration wiring after the scoped helpers land.
- Executor-owned files stay disjoint; no executor owns candidate-facing routes.

Execution order:

1. Wave A contracts and persistence helpers, with tests first.
2. Wave C capacity/delivery helpers in parallel with Wave B pure policy tests.
3. Wave B service and admin callables after A/C contracts are stable.
4. Wave D read-first admin page and lead route/nav wiring.
5. Wave E eval/static guard/acceptance, then full package gates, deploy, and
   non-sending smoke.

## Verification Harness

Minimum local gates:

- `pnpm --filter @pa/core-types test`
- `pnpm --filter @pa/core-types typecheck`
- `pnpm --filter @pa/pa-persistence test`
- `pnpm --filter @pa/pa-persistence typecheck`
- focused S6 function/service tests
- `pnpm --filter @pa/functions test`
- `pnpm --filter @pa/functions typecheck`
- `pnpm --filter @pa/functions build`
- dashboard tests/build if admin UI touched
- static guard for direct Sendblue calls and accidental unapproved bulk sends
- route smoke for existing candidate/admin domains after deploy

## Progress

- [x] Created S6 worktree from `origin/main` at merged S5.
- [x] Read S6 roadmap and current outreach primitives.
- [x] Collect executor plans.
- [x] Integrate plans.
- [x] Implement.
- [x] Verify locally.
- [x] Deploy and smoke.
- [ ] PR, checks, merge.
