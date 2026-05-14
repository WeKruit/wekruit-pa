# S9 Executor Plans - Production Hardening + Scale

## Executor A

AGENT_PLAN
Executor: A
Objective: Define S9 core contracts and persistence helpers for privacy request intake, launch readiness redacted snapshots, and outreach stop controls without implementing destructive delete/export fulfillment.
Files to read: `.planning/v2.0/sprints/S9-production-hardening-scale/{CONTEXT,PLAN,ACCEPTANCE,EXECUTOR-PLANS}.md`; `packages/core-types/src/{marketplace,marketplace.test,collections,index}.ts`; `packages/pa-persistence/src/{marketplace,marketplace.test,index,outreach-capacity,identity}.ts`.
Exclusive write scope: `packages/core-types/src/marketplace.ts`; `packages/core-types/src/marketplace.test.ts`; `packages/core-types/src/collections.ts`; `packages/core-types/src/index.ts`; `packages/pa-persistence/src/marketplace.ts`; `packages/pa-persistence/src/marketplace.test.ts`; `packages/pa-persistence/src/index.ts`.
Shared files needed: `packages/core-types/src/index.ts` for exports; A owns S9 contract exports.
Dependencies on other executors: B consumes schemas/writers for callables and stop gates; C consumes readiness snapshot shape; D consumes candidate privacy request contract; E consumes redaction/id helpers.
Proposed steps: Add collection constants; add `PrivacyRequest`, `LaunchReadinessSnapshot`, and `OutreachStopControl` schemas/types/helpers; add raw PII rejection refinements; add persistence helpers for privacy request intake, readiness snapshot write, audited stop-control update, and stop-control read; export everything.
Tests/evals to add or run: Core schema/id/redaction tests; persistence idempotency/conflict/audit tests; `pnpm --filter @pa/core-types test`; `pnpm --filter @pa/core-types typecheck`; `pnpm --filter @pa/pa-persistence test`; `pnpm --filter @pa/pa-persistence typecheck`; `git diff --check`.
Safety/privacy checks: No destructive delete/export; no raw PII in ids, evidence, snapshots, audit payloads, or tests; request/intake/preview metadata only; stop controls are deterministic and auditable.
Stop conditions: Destructive privacy semantics; concurrent index edits; raw PII requirements; stop-control scope requiring product expansion; persistence helper requiring writes outside A scope.
Expected artifacts: Exported S9 contracts/helpers and persistence helpers with focused tests.
Questions for lead: Duplicate open privacy request dedupe? Which stop scopes? Should export remain request-only?

Lead answers:

- Duplicate privacy requests dedupe while open by `candidateId + kind`; resolved/rejected requests do not block a future new request.
- Minimum stop scopes are `global` and `outreach_batch`; gate checks global first and optional batch when a batch id exists.
- `export` and `delete` are request-only in S9. No export materialization or destructive deletion.

## Executor B

AGENT_PLAN
Executor: B
Objective: Implement S9 backend functions and stop gates: candidate privacy request callable, admin launch readiness snapshot callable, admin outreach stop-control callable, and fail-closed outreach gates before S6 outreach enqueue and marketplace Sendblue delivery, with redacted readiness output and no destructive privacy action.
Files to read: S9 docs; `apps/functions/src/index.ts`; `apps/functions/src/promote-sandbox-tag.ts`; `apps/functions/src/identity/candidate-matches-api.ts`; `apps/functions/src/flywheel-candidate-correction.ts`; `apps/functions/src/flywheel-eval.ts`; `apps/functions/src/outreach/{service,policy,admin}.ts`; `apps/functions/src/sendblue/{outbox,outbox-retry-sweep,pool}.ts`; A-owned contracts.
Exclusive write scope: `apps/functions/src/*launch*`; `apps/functions/src/*privacy*`; `apps/functions/src/outreach/**` stop-control gate changes/tests; `apps/functions/src/sendblue/**` stop-control delivery gate changes/tests; `apps/functions/src/index.ts`; focused functions tests.
Shared files needed: A contracts/persistence helpers; `apps/functions/src/index.ts` owned by B for exports; callable shapes for C/D/E.
Dependencies on other executors: A contracts first; C/D/E consume final callable names and response fields.
Proposed steps: Add `paCandidatePrivacyRequest`; add `paAdminLaunchReadinessSnapshot`; add `paAdminOutreachStopControl`; wire outreach planning stop check before reservation/enqueue; wire Sendblue outbox stop check for marketplace outreach rows before append/typing/quota/send; reuse retry path; export callables.
Tests/evals to add or run: Privacy callable auth/request/no-mutation tests; readiness auth/count/redaction tests; outreach service stop tests; Sendblue outbox stop tests; admin stop-control tests; focused node tests; `npm --workspace=@pa/functions run typecheck`; full `npm --workspace=@pa/functions test`.
Safety/privacy checks: No live outbound; no destructive privacy fulfillment; fail closed before marketplace enqueue/send; readiness redacted; candidate id derived from auth mapping; admin gates; no route/domain scope changes.
Stop conditions: A contracts unavailable; stop gate requires edits outside B scope and lead does not assign them; test would send live message; privacy expands into fulfillment.
Expected artifacts: `paCandidatePrivacyRequest`; `paAdminLaunchReadinessSnapshot`; `paAdminOutreachStopControl`; focused tests; exports; evidence paused/read-error creates no outbound enqueue/send.
Questions for lead: Canonical switch vs old remote config? Gate every Sendblue row or only marketplace outreach? Missing config fail closed?

Lead answers:

- S9 stop control is the canonical marketplace outreach switch. Do not migrate older remote config in this sprint.
- Delivery gate applies to marketplace outreach rows identified by `outreach_idempotency_` idempotency keys. It must not block unrelated transactional interview/account messages.
- Missing or malformed stop-control config fails open for launch safety after schema defaulting to unpaused. Explicit paused state fails closed. Read errors fail closed.

## Executor C

AGENT_PLAN
Executor: C
Objective: Add a read-only admin launch readiness dashboard that summarizes production launch health, privacy request queue, eval/flywheel status, failed parse/match/outbound counts, and stop-control state without exposing raw PII or broad candidate browsing.
Files to read: S9 docs; `apps/dashboard-web/src/App.tsx`; `apps/dashboard-web/src/pages/FlywheelEval.tsx`; `apps/dashboard-web/src/lib/flywheel-eval-api.ts`; `apps/dashboard-web/src/pages/OutreachOps.tsx`; `apps/dashboard-web/src/pages/Operations.tsx`; `apps/dashboard-web/src/pages/SendbluePool.tsx`; dashboard UI components.
Exclusive write scope: `apps/dashboard-web/src/pages/LaunchReadiness.tsx`; `apps/dashboard-web/src/pages/__tests__/LaunchReadiness.test.ts`; `apps/dashboard-web/src/lib/launch-readiness-api.ts`; minimal `apps/dashboard-web/src/App.tsx` route/nav wiring.
Shared files needed: `apps/dashboard-web/src/App.tsx`; C owns admin route/nav edits. Consumes B callable names and snapshot shape.
Dependencies on other executors: A/B provide `paAdminLaunchReadinessSnapshot` and `paAdminOutreachStopControl`; E scans C files for PII/route safety.
Proposed steps: Build callable wrapper with normalized empty snapshot; add `/admin/launch-readiness` under Monitor or Platform; render compact status bands and source links; show privacy request queue as redacted rows; show stop-control state and refresh action; add tests for loading/error/empty/redaction/links.
Tests/evals to add or run: `pnpm --filter @pa/dashboard-web test -- LaunchReadiness`; `pnpm --filter @pa/dashboard-web typecheck`; `pnpm --filter @pa/dashboard-web build`.
Safety/privacy checks: No raw contact fields; no links to non-passed candidate browsing; no candidate route in admin app; no write controls that can destructively delete data.
Stop conditions: Snapshot requires raw PII; admin UI needs destructive privacy fulfillment; route conflicts with existing pages.
Expected artifacts: Admin page, API wrapper, route/nav entry, focused tests.
Questions for lead: None; use B snapshot as source of truth.

## Executor D

AGENT_PLAN
Executor: D
Objective: Add candidate-facing privacy/export/delete/stop request controls to the existing candidate profile/account surface, wired to the candidate privacy request callable and limited to auditable request creation.
Files to read: S9 docs; `apps/pa-landing/src/pages/CandidatePortal.tsx`; `apps/pa-landing/src/lib/candidate-profile-correction.ts`; `apps/pa-landing/src/lib/candidate-profile-correction.test.ts`; `apps/pa-landing/src/App.tsx`; candidate auth/firebase wrappers.
Exclusive write scope: `apps/pa-landing/src/lib/candidate-privacy-request.ts`; `apps/pa-landing/src/lib/candidate-privacy-request.test.ts`; `apps/pa-landing/src/pages/CandidatePortal.tsx`; focused landing tests.
Shared files needed: None beyond D scope. Consumes B callable name/result shape.
Dependencies on other executors: A/B provide request kind enum and callable result; E scans D files for destructive/delete-send safety.
Proposed steps: Add client wrapper for `paCandidatePrivacyRequest`; add a compact privacy controls panel on `/me/profile`; use open-ended detail text plus action buttons for export/delete/stop outreach; submit request only; show submitted/in-review state; do not mutate profile or hide data locally except success message.
Tests/evals to add or run: `apps/functions/node_modules/.bin/tsx --test apps/pa-landing/src/lib/candidate-privacy-request.test.ts`; `pnpm --filter @pa/landing build`; focused component tests only if existing landing test harness supports it.
Safety/privacy checks: No destructive delete/export; no live outbound; no raw PII echoed into artifacts; candidate route stays on landing app.
Stop conditions: Product asks for actual deletion/export fulfillment; callable allows client-supplied candidate id; UI requires legal text expansion outside S9 scope.
Expected artifacts: Candidate privacy request wrapper, `/me/profile` privacy panel, focused wrapper tests.
Questions for lead: None; export/delete/stop are request-only.

## Executor E

AGENT_PLAN
Executor: E
Objective: Build S9 dry-run/static safety harness and scenario artifacts proving launch-readiness paths do not send live outbound, do not perform destructive privacy actions, do not leak raw PII, and preserve candidate/admin route split.
Files to read: S9 docs; S8 eval harness under `tests/eval/s8-flywheel-hitl-eval`; S5/S6/S7/S8 eval suites; B/C/D touched files once available.
Exclusive write scope: `tests/eval/s9-production-hardening-scale/**`; `tests/scenarios/s9-production-hardening-scale/**`; `.planning/v2.0/sprints/S9-production-hardening-scale/artifacts/**`.
Shared files needed: None. Consumes A/B/C/D paths for scans and fixtures.
Dependencies on other executors: A/B define pure functions and contracts; C/D define UI files to scan; lead supplies final touched-file list.
Proposed steps: Add package test script; add fixtures for privacy request, stop-control blocked outreach, readiness snapshot, route smoke manifest; add static guards forbidding Sendblue/Instantly/LinkedIn sends, destructive delete calls, raw PII fields in S9 artifacts, candidate routes in admin app, admin routes in candidate app; add dry-run integration tests for stop gate and readiness snapshot if pure helpers are exported.
Tests/evals to add or run: `pnpm --dir tests/eval/s9-production-hardening-scale test`; S5/S6/S7/S8 eval subset; `git diff --check`.
Safety/privacy checks: No network sends; no production deletion; no contactable outbound rows in fixtures; no raw email/phone/LinkedIn/resume/transcript/prompt fields in artifacts.
Stop conditions: No exported pure helpers to test; static guard needs to scan generated bundles; scenario requires live send or destructive delete.
Expected artifacts: S9 eval package, scenario YAMLs, static guard report, no-contact count JSON after live smoke.
Questions for lead: None; harness defaults to dry-run/count-only.
