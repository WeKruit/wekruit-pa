# S6 Executor Plans

All executor `AGENT_PLAN` handshakes completed on 2026-05-13 before product
code edits. Lead decisions are locked in `PLAN.md`.

## Executor A - Contracts, Invite IDs, Reducers, Persistence Helpers

Objective: extend the S6 source-of-truth contracts so outreach decisions are
auditable, deterministic, idempotent, and safe for downstream queueing without
sending anything directly.

Exclusive write scope:

- `packages/core-types/src/marketplace.ts`
- `packages/core-types/src/marketplace.test.ts`
- `packages/core-types/src/index.ts`
- `packages/pa-persistence/src/marketplace.ts`
- `packages/pa-persistence/src/marketplace.test.ts`
- `packages/pa-persistence/src/index.ts`

Required outputs:

- Extended `OutboundInvite` policy evidence fields.
- Deterministic `createOutboundInviteId` helper using internal ids only.
- Invite-linked candidate-job event payloads.
- Persistence helpers for idempotent invite decisions, queue linkage, and
  delivery evidence.
- Tests proving invite decisions do not send, queued requires queue evidence,
  sent requires provider/outbox evidence, and first interview remains
  candidate-accessible.

## Executor B - Pure Outreach Policy Evaluator And Queue Service

Objective: implement deterministic outreach policy and queue planning that
consumes S5 match rows, writes auditable invite decisions, and queues existing
`pa-outbound` rows only when policy allows it.

Exclusive write scope:

- `apps/functions/src/outreach/policy.ts`
- `apps/functions/src/outreach/service.ts`
- `apps/functions/src/outreach/types.ts`
- `apps/functions/src/outreach/index.ts`
- `apps/functions/src/outreach/__tests__/policy.test.ts`
- `apps/functions/src/outreach/__tests__/service.test.ts`
- `apps/functions/src/outreach/__tests__/fixtures.ts`

Required outputs:

- Pure evaluator with no Firestore/provider calls.
- Dry-run-first service with dependency-injected Firestore/enqueue/capacity.
- Policy blocks for opt-out, deleted/paused, no reachable route, S5
  `do_not_contact`, hard block, cooldown, duplicate invite, duplicate
  company/role, recent decline, capacity full, warmup, and large batch HITL.
- Queueing only through `@pa/pa-broker` `enqueueOutbound`.
- `outbound_queued` transition only after queue evidence.

## Executor C - Sendblue Capacity, Utilization, Delivery State

Objective: make Sendblue pool capacity enforceable for S6 outreach without
adding direct provider sends outside the existing outbox path.

Exclusive write scope:

- `apps/functions/src/sendblue/pool.ts`
- narrow helper files under `apps/functions/src/sendblue/`
- `apps/functions/src/sendblue/__tests__/pool-capacity.test.ts`
- `apps/functions/src/sendblue/__tests__/pool-utilization.test.ts`
- `apps/functions/src/sendblue/__tests__/pool-delivery-state.test.ts`

Required outputs:

- Capacity-aware sticky selection result:
  `{ ok, groupId, fromNumber, reason, capacitySnapshot }`.
- Group key from `groupId` when present, otherwise normalized number.
- Daily per-group cap as S6 hard cap; rolling 24h is health/debug.
- Warmup not auto-routable.
- Missing or invalid capacity blocks S6 outbound.
- Delivery normalization helper that is idempotent and monotonic.

## Executor D - Admin Outreach Ops UI

Objective: create an admin-only Outreach Ops page for inspecting invite
decisions, capacity, cooldowns, delivery/failure state, and HITL batches before
queueing.

Exclusive write scope:

- `apps/dashboard-web/src/pages/OutreachOps.tsx`
- `apps/dashboard-web/src/pages/OutreachOps.helpers.ts`
- `apps/dashboard-web/src/pages/__tests__/OutreachOps.test.ts`

Shared lead-owned route/nav wiring:

- `apps/dashboard-web/src/App.tsx`

Required outputs:

- Dense admin UI at `/admin/outreach-ops`.
- Backend snapshot driven; no client-side raw collection joins.
- No direct Sendblue calls and no client writes to `pa-outbound`.
- Read-only first pass unless server approval/queue callables recheck policy.
- Helper tests for request building, summaries, tones, capacity, and cooldown.

## Executor E - Evals, Static Guards, Acceptance, Deploy/Smoke Harness

Objective: create the S6 verification plane without product-code changes.

Exclusive write scope:

- `tests/eval/s6-outreach-platform/`
- `.planning/v2.0/sprints/S6-outreach-platform/ACCEPTANCE.md`
- `.planning/v2.0/sprints/S6-outreach-platform/artifacts/`

Required outputs:

- Deterministic S6 eval fixtures and policy/dry-run/outbound-count tests.
- Static guard blocking direct Sendblue/provider calls in new S6 code outside
  outbox/client primitives.
- Static guard blocking legacy reverse-match notify as S6 primary path.
- Acceptance ledger with before/after outbound counts, deploy output, route
  smoke, auth-blocked callable probes, and hard stop conditions.

## Cross-Executor Decisions

- No live candidate contact is allowed for S6 acceptance. Close S6 with dry-run
  and auth-blocked live probes.
- Dry-run may persist `pa-outbound-invites` decision rows with `dryRun: true`.
- Live queueing is disabled unless `dryRun: false` and explicit
  `approvalMode: "approved"` are passed server-side.
- Capacity-full is `blocked` for live queueing and visible in admin.
- Warmup requires HITL and never auto-routes.
- Missing/invalid group capacity blocks S6 outbound.
- Capacity hard cap is accepted outbound sends per group per UTC day.
- Rolling 24h utilization is displayed as health/debug, not a hard blocker.
- Candidate-level cooldown: 7 days. Same-company/role cooldown: 30 days.
- `capacitySnapshot` is typed:
  `{ groupId, fromNumber?, status, dailyCap, usedToday, remainingToday,
  rolling24hUsed?, checkedAt, reason? }`.
- `approvalState` is per invite:
  `not_required | pending | approved | rejected`.
- `policyDecision` preserves the original deterministic policy result;
  approval does not rewrite it to `manual_approved`.
- Deterministic invite id is candidate/job scoped and includes `matchId` when
  present; it does not include policy version so reruns remain idempotent for
  the same opportunity.
- Candidate decline/cooldown global effects belong to policy/persistence
  services, not automatic reducer archive behavior.
- Outreach Ops callable names:
  `paAdminOutreachOpsSnapshot`, `paAdminPreviewJobOutreach`,
  `paAdminApproveOutreachBatch`, and `paAdminQueueApprovedOutreach`.
- Initial UI defaults to latest global invite decisions with optional job
  filter, candidate display label from backend, and daily capacity plus rolling
  24h health.
