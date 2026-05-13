# S1 Executor Plans

Executor plans use the `AGENT_PLAN` format from `.planning/AUTONOMOUS-SPRINT-HARNESS.md`.

## Executor A - Core Contracts

AGENT_PLAN
Executor:
A - Core Contracts

Objective:
Define S1 marketplace source-of-truth contracts in `@pa/core-types`: Zod schemas, exported TypeScript types, Firestore collection constants, and pure deterministic reducers for global candidate lifecycle and per-job candidate opportunity state.

Files to read:
README.md; CLAUDE.md; `.planning/AUTONOMOUS-SPRINT-HARNESS.md`; S1 `CONTEXT.md`; S1 `PLAN.md`; `packages/core-types/src/index.ts`; `packages/core-types/src/collections.ts`; `packages/core-types/src/broker.ts`; `packages/core-types/src/matching-jobs.ts`; `packages/core-types/src/scheduled-jobs.test.ts`; `packages/core-types/package.json`; `packages/core-types/tsconfig.json`; `packages/shared-tags/src/index.ts`; `packages/shared-tags/src/types.ts`; `packages/shared-tags/src/schemas.ts`.

Exclusive write scope:
`packages/core-types/src/marketplace.ts`; `packages/core-types/src/index.ts`; `packages/core-types/src/collections.ts`; `packages/core-types/package.json`; `packages/core-types/src/*.test.ts` if needed.

Shared files needed:
`pnpm-lock.yaml` if `@pa/core-types` adds direct `tsx` for tests. Lead owns lockfile update.

Dependencies on other executors:
Executor B, C, and D depend on these schemas, reducers, collection constants, and doc id helpers.

Proposed steps:
Add marketplace primitives, lifecycle and candidate-job state schemas exactly from README, document schemas, reducer event schemas, pure reducers, S1 collection constants, and public exports. Use shared-tag schemas instead of duplicate vocab. Keep handles hash-based for ids and normalized values optional/operator-only.

Tests/evals to add or run:
Add `packages/core-types/src/marketplace.test.ts`; run `pnpm --filter @pa/core-types typecheck`; run `pnpm --filter @pa/core-types test`.

Safety/privacy checks:
No raw PII in deterministic ids; no employer-visible profile before passed candidate-job state; no LLM direct state assignment; no broad employer browsing contract.

Stop conditions:
Stop if a state transition needs a new product rule, if raw PII is required for an id, or if implementation would break existing `UserSchema` consumers.

Expected artifacts:
`marketplace.ts`, `marketplace.test.ts`, updated exports/constants/package metadata.

Questions for lead:
Lead answer: lead owns `pnpm-lock.yaml`. Export both full `CandidateProfileSchema` and narrower `CandidateProfileMarketplaceFieldsSchema` for additive writes to existing `pa-users`.

## Executor B - Persistence

AGENT_PLAN
Executor:
B - Persistence

Objective:
Plan and later implement Firestore persistence helpers for S1 marketplace state transitions and append-only event writes, without changing product routing, live outbound behavior, or global/job state ownership.

Files to read:
README.md; CLAUDE.md; S1 `CONTEXT.md`; S1 `PLAN.md`; `packages/pa-persistence/src/index.ts`; `packages/pa-persistence/package.json`; existing persistence helpers/tests; `packages/core-types/src/index.ts`; `packages/core-types/src/collections.ts`; `packages/core-types/src/marketplace.ts` after Executor A.

Exclusive write scope:
`packages/pa-persistence/src/marketplace.ts`; `packages/pa-persistence/src/marketplace.test.ts`; `packages/pa-persistence/src/index.ts`; `packages/pa-persistence/package.json`.

Shared files needed:
Read-only dependency on core-types marketplace schemas/reducers/constants.

Dependencies on other executors:
Executor A must finalize contracts first. Executor C and D depend on persisted shapes and collection constants.

Proposed steps:
Import only from `@pa/core-types`; add transaction-style helpers that parse inputs, call reducers, persist reducer output, update `pa-users` marketplace fields, update `pa-candidate-job-states`, write audit rows, write append-only feedback/correction events, and create employer-visible snapshots only after passed state.

Tests/evals to add or run:
Add fake-Firestore tests covering lifecycle transition, idempotency, candidate-job `not_passed`, match score not gating interview state, append-only event duplicate behavior, and employer-visible snapshot passed-state guard. Run `pnpm --filter @pa/pa-persistence typecheck` and `pnpm --filter @pa/pa-persistence test`.

Safety/privacy checks:
No raw PII in ids; no live Sendblue or `pa-outbound` writes; reducers own state; `NOT_PASS` stays job-specific; feedback/correction are append-only.

Stop conditions:
Stop if core contracts are missing, if implementation needs files outside scope, if reducer behavior violates product locks, or if any helper requires production migration/live outbound.

Expected artifacts:
`packages/pa-persistence/src/marketplace.ts`, `marketplace.test.ts`, exports, package test script update.

Questions for lead:
Lead answer: use existing `pa-audit-events` for transition audit. Duplicate append-only event ids return the existing event only when the payload is identical and throw on conflict. Include the employer-visible snapshot helper in S1, guarded by passed candidate-job state.

## Executor C - Admin Inspector

AGENT_PLAN
Executor:
C - Admin Inspector

Objective:
Plan and later implement the admin-only candidate marketplace inspector for S1, showing global candidate profile data separately from job-specific marketplace state inside the existing operator dashboard, without creating employer-wide candidate browsing or candidate-facing routes.

Files to read:
README.md; CLAUDE.md; S1 `CONTEXT.md`; S1 `PLAN.md`; `apps/dashboard-web/src/App.tsx`; `apps/dashboard-web/src/pages/UserDetail.tsx`; `apps/dashboard-web/src/pages/Users.tsx`; `apps/dashboard-web/src/pages/MatchCandidates.helpers.ts`; `apps/dashboard-web/src/pages/__tests__/MatchCandidates.test.ts`; `apps/dashboard-web/src/components/ui.tsx`; final core-types marketplace contracts.

Exclusive write scope:
`apps/dashboard-web/src/pages/CandidateMarketplace.helpers.ts`; `apps/dashboard-web/src/pages/CandidateMarketplace.tsx`; `apps/dashboard-web/src/pages/__tests__/CandidateMarketplace.test.ts`; narrow additions to `UserDetail.tsx`; no `App.tsx` route unless lead changes scope.

Shared files needed:
Core collection constants/types; `UserDetail.tsx` tab integration.

Dependencies on other executors:
Executor A final types/constants. Executor D operator read rules. No dependency on B unless persisted fields differ from A.

Proposed steps:
Create pure helper module and tests; create read-only candidate-scoped `CandidateMarketplace` component; fetch by candidate id from S1 collections; render global profile, handles/resumes, job states/matches/invites/snapshots, feedback, and corrections; add one `Marketplace` tab to `UserDetail`.

Tests/evals to add or run:
Run `node --import tsx --test apps/dashboard-web/src/pages/__tests__/CandidateMarketplace.test.ts`; run nearby `MatchCandidates.test.ts`; run `npm run build --workspace=@pa/dashboard-web`.

Safety/privacy checks:
Admin-only, no public route, no employer browsing, no mutation buttons, no raw PII ids in UI, clear global-vs-job separation.

Stop conditions:
Stop if core contracts are unavailable or if implementation requires broad navigation/employer browsing.

Expected artifacts:
CandidateMarketplace helper/component/test and minimal `UserDetail` tab integration.

Questions for lead:
None.

## Executor D - Firebase / Acceptance

AGENT_PLAN
Executor:
D - Firebase / Acceptance

Objective:
Plan S1 Firestore rules, composite indexes, and acceptance harness so marketplace data foundation collections are private by default, operator-visible for admin inspection, append-only where the product requires flywheel events, and verified without live outbound or production mutation.

Files to read:
README.md; CLAUDE.md; `.planning/AUTONOMOUS-SPRINT-HARNESS.md`; S1 `CONTEXT.md`; S1 `PLAN.md`; S1 `ACCEPTANCE.md`; `config/firebase/firestore.rules`; `config/firebase/firestore.indexes.json`; `firebase.json`; package scripts; final core contracts and inspector query shape.

Exclusive write scope:
`config/firebase/firestore.rules`; `config/firebase/firestore.indexes.json`; S1 `ACCEPTANCE.md`; S1 `SUMMARY.md`; S1 `artifacts/*`.

Shared files needed:
Read-only core collection constants, dashboard query shape, and persistence helper behavior.

Dependencies on other executors:
Executor A final collection and field names; Executor B write ownership; Executor C query shapes.

Proposed steps:
Add S1 marketplace rules for all new collections; keep marketplace reads operator-only for S1; keep employer-visible profiles operator-only; make feedback/correction append-only at client rules; add only actual candidate/job scoped indexes; preserve existing public exceptions; update acceptance docs and artifacts.

Tests/evals to add or run:
JSON-parse index file; run Firebase rules validation if available; run targeted core/persistence/dashboard checks; run standing URL regressions.

Safety/privacy checks:
No raw PII in ids or index fields; no public reads for marketplace profile data; append-only feedback/correction; no live outbound or candidate contact.

Stop conditions:
Stop if rules expose candidate data publicly, if query shape becomes broad employer browsing, or if Firebase validation fails.

Expected artifacts:
Updated rules/indexes, acceptance ledger, and artifact logs.

Questions for lead:
Lead answer: browser access is read-only for state collections. For `pa-feedback-events` and `pa-correction-events`, allow operator create/read only and deny update/delete to enforce append-only client behavior. S1 dashboard does not write marketplace docs; persistence helpers use Admin SDK paths.
