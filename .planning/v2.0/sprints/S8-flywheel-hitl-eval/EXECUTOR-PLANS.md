# S8 Executor Plans

Executor plans are collected before implementation. Executors must return
`AGENT_PLAN` only and must not edit files during this phase.

## Executor A

AGENT_PLAN
Executor: A - Event Contracts + Persistence
Objective: Add S8 eval artifact, correction, and feedback contracts plus
append-only persistence writers.
Files to read: README.md, AGENTS.md, CLAUDE.md, S8 sprint docs,
`packages/core-types/src/{marketplace.ts,collections.ts,index.ts,marketplace.test.ts}`,
`packages/pa-persistence/src/{marketplace.ts,index.ts,marketplace.test.ts}`.
Exclusive write scope: `packages/core-types/src/**`,
`packages/pa-persistence/src/**`.
Shared files needed: `packages/core-types/src/index.ts` exports only.
Dependencies on other executors: B/C/D/E consume contracts and writers; A does
not edit functions/dashboard/landing/eval files.
Proposed steps: Add `PA_COLLECTIONS.evalArtifacts =
"pa-eval-artifacts"`; add `EvalArtifact` schemas, statuses, run result,
deterministic id helper, source-link requirement, and privacy rejection; extend
`CorrectionEvent.actor` to include `candidate`; add `CorrectionEvent`
`targetType="outbound_copy"` and `FeedbackEvent kind="candidate_behavior"`;
export contracts; add `writeEvalArtifact` and a composed
correction-to-artifact writer in persistence.
Tests/evals to add or run: core-types schema/id/privacy tests;
pa-persistence append-only/idempotency/conflict/audit tests;
`pnpm --filter @pa/core-types test`; `pnpm --filter @pa/core-types
typecheck`; `pnpm --filter @pa/pa-persistence test`;
`pnpm --filter @pa/pa-persistence typecheck`.
Safety/privacy checks: no raw email, phone, LinkedIn URL, resume storage URI,
Firebase/GCS locator, raw prompt, or raw transcript in eval artifacts; no broad
employer visibility; deterministic append-only writes.
Stop conditions: eval artifact collection rejected; required changes leave
owned packages; privacy checks break existing event producers; live outbound or
destructive migration required.
Expected artifacts: core contracts, persistence writers, focused package tests.
Questions for lead: confirm top-level `pa-eval-artifacts`; confirm
`candidate` actor only; confirm A provides composed correction-to-artifact
writer.

Lead answers: confirmed. Use a top-level `pa-eval-artifacts` collection.
Extend `CorrectionEvent.actor` to `operator | system | candidate`, not full
`MarketplaceActorSchema`. A provides the composed writer; B chooses concrete
call sites.

## Executor B

AGENT_PLAN
Executor: B - Functions/Services
Objective: Add functions/services for S8 event producers, correction-to-eval
artifact generation, admin snapshot callable, and no-contact dry-run
marketplace simulation.
Files to read: README/AGENTS/CLAUDE, S8 sprint docs,
`apps/functions/src/{job-enrichment.ts,prescreen-outcome-service.ts,admin-passed-candidates.ts,index.ts}`,
external-supply webhook/outreach files, A contracts, S5/S6/S7 evals.
Exclusive write scope: `apps/functions/src/*flywheel*.ts`,
`apps/functions/src/*eval*.ts`, matching focused tests, `apps/functions/src/index.ts`
exports only.
Shared files needed: A contracts/writers, C snapshot contract, D candidate
self-correction requirements.
Dependencies on other executors: A must land contracts first; C consumes
snapshot shape; E consumes pure simulation functions; D consumes candidate
correction callable.
Proposed steps: Add `flywheel-events.ts` pure feedback builders; add
candidate-job-state trigger for terminal-state feedback; add
`flywheel-eval-artifacts.ts` materializer; add correction-event onCreate
artifact generation; add dry-run `flywheel-simulation.ts`; add admin callable
`paAdminFlywheelEvalSnapshot`; export selected functions.
Tests/evals to add or run: focused builder/materializer/snapshot/simulation
tests; functions typecheck/test; S7 eval regression; S8 eval with E.
Safety/privacy checks: redacted callable output/artifacts only; no
Sendblue/Instantly/LinkedIn sends; no `pa-outbound` writes in simulation;
append-only deterministic writes; employer surface passed-only.
Stop conditions: A contract missing; required integration leaves B scope;
simulation would contact live services or enqueue outbound; redaction cannot be
proved.
Expected artifacts: flywheel service files, focused tests, export additions.
Questions for lead: automatic trigger vs admin callable artifact generation;
candidate-job-state trigger allowed; final artifact collection/schema name.

Lead answers: use automatic correction-event trigger for artifact generation.
Use a candidate-job-state trigger for prescreen feedback to avoid editing S7
terminal services. Target A's `pa-eval-artifacts` / `EvalArtifact` contract.
Candidate correction backend belongs to B as `flywheel-candidate-correction.ts`;
D wires UI only.

## Executor C

AGENT_PLAN
Executor: C - Admin Flywheel/Eval UI
Objective: Add a read-only admin `/admin/flywheel-eval` surface that connects
corrections, feedback, eval artifacts, and marketplace simulation status.
Files to read: README/AGENTS/CLAUDE, S8 sprint docs, `apps/dashboard-web/src/App.tsx`,
`QaEvaluator`, `CandidateMarketplace`, `OutreachOps`, `PassedCandidates`,
external-supply audit, and related tests.
Exclusive write scope: `apps/dashboard-web/src/pages/FlywheelEval.tsx`,
`FlywheelEval.helpers.ts`, `__tests__/FlywheelEval.test.ts`, and minimal
`App.tsx` route/nav wiring.
Shared files needed: B redacted callable contract.
Dependencies on other executors: A artifact schema, B snapshot shape, D
candidate self-correction row, E status fields.
Proposed steps: Add `/admin/flywheel-eval`; add Eval nav item; implement
read-only sections for health summary, surface coverage, artifacts,
marketplace simulation steps, and recent redacted events; link to source
admin workflows.
Tests/evals to add or run: focused dashboard test, dashboard test/typecheck/build.
Safety/privacy checks: admin-only route, read-only, no raw JSON dump, no raw
PII/storage/provider payload/prompt/transcript, no mutation controls.
Stop conditions: B snapshot missing or unsafe; route/nav conflict; lead chooses
different route.
Expected artifacts: FlywheelEval page/helpers/tests and App wiring.
Questions for lead: confirm route/nav/callable/self-correction row/type imports.

Lead answers: confirmed `/admin/flywheel-eval`, Eval nav item, callable
`paAdminFlywheelEvalSnapshot`, and local dashboard mirror types in
`FlywheelEval.helpers.ts` matching B's redacted contract.

## Executor D

AGENT_PLAN
Executor: D - Candidate Self-Correction
Objective: Add open-ended `/me/profile` self-correction UX that uses existing
profile/tag pipelines and writes shared S8 correction events.
Files to read: README/AGENTS/CLAUDE, S8 sprint docs, candidate portal/login/matches
files, landing Firebase helpers, identity/candidate API files, CV confirmation
reply, tag merge/write utilities, A/B contracts.
Exclusive write scope: `apps/pa-landing/src/pages/CandidatePortal.tsx`,
`apps/pa-landing/src/lib/candidate-profile-correction.ts`, and focused landing
tests if needed.
Shared files needed: A correction contract, B `paCandidateSubmitProfileCorrection`
callable/export, E privacy expectations.
Dependencies on other executors: A adds `candidate` actor; B owns backend
callable and export; E owns safety eval/static guard.
Proposed steps: Add open-ended correction panel inside `/me/profile`; submit
`{ correctionText, sourceSurface: "me_profile" }`; show pending/success/error;
refresh returned redacted profile projection; do not touch matching/outbound/admin.
Tests/evals to add or run: landing typecheck/build and focused UI/client tests;
B-owned callable tests for auth, ownership, tag update, correction event
redaction; S7 domain regression if routing-sensitive code changes.
Safety/privacy checks: candidate domain only; no admin-domain candidate route;
no live outreach; no raw PII/raw correction text in artifacts; tag updates use
existing pipeline; no unrelated overwrite.
Stop conditions: contract cannot represent candidate correction; backend scope
unclear; new intake/admin route required; raw text would be stored; tag updates
bypass existing pipeline.
Expected artifacts: candidate UI/client wrapper and focused tests.
Questions for lead: backend owner; always write correction events; correction
scope; actor extension; returned self-profile projection.

Lead answers: B owns backend. Candidate-authored correction always writes a
CorrectionEvent with redacted evidence, even when no structured mutation is
safe; artifact generation can mark it `needs_review`. First S8 scope is tags
and preferences plus profile summary-style facts already represented in the
redacted self-profile projection; no raw LinkedIn/email/phone edits in this
cut. Return the same redacted self-profile shape currently used by `/me/profile`
plus applied keys.

## Executor E

AGENT_PLAN
Executor: E - Eval/Scenario/Safety Harness
Objective: Add S8 eval, scenario, and static safety harnesses proving
corrections/outcomes become redacted flywheel data, dry-run marketplace
simulation reaches passed profile, and S5/S6/S7 locks stay intact.
Files to read: README/AGENTS/CLAUDE, S8 sprint docs, S5/S6/S7 evals,
`tests/scenarios/runner-prescreen.mjs`, S7 scenarios, V19 route/domain guide.
Exclusive write scope: `tests/eval/s8-flywheel-hitl-eval/**`,
`tests/scenarios/s8-flywheel-hitl-eval/**`, S8 artifacts.
Shared files needed: A contracts/writers; B pure functions; C/D scan roots.
Dependencies on other executors: A artifact contract; B dry-run simulation;
C/D route/component paths.
Proposed steps: Add S8 node:test package and fixtures; test correction ->
artifact idempotence/redaction; full dry-run marketplace sim; optional
candidate self-correction eval; static guard for live send, broad employer
browsing, domain split, raw PII, transcripts, storage locators, prompts, and
automated LinkedIn send; add declarative scenario YAMLs.
Tests/evals to add or run: S8 eval/static guard, S5/S6/S7 eval regressions,
scenario fixture validation.
Safety/privacy checks: no `pa-outbound` writes in dry-run simulation; no live
provider calls/imports; no raw PII/transcripts/prompts; admin/employer passed
only; candidate domain split; first interview and NOT_PASS locks.
Stop conditions: A/B contracts unavailable or unsafe; live network/costed eval
required; raw artifact data; broad employer browsing.
Expected artifacts: S8 eval package, fixtures, tests, static guard, scenario
YAMLs, redacted run summaries.
Questions for lead: artifact collection; B function names; candidate
self-correction inclusion; guard scan roots.

Lead answers: S8 uses `pa-eval-artifacts`; test B functions
`runFlywheelMarketplaceSimulation`, `materializeEvalArtifactForCorrection`,
and `buildFlywheelFeedbackEvent` names unless implementation discovers an
existing better local convention. Candidate self-correction is in scope. Static
guard scan roots are A/B/C/D touched files plus S8 eval/scenario files.
