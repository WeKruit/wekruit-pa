# S3 Executor Plans

Executor plans use the `AGENT_PLAN` format from
`.planning/AUTONOMOUS-SPRINT-HARNESS.md`.

## Executor A - Bulk Contracts And Persistence

AGENT_PLAN
Executor:
Executor A - Bulk Contracts And Persistence

Objective:
Define the S3 bulk resume intake data contracts and persistence primitives that let admin/operator bulk uploads create or merge global `pa-users/{candidateId}` profiles through the existing identity/resume model, with deterministic item status, idempotent retry behavior, no raw PII in document ids, and no partial candidate writes on missing email, identity conflict, or parse failure.

Files to read:
README.md; AGENTS.md; CLAUDE.md; .planning/AUTONOMOUS-SPRINT-HARNESS.md; .planning/MILESTONE-v2.0-candidate-retention-marketplace.md; .planning/v2.0/sprints/S3-bulk-resume-intake/CONTEXT.md; .planning/v2.0/sprints/S3-bulk-resume-intake/PLAN.md; packages/core-types/src/collections.ts; packages/core-types/src/marketplace.ts; packages/core-types/src/index.ts; packages/core-types/src/marketplace.test.ts; packages/pa-persistence/src/identity.ts; packages/pa-persistence/src/marketplace.ts; packages/pa-persistence/src/index.ts; packages/pa-persistence/src/marketplace.test.ts; packages/pa-persistence/src/identity.test.ts; packages/pa-persistence/package.json.

Exclusive write scope:
packages/core-types/src/collections.ts; packages/core-types/src/marketplace.ts; packages/core-types/src/index.ts; packages/core-types/src/*.test.ts; packages/pa-persistence/src/bulk-resume-intake.ts; packages/pa-persistence/src/bulk-resume-intake.test.ts; packages/pa-persistence/src/index.ts; packages/pa-persistence/package.json.

Shared files needed:
apps/functions/src/cv-ingest/cv-ingest.ts read-only for Executor B integration. apps/functions/src/public-cv-ingest.ts read-only to preserve single public CV ingest behavior. config/firebase/firestore.rules read-only, owned by Executor D. apps/dashboard-web/src/pages/BulkResumes.tsx read-only future consumer, owned by Executor C. pnpm-lock.yaml is lead-owned if package metadata unexpectedly requires lockfile churn.

Dependencies on other executors:
Executor B consumes A-owned schemas/helpers and must not invent callable-local status strings. Executor B provides file hash, file name, optional employer email hint, parser/identity outcome, `candidateId`, parsed resume id, and conflict id to A-owned helpers. Executor B or lead may need a small approved `cv-ingest.ts` seam. Executor C renders only exported statuses and prefers masked/hash email fields. Executor D enforces operator-only read/server-only write rules.

Proposed steps:
Add collection constants. Add core schemas/types for batch and item statuses/docs. Add deterministic id and legal-transition helpers. Extend `marketplace.test.ts`. Add `packages/pa-persistence/src/bulk-resume-intake.ts` with Firestore helpers for create/upsert/mark parsing/review/conflict/failure/retry/parsed and batch count recomputation. Parsed success writes or reuses `pa-resume-artifacts` with source `employer_bulk`, links parsed resume id, updates item, and updates candidate latest-resume projection. Export contracts/helpers and add persistence test script coverage.

Tests/evals to add or run:
Core tests for status schemas, deterministic ids, idempotency key, terminal parsed behavior, and retry transition. Persistence tests for batch creation, duplicate file item, conflicting item update, parsed success artifact write/idempotency, missing email no `pa-users` write, identity conflict no merge, parse failure no artifact, retry idempotency. Run core tests/typecheck, persistence tests/typecheck, and `git diff --check`.

Safety/privacy checks:
No raw PII in doc ids. Email values in item docs include hash/masked fields; any raw hint remains operator/server-owned. Missing extracted PDF email becomes `missing_email_review` and creates no candidate, email handle, resume artifact, or self-profile. Employer email mismatch becomes `identity_conflict`. Parse failure leaves no partial profile or artifact. Retry reuses same batch item and idempotency key. No outbound, employer browsing, candidate routes, scheduling/notes/message-on-behalf-of.

Stop conditions:
Stop if implementation requires files outside scope; if `ingestCv` cannot expose parsed email before writes and lead does not approve seam; if existing identity would create candidate from employer hint on missing PDF email and bulk cannot bypass it; if another executor edits the same files; if lockfile/core test script needs lead expansion.

Expected artifacts:
Core bulk collection constants, schemas, types, pure reducers/helpers; persistence bulk helper module; tests; updated exports and pa-persistence test script.

Questions for lead:
1. For retry, persist raw employer email hints in operator-only item docs or require retry resubmission? 2. Approve small pre-write parse/identity seam from `cv-ingest.ts` if needed? 3. Should missing PDF email create identity conflict or only bulk review state?

Lead answers:
Persist employer email hints in operator-only item docs for retry. A small `cv-ingest.ts` seam is approved only if needed and must be lead-owned or explicitly assigned. Missing PDF email remains a bulk item review state in S3, not an identity conflict.

## Executor B - Functions Bulk Intake API

AGENT_PLAN
Executor:
B - Functions Bulk Intake API

Objective:
Add admin-only Cloud Functions callables for S3 bulk resume intake that create batches, upload PDF payloads safely, process/retry items through the existing `ingestCv` pipeline, and map outcomes to durable bulk item states without creating a parallel candidate store or sending outbound messages.

Files to read:
README.md; AGENTS.md; CLAUDE.md; .planning/AUTONOMOUS-SPRINT-HARNESS.md; .planning/v2.0/sprints/S3-bulk-resume-intake/CONTEXT.md; .planning/v2.0/sprints/S3-bulk-resume-intake/PLAN.md; apps/functions/src/public-cv-ingest.ts; apps/functions/src/cv-ingest/cv-ingest.ts; apps/functions/src/identity/claim-api.ts; apps/functions/src/index.ts; apps/functions/package.json; packages/pa-persistence/src/identity.ts; packages/pa-persistence/src/index.ts; packages/core-types/src/collections.ts; packages/core-types/src/marketplace.ts; apps/functions/src/promote-sandbox-tag.ts; apps/functions/src/lib/embeddings.ts; apps/functions/src/cv-ingest/cv-confirm-message.ts.

Exclusive write scope:
apps/functions/src/bulk-resume-intake/*; apps/functions/src/index.ts; apps/functions/package.json only if bulk tests are not covered by existing script; apps/functions/src/bulk-resume-intake/*.test.ts.

Shared files needed:
A-owned core collection/schema contracts and persistence helpers. Read-only `apps/functions/src/cv-ingest/cv-ingest.ts` for `ingestCv`. Dashboard consumes callable DTOs. D-owned rules protect collections. Lead owns any required `cv-ingest.ts` seam.

Dependencies on other executors:
Executor A must land or confirm bulk persistence API. Executor C needs callable names and payloads: `paBulkResumeCreateBatch`, `paBulkResumeAddItems`, `paBulkResumeProcessBatch`, `paBulkResumeRetryItem`. Executor D adds rules/indexes. Lead arbitrates status names.

Proposed steps:
Add admin auth helper; validators for create/add/process/retry; store PDF bytes in default Firebase Storage bucket under deterministic bulk path; implement pure handlers with injected deps; process one item by reading Storage and calling `ingestCv` with injected bytes, `skipLimitEnforcement: true`, and outbound/candidate-facing seams suppressed; prevent missing PDF email from creating candidate; map mismatch to `identity_conflict`; mark clean success; export four callables and bind secrets.

Tests/evals to add or run:
Focused tests for admin auth, validators, PDF/file limits, Storage write via injection, clean parsed path, missing email review, identity conflict, parse/LLM/download failure, retry idempotency, and outbound/confirm suppression. Run focused bulk tests, functions typecheck, full functions tests, and `git diff --check`.

Safety/privacy checks:
No live outbound, no candidate-facing messages, no synthetic inbound triggers, no raw PII in ids/storage/logs/responses, no base64 in Firestore, no candidate from employer hint when PDF email is missing, no silent mismatch merge, admin/server-owned mutation only.

Stop conditions:
Stop if A helpers are unavailable/incompatible; if implementation would store PDF bytes/base64 in Firestore; if `ingestCv` seams cannot suppress side effects; if missing-email handling requires unapproved `cv-ingest.ts` edit; if auth conflicts; if focused tests show partial writes; if unrelated dirty changes appear.

Expected artifacts:
`auth.ts`, `validation.ts`, `storage.ts`, `api.ts`, `processor.ts`, focused tests, `index.ts` exports, optional package test glob update.

Questions for lead:
Confirm default Firebase Storage bucket is acceptable.

Lead answer:
Default Firebase Storage bucket is acceptable and required for retryable batch processing. Do not store PDF/base64 payloads in Firestore.

## Executor C - Admin Bulk Resume UI

AGENT_PLAN
Executor:
Executor C - Admin Bulk Resume UI

Objective:
Add the admin-only `/admin/bulk-resumes` dashboard surface for S3 bulk resume intake: operators can create/select a batch, attach PDF resumes with optional employer email hints, start processing through admin callables, observe batch/item status from Firestore, and retry parse failures without client-side candidate/profile writes.

Files to read:
README.md; AGENTS.md; CLAUDE.md; .planning/AUTONOMOUS-SPRINT-HARNESS.md; S3 context/plan/acceptance; apps/dashboard-web/src/App.tsx; apps/dashboard-web/src/lib/firebase.ts; apps/dashboard-web/src/components/ui.tsx; CandidateMarketplace/IdentityConflicts/test examples; dashboard package metadata; after A/B land, bulk contracts and callable payloads.

Exclusive write scope:
apps/dashboard-web/src/App.tsx; apps/dashboard-web/src/pages/BulkResumes.tsx; apps/dashboard-web/src/pages/BulkResumes.helpers.ts; apps/dashboard-web/src/pages/__tests__/BulkResumes.test.ts.

Shared files needed:
Read-only core types after A, read-only functions callable contracts after B, read-only rules/indexes after D. No shared writes requested.

Dependencies on other executors:
A provides collection names/status vocabulary. B provides callable contracts. D allows admin reads/query indexes. Lead writes integration note first.

Proposed steps:
Use existing dashboard UI patterns. Add pure helpers for status labels, retryability, counts, sorting, email masking, PDF validation, payload shaping, and file-to-base64 conversion. Add compact admin workflow page: create batch, select latest batches, PDF list with optional hints, process button, summary, item table, retry controls. Read Firestore for latest batches/items. Mutations use B callables only. Link to candidate profile/conflicts when IDs exist. Wire route/nav.

Tests/evals to add or run:
`BulkResumes.test.ts` using node:test for helpers; dashboard test/typecheck/build; `git diff --check`; post-backend browser smoke for `/admin/bulk-resumes`.

Safety/privacy checks:
No outbound, no candidate route on admin domain, no employer browser, no raw PII in URLs/localStorage/generated IDs/logs/table-first display, mask emails by default, missing email and conflict statuses shown explicitly, retry only retryable states.

Stop conditions:
Stop if B requires upload token/Storage flow beyond C scope; A status contract unstable; D blocks reads; implementation requires files outside scope; behavior implies employer browsing, candidate-domain changes, raw PII ids, destructive mutation, or outbound.

Expected artifacts:
Bulk page, helpers, tests, route/nav entry, dashboard verification results.

Questions for lead:
Import core types or local string unions? Base64 callable or Storage-backed upload token? Always mask emails or reveal affordance?

Lead answers:
Import exported core types after A lands. Use direct base64 payload to B callable for S3; B stores bytes in Storage server-side. Always mask emails in the table for S3; no reveal affordance unless a later explicit review editor requires it.

## Executor D - Rules, Simulation, Acceptance

AGENT_PLAN
Executor:
D - Rules, Simulation, Acceptance

Objective:
Lock S3 bulk resume intake security, indexes, simulation evidence, and acceptance reporting so bulk uploads become operator-owned ingestion containers that write only to global candidate profiles through server code.

Files to read:
README.md; AGENTS.md; CLAUDE.md; harness; S3 docs; S2 acceptance; Firestore rules/indexes; CV ingest and ATS tests. After other executors land interfaces, read bulk contracts, service tests, functions, and dashboard page read-only.

Exclusive write scope:
config/firebase/firestore.rules; config/firebase/firestore.indexes.json; .planning/v2.0/sprints/S3-bulk-resume-intake/*; apps/functions/src/bulk-resume-intake/__tests__/fixtures/* only if Executor B confirms fixture format and ownership.

Shared files needed:
A final collection names/status/query fields; B callable/service names and simulation command; C query patterns; lead sequencing approval.

Dependencies on other executors:
Rules wait for A/B final paths and server-write model. Indexes wait for C query shapes. Fixtures wait for B. Acceptance updates after actual command outputs.

Proposed steps:
Add operator-read/server-write rules; add narrow composite indexes only if real UI/service queries require them; build 3-PDF simulation acceptance plan; coordinate synthetic fixtures if needed; update acceptance and summary with actual evidence.

Tests/evals to add or run:
Focused simulation for clean merge/create, missing-email review, identity conflict, parse failed no partial write, retry idempotency, and admin auth. Run core/persistence/functions/dashboard checks, Firebase rules/index deploy compile, route/curl regressions.

Safety/privacy checks:
No raw PII ids/fixture names; batch/item docs operator-read only and server-write only; no candidate/employer reads; no invented identity; no silent mismatch; parse failure no partial writes; no outbound.

Stop conditions:
Stop if collection names/status fields are not finalized, if B needs direct client writes, if C requires unjustified broad indexes, if fixtures contain real PII, if simulation mutates prod unintentionally or sends outbound, or at first acceptance divergence.

Expected artifacts:
Updated rules/indexes if required, acceptance evidence, summary, artifacts notes/fixtures/curl outputs/screenshots.

Questions for lead:
Use emulator/rules-unit tests or deploy compile plus live denial smoke?

Lead answer:
Required gate is rules compile/deploy plus live denial smoke. Add emulator tests only if the repo already supports them cheaply; do not let emulator setup expand S3 scope.
