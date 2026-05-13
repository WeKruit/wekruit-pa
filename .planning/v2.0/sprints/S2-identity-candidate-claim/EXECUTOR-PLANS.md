# S2 Executor Plans

Executor plans use the `AGENT_PLAN` format from
`.planning/AUTONOMOUS-SPRINT-HARNESS.md`.

Note: the executors were spawned while the lead-side S2 docs were being copied
into the S2 worktree, so each plan reported `CONTEXT.md` and `PLAN.md` as
missing. The files now exist. The lead integrated the plans in `PLAN.md` and
answered the open questions before implementation.

## Executor A - Identity Contracts And Persistence

AGENT_PLAN
Executor:
A - Identity Contracts And Persistence

Objective:
Define S2 identity and candidate-claim contracts plus persistence primitives
for deterministic candidate identity resolution. Use hashed handles for lookup
ids, keep PDF-extracted email primary, treat employer email as a hint, write
audited handle/claim/conflict events, and avoid raw PII document ids.

Files to read:
README.md; CLAUDE.md; AGENTS.md; `.planning/AUTONOMOUS-SPRINT-HARNESS.md`;
S2 `CONTEXT.md`; S2 `PLAN.md`; `packages/core-types/src/marketplace.ts`;
`packages/core-types/src/collections.ts`; `packages/core-types/src/index.ts`;
`packages/pa-persistence/src/marketplace.ts`;
`packages/pa-persistence/src/index.ts`;
`packages/pa-persistence/package.json`; adjacent marketplace tests.

Exclusive write scope:
`packages/core-types/src/marketplace.ts`; `packages/core-types/src/collections.ts`;
`packages/core-types/src/index.ts`; `packages/core-types/src/*.test.ts`;
`packages/pa-persistence/src/identity.ts`;
`packages/pa-persistence/src/identity.test.ts`;
`packages/pa-persistence/src/index.ts`;
`packages/pa-persistence/package.json`.

Shared files needed:
Lead owns `pnpm-lock.yaml`. Other executors consume exported contracts only.

Dependencies on other executors:
B, C, and D wait for final schemas, collection constants, and identity helper
interfaces.

Proposed steps:
Add identity schemas and collection constants for auth mapping, redacted
self-profile, identity events, and identity conflicts. Add normalizers/hash id
helpers. Implement persistence helpers for handle link, candidate resolution,
candidate claim, redacted self-profile write, and deterministic conflict write.
Export all public helpers.

Tests/evals to add or run:
Core tests for no raw PII ids, email normalization, same email hash, PDF email
primary, mismatch conflict contract, and claim event shape. Persistence tests
for existing handle resolution, duplicate idempotency, conflicting handles,
employer-email mismatch, auth mapping, redacted self-profile write, and no
silent merge.

Safety/privacy checks:
No raw email/phone/browser uid/ATS id/Sendblue handle/LinkedIn in document ids.
Do not create a parallel candidate root. Do not let employer email override PDF
email. Do not silently merge conflicts.

Stop conditions:
Stop if changes require files outside scope, destructive migration, raw PII ids,
or product policy beyond deterministic conflict review.

Expected artifacts:
Updated core marketplace contracts and tests; new persistence identity helper
and tests; updated exports/package test script.

Questions for lead:
Answered in `PLAN.md`: use dedicated identity event/conflict collections plus
audit summaries; random candidate ids; proceed from restored S2 docs.

## Executor B - Functions Integration

AGENT_PLAN
Executor:
B - Functions Integration

Objective:
Add functions-side identity claim integration: authenticated callable claim API,
public CV canonical-candidate resolution before permanent profile writes, ATS
email-hint conflict behavior, and tests proving no live outbound in conflict
or test paths.

Files to read:
README.md; CLAUDE.md; AGENTS.md; S2 docs; `apps/functions/src/index.ts`;
`apps/functions/src/public-cv-ingest.ts`;
`apps/functions/src/cv-ingest/cv-ingest.ts`;
`apps/functions/src/cv-ingest/__tests__/cv-ingest.test.ts`;
`apps/functions/src/ats-inbound-handler.ts`;
`apps/functions/src/ats-inbound-handler.test.ts`;
`apps/functions/src/sendblue/webhook.ts`;
`apps/functions/src/sendblue/triggers/prescreen.ts`;
read-only `apps/functions/src/ats-inbound-webhook.ts` if needed for wiring.

Exclusive write scope:
`apps/functions/src/identity/*`; `apps/functions/src/index.ts`;
`apps/functions/src/public-cv-ingest.ts`;
`apps/functions/src/cv-ingest/cv-ingest.ts`;
`apps/functions/src/cv-ingest/__tests__/*`;
`apps/functions/src/ats-inbound-handler.ts`;
`apps/functions/src/ats-inbound-handler.test.ts`;
`apps/functions/package.json` if needed.

Shared files needed:
Read-only contracts from Executor A. Lead may later expand shared scope if
`ats-inbound-webhook.ts` must pass new args to `handleAtsInbound`.

Dependencies on other executors:
Depends on A identity helpers. C consumes callable response. D consumes final
collection/read paths.

Proposed steps:
Add an identity callable handler that trusts Firebase Auth email and treats
browser uid as evidence. Refactor public CV ingest so parsed CV email/phone can
resolve canonical candidate before `parsedCandidateResumes`, tags, mem0, or
follow-up writes. Update ATS to return `identity_conflict` on email mismatch
and skip outbound. Preserve first-interview behavior.

Tests/evals to add or run:
Identity callable tests, public CV tests for canonical user id before writes,
ATS tests for matching email, conflict email, no phone, and dedupe. Tests must
inject Sendblue, LLM, mem0, and PDF fetch dependencies.

Safety/privacy checks:
No raw PII ids or logs. Conflict stops permanent writes/outbound. No live
Sendblue/OpenAI/Qdrant/Firebase network in tests.

Stop conditions:
Stop if implementation requires destructive merge, live outbound, or product
policy beyond deterministic review.

Expected artifacts:
New identity function files, callable export, updated CV ingest and ATS paths,
focused tests, and no-live-outbound evidence.

Questions for lead:
Answered in `PLAN.md`: callable requires Firebase Auth; identity index uses S2
collection constants; conflict outcome is `identity_conflict`; shared webhook
wiring can be lead-expanded only if needed.

## Executor C - Candidate Site Claim UI

AGENT_PLAN
Executor:
C - Candidate Site Claim UI

Objective:
Add candidate-domain-only claim UI for `/login`, `/me`, and `/me/profile` in
`apps/pa-landing`. Keep profile display read-only and candidate-scoped. Do not
create admin or employer surfaces.

Files to read:
README.md; CLAUDE.md; AGENTS.md; S2 docs; S1 summary;
`apps/pa-landing/src/lib/firebase.ts`; `apps/pa-landing/src/main.tsx`;
`apps/pa-landing/src/pages/Landing.tsx`;
`apps/pa-landing/src/pages/PublicJob.tsx`;
`apps/pa-landing/package.json`; dashboard `Login.tsx` as reference only.

Exclusive write scope:
`apps/pa-landing/src/lib/firebase.ts`; `apps/pa-landing/src/main.tsx`;
`apps/pa-landing/src/pages/Login.tsx`;
`apps/pa-landing/src/pages/Me.tsx`;
`apps/pa-landing/src/pages/Profile.tsx`;
`apps/pa-landing/src/pages/PublicJob.tsx` only for non-blocking links;
`apps/pa-landing/package.json` if needed.

Shared files needed:
Callable response shape from B and redacted self-profile contract from A.

Dependencies on other executors:
Depends on B claim callable and D rules/read contract.

Proposed steps:
Export Firebase Auth/functions from landing app. Add email-link `/login`.
Add signed-in `/me` and `/me/profile` reading the claim callable/redacted
self-profile. Add only non-blocking links from public job page. Preserve
existing upload/iMessage flow.

Tests/evals to add or run:
`pnpm --filter @pa/landing typecheck`; `pnpm --filter @pa/landing build`;
browser smoke for `/login`, signed-out `/me`, signed-out `/me/profile`, and
public job page.

Safety/privacy checks:
Candidate domain only. No raw PII route/doc ids. No edit controls. No employer
or admin data. Do not block first interview.

Stop conditions:
Stop if no claim mapping/callable contract exists, if Firestore rules cannot
support candidate self-read safely, or if UI drifts into mutation/browsing.

Expected artifacts:
Landing auth helpers, login/me/profile pages, route updates, optional public job
links, build/typecheck/browser smoke evidence.

Questions for lead:
Answered in `PLAN.md`: use callable/auth mapping plus redacted self-profile;
candidate-visible fields are limited; signed-out `/me` uses `/login` as the
primary action.

## Executor D - Admin, Rules, Acceptance

AGENT_PLAN
Executor:
D - Admin, Rules, Acceptance

Objective:
Make S2 identity/claim state visible to operators, lock public/candidate reads
to auth mapping and redacted profile data, prove public denial, and record
acceptance evidence without employer browsing or live outbound.

Files to read:
README.md; CLAUDE.md; AGENTS.md; S2 docs;
`apps/dashboard-web/src/pages/CandidateMarketplace.tsx`;
`apps/dashboard-web/src/pages/CandidateMarketplace.helpers.ts`;
`apps/dashboard-web/src/pages/__tests__/CandidateMarketplace.test.ts`;
`apps/dashboard-web/src/App.tsx`;
`config/firebase/firestore.rules`;
`config/firebase/firestore.indexes.json`;
`firebase.json`; S1 docs.

Exclusive write scope:
`apps/dashboard-web/src/pages/CandidateMarketplace.*`;
`apps/dashboard-web/src/pages/IdentityConflicts.tsx`;
`apps/dashboard-web/src/pages/__tests__/*Identity*` or marketplace tests;
`apps/dashboard-web/src/App.tsx`;
`config/firebase/firestore.rules`;
`config/firebase/firestore.indexes.json`;
S2 `ACCEPTANCE.md`, `SUMMARY.md`, and `artifacts/*`.

Shared files needed:
Read-only collection constants from A and read/callable contracts from B/C.

Dependencies on other executors:
Depends on A collection names and B/C read paths.

Proposed steps:
Extend marketplace inspector with identity section. Add admin-only
`/admin/identity-conflicts`. Update helper tests. Add Firestore rules for
operator reads, server-owned writes, candidate auth mapping reads, candidate
redacted self-profile reads, and public-deny identity collections. Add necessary
indexes only for implemented queries. Record acceptance evidence.

Tests/evals to add or run:
Dashboard tests/build, index JSON parse, Firebase rules validation/dry-run,
public-deny REST probes, candidate/auth scoped read probes when available,
regression curls.

Safety/privacy checks:
No public PII. Candidate self-read is mapping-based, not URL-id-based. No raw
conflicts/audit/operator data exposed to candidate. No employer browsing.

Stop conditions:
Stop if rules cannot distinguish mapped candidate self-read, validation fails,
or UI becomes broad candidate browsing.

Expected artifacts:
Admin identity UI/rules/index changes, public-deny and candidate self-read
artifact logs, completed acceptance and summary.

Questions for lead:
Answered in `PLAN.md`: auth mapping is Firebase uid keyed; candidate-readable
state is redacted self-profile only; identity conflicts get a standalone
operator route.
