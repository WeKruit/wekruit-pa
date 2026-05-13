# S4 Executor Plans

Status: AGENT_PLAN handshakes collected and integrated.

## Lead Integration Decisions

- S4 draft/review state lives in `pa-jobs/{jobId}/enrichment/{draftId}`.
  It must not live directly on `pa-jobs/{jobId}` because public-visible jobs
  are whole-document readable.
- Eval fixtures live in `pa-jobs/{jobId}/enrichment-eval-fixtures/{fixtureId}`
  with a summary embedded in the draft.
- Approved public-safe output can be promoted to selected `pa-jobs/{jobId}`
  fields only through server code.
- `approvalReady` is machine-readiness; `approved` is explicit operator
  approval.
- Scoring rubric is first-class draft metadata.
- Claire brief remains separate from public page copy in S4.
- Generated prescreen config must parse through existing prescreen config
  schema and remains draft until approval.

## Executor A - Contracts and Persistence

AGENT_PLAN

Executor: A - Contracts and persistence

Objective: Define S4 contracts and persistence for raw job to enriched demand
draft, without changing candidate/admin routes or matching behavior. Output
must be explicit, versioned, reviewable, and safe for S5 only after approval.

Exclusive write scope:

- `packages/core-types/src/marketplace.ts`
- `packages/core-types/src/collections.ts`
- `packages/core-types/src/index.ts`
- `packages/core-types/src/marketplace.test.ts`
- `packages/pa-persistence/src/marketplace.ts`
- `packages/pa-persistence/src/marketplace.test.ts`
- `packages/pa-persistence/src/index.ts`

Integrated steps:

1. Add schemas for raw job snapshot, enriched tags, hard filters, soft scoring,
   prescreen draft, scoring rubric, candidate brief, coverage, HITL flags,
   `JobOpportunityDraft`, `JobOpportunity`, and job enrichment eval fixtures.
2. Model sponsorship as `true | false | null`; silence stays `null`.
3. Keep role function and industry sector as separate shared-tag axes.
4. Store seniority evidence/confidence and route title-only evidence to review.
5. Add draft/review statuses: `draft`, `needs_review`, `approved`, `rejected`.
6. Add persistence helpers for write draft, approve draft, reject draft, and
   write eval fixture.
7. Use append-only correction events for operator edits.

Lead resolutions:

- Drafts use `pa-jobs/{jobId}/enrichment/{draftId}` rather than root
  `pa-jobs` fields.
- Eval fixtures use job-local subcollection.
- Approval may promote public-safe fields to root job only through server code.

Required tests:

- Schema parses strong, weak, ambiguous, visa mismatch, location mismatch, and
  salary mismatch fixtures.
- Sponsorship silence is `null`, not `false`.
- Orthogonal role/industry arrays.
- Title-only seniority triggers low coverage/review.
- Draft writes are idempotent; conflicting duplicate draft fails; approval
  promotes only allowed fields; rejected draft cannot promote.

## Executor B - Enrichment Service/API

AGENT_PLAN

Executor: B - Job enrichment service/API

Objective: Expand existing tag-only enrichment into S4 demand draft generation:
canonical tags, hard filters, soft signals, draft prescreen questions, scoring
rubric, Claire brief, eval fixture seed, confidence/version, and HITL metadata.

Exclusive write scope:

- `packages/pa-job-tag-enricher/src/*`
- `apps/functions/src/enrich-job-tags-http.ts`
- `apps/functions/src/auto-enrich-matching-jobs.ts`
- focused functions tests for enrichment behavior

Integrated steps:

1. Keep `enrichJobTags()` as the canonical primitive.
2. Add pure `enrichJobOpportunity()` / derivation helpers that wrap tag output,
   sponsorship inference result, coverage, drafts, and HITL flags.
3. Preserve auth/no-CORS behavior on existing HTTP wrapper.
4. Update trigger to stamp versioned draft metadata without outbound or
   approval.
5. Add deterministic cases for strong, weak, ambiguous, visa/location/salary
   mismatch, title-only, sponsorship-silent, and conflicting constraints.

Lead resolutions:

- Trigger/callables write draft subcollection docs, not public root internals.
- Missing sponsorship text stays reviewable/null.
- Draft output may become `approvalReady`, but not `approved`.

Required tests:

- Job-opportunity schema/service tests.
- Sponsorship silence/null.
- Conflicting constraints and title-only seniority produce HITL flags.
- HTTP response shape and trigger version/content-hash gating.

## Executor C - Dashboard Review UI

AGENT_PLAN

Executor: C - Dashboard review UI

Objective: Build admin-only job enrichment review panel where an operator can
inspect/correct/approve one enriched job draft.

Exclusive write scope:

- `apps/dashboard-web/src/pages/JobEnrichmentReview.tsx`
- page-local helper/test file if needed

Shared file:

- `apps/dashboard-web/src/App.tsx` for one route/nav edit, owned by lead or C
  when implementation starts.

Integrated UI shape:

- `/admin/job-enrichment`
- Dense list/detail operator layout.
- Sections: job identity, confidence/HITL flags, tags, hard filters, soft
  signals, generated questions, scoring rubric, Claire brief, eval fixture
  summary.
- Actions only through backend callables: refresh, approve, save corrections,
  reject/block.
- Render sponsorship unknown explicitly; never display unknown as false.

Required checks:

- Dashboard typecheck/build.
- Focused UI test if practical under existing harness.
- Browser/local route smoke.

## Executor D - Prescreen Draft, Rubric, Brief, Eval Fixtures

AGENT_PLAN

Executor: D - Prescreen draft, scoring rubric, Claire brief, eval fixtures

Objective: Define and verify draft outputs that convert enriched job tags into
runtime-compatible prescreen config draft, scoring rubric, Claire brief, and
job-intake eval fixtures without changing prescreen runtime state machine.

Exclusive write scope:

- `packages/pa-job-tag-enricher/src/job-opportunity.ts`
- `packages/pa-job-tag-enricher/src/job-opportunity.test.ts`
- `packages/pa-job-tag-enricher/src/__fixtures__/job-opportunity/*`
- `packages/pa-job-tag-enricher/src/index.ts` export only if needed

Integrated steps:

1. Add pure derivation module from raw job + `EnrichedJobTags` to draft outputs.
2. Map generated questions into existing prescreen config schema.
3. Keep scoring rubric metadata separate from runtime scoring replacement.
4. Draft requires review if role, skills, seniority, location, salary, or
   sponsorship coverage is weak/ambiguous.
5. Candidate-facing Claire brief must avoid internal scores and employer-only
   rationale.
6. Eval fixtures cover strong, weak, ambiguous, visa mismatch, location
   mismatch, salary mismatch, sponsorship-silent sparse JD, and role/industry
   orthogonality.

Lead resolutions:

- Scoring rubric is first-class field on draft.
- Claire brief does not automatically become public page copy.
- Confidence threshold starts conservatively: `overall >= 0.82` and all
  critical coverage flags pass before `approvalReady`.

## Executor E - Rules, Indexes, HITL, Acceptance

AGENT_PLAN

Executor: E - Rules, indexes, HITL, acceptance

Objective: Ensure S4 enrichment data remains admin-only where appropriate,
corrections become flywheel events, indexes match actual dashboard/API queries,
and the sprint has a deploy/live-smoke acceptance ledger.

Files to read:

- `config/firebase/firestore.rules`
- `config/firebase/firestore.indexes.json`
- `packages/core-types/src/marketplace.ts`
- `packages/pa-persistence/src/marketplace.ts`
- `.planning/v2.0/sprints/S3-bulk-resume-intake/ACCEPTANCE.md`
- S4 files produced by Executors A-D

Exclusive write scope:

- S4 acceptance docs under `.planning/v2.0/sprints/S4-job-enrichment/`
- Firestore rules/index updates if S4 adds new collections or composite query
  shapes
- Focused tests for rules-adjacent helpers if new helper code is added

Shared files needed:

- `config/firebase/firestore.rules`
- `config/firebase/firestore.indexes.json`
- `packages/core-types/src/marketplace.ts`

Dependencies on other executors:

- A must define final collection names and review/correction schemas.
- B/C must state dashboard/API query shapes.
- D must define eval fixture storage and HITL states.

Proposed steps:

1. Review final S4 collections and query shapes.
2. Keep admin-only reads/writes unless a public route has an explicit product
   reason.
3. Prefer existing `pa-correction-events` for append-only edits unless A adds a
   more specific schema for job enrichment corrections.
4. Add indexes only for real equality-plus-order or collection-group queries.
5. Build acceptance ledger from local tests, deploy dry-run, live route
   regressions, and deployed callable/rules smokes.

Tests/evals to add or run:

- `npx firebase-tools deploy --only firestore:rules,firestore:indexes --project wekruit-5f89b --non-interactive --dry-run`
- package tests touched by A-D
- dashboard tests/typecheck/build
- functions tests/typecheck
- candidate route, admin redirect, public CV validation, and admin route curls

Safety/privacy checks:

- No candidate read access to admin-only enrichment review queues.
- No employer browsing of non-passed candidates.
- No live outbound in S4.
- No raw PII as doc ids or public fields.
- No destructive backfill without dry-run/apply split.

Stop conditions:

- Any new public job field exposes internal HITL notes or unpublished draft
  prescreen content.
- Any query requires a composite index that is not documented and deployed.
- Any live smoke shows candidate/admin domain drift.

Expected artifacts:

- Completed `ACCEPTANCE.md`
- Rules/index evidence notes if changed
- Live-smoke command outputs summarized in `SUMMARY.md`

Questions for lead:

- None yet.
