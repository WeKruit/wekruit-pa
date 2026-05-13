# S3 Plan - Bulk Resume Intake

## 1. Purpose / Big Picture

Build the employer/operator bulk resume intake path that turns many PDFs into
global candidate supply.

This sprint must not create an employer ATS product or a parallel candidate
store. The batch is only the ingestion container. The durable output is the
same global candidate profile and resume artifact model created in S1/S2.

## 2. Observable User Outcome

An operator can open `/admin/bulk-resumes`, create a batch, attach PDFs with
optional employer email hints, start processing, and see per-item status.

For each item:

- clean PDF email creates or merges a global candidate profile;
- missing PDF email becomes a review item instead of inventing identity;
- employer email mismatch becomes a review/conflict item;
- parse failure leaves no partial candidate profile and is retryable;
- successful item shows canonical `candidateId`, `resumeArtifactId`, and
  parsed resume reference.

Claimed candidates later see uploaded resume state on `/me` through the
redacted self-profile path.

## 3. Current Repo Orientation

S3 starts from `origin/main` after S2 merge:

- Branch: `codex/v2-S3-bulk-resume-intake`
- Base commit: `0a8b794 feat(v2): add candidate identity claim layer (#25)`
- S2 identity deploy is already live.

Relevant existing modules:

- `@pa/core-types`: collection constants and marketplace schemas.
- `@pa/pa-persistence`: identity helpers and marketplace transition helpers.
- `apps/functions/src/cv-ingest/cv-ingest.ts`: CV parse, identity resolution,
  resume artifact, tag merge, and self-profile update path.
- `apps/functions/src/public-cv-ingest.ts`: public wrapper around `ingestCv`.
- `apps/dashboard-web`: admin-only React dashboard with callable helpers and
  route/nav patterns.

## 4. Locked Invariants And Non-Goals

Invariants:

- Candidate profile is the durable asset; a batch is not a candidate root.
- `pa-users/{candidateId}` remains the canonical global profile.
- PDF-extracted email drives identity.
- Employer email is a hint, never an override.
- No raw PII in document ids.
- Raw candidate data remains operator/server-owned.
- Candidate self-view uses redacted self profile only.
- Match score does not block first interview.
- NOT_PASS remains in the global marketplace pool.
- No live outbound during S3.

Non-goals:

- No employer candidate browsing.
- No scheduling, notes, or message-on-behalf-of.
- No destructive merge UI.
- No broad storage redesign.
- No new Firebase Hosting site.
- No candidate route on the admin domain.

## 5. Data Model And Ownership

Add collection constants:

- `pa-bulk-upload-batches`
- `pa-bulk-upload-batches/{batchId}/items/{itemId}`

Batch owner:

- Admin/operator only.
- Tracks batch label, source, optional job context, createdBy, status, counts,
  and timestamps.

Item owner:

- Admin/operator only.
- Tracks file name, file hash, optional employer email hint, parse/identity
  status, candidate id, resume artifact id, parsed resume id, conflict id,
  retry count, error reason, and timestamps.

PII policy:

- Raw emails may be accepted by callable inputs and used server-side for
  identity resolution.
- Raw PII must not be used in document ids.
- Admin-only item docs may store operational fields needed for review, but list
  UI should prefer masked email and hash fields where exact value is not needed.

Status model:

- Batch: `draft`, `queued`, `processing`, `completed`, `completed_with_errors`,
  `failed`, `cancelled`.
- Item: `queued`, `parsing`, `parsed`, `missing_email_review`,
  `identity_conflict`, `parse_failed`, `failed`, `retry_ready`.

Idempotency:

- Item id can be deterministic from batch id plus file hash or UI-generated
  uuid, but profile writes must be idempotent by file hash plus extracted email
  when available.
- Retry must reuse the same batch item and not create duplicate candidates for
  the same extracted email.

## 6. UI Surface Map

Admin:

- Add `/admin/bulk-resumes`.
- Add nav entry near ATS Inbound / Identity Conflicts.
- Page shows:
  - create batch panel;
  - PDF upload list with optional email hint per file;
  - process button;
  - batch status summary;
  - item table with status, file name, extracted email, candidate id, resume
    artifact id, conflict id, error, and retry action.

Candidate:

- `/me` and `/me/profile` should already show `latestResumeArtifactId`.
- S3 should only adjust candidate self profile if needed so bulk-created resume
  artifacts appear there.

## 7. Backend / API / Service Map

Core contracts:

- Add bulk batch/item schemas and collection constants.
- Add helper id builders if needed.

Persistence/service:

- Add a bulk resume intake service that:
  - creates batch docs;
  - creates item docs from uploaded PDFs;
  - processes one item through `ingestCv` or shared parse helper;
  - maps `ingestCv` outcomes to item statuses;
  - writes correction/flywheel events for reviewable parse states.

Functions:

- Add admin callable(s), likely:
  - `paBulkResumeCreateBatch`
  - `paBulkResumeAddItems`
  - `paBulkResumeProcessBatch`
  - `paBulkResumeRetryItem`
- Use existing admin callable auth pattern.
- Reuse `ingestCv` rather than duplicating parser or identity logic.
- Bind the same parser/LLM secrets used by `paPublicCvIngest`.

Dashboard:

- Use callable Functions for mutation.
- Read batch/items from Firestore for live status.
- Keep all writes server-owned except file payload call inputs.

Firestore rules:

- Bulk batch and item docs are operator-read only and server-write only.
- Candidates cannot read batch docs.
- Employers cannot read batch docs.

## 8. Executor Topology And Disjoint Write Scopes

Executor A - Bulk Contracts And Persistence:

- Write scope:
  - `packages/core-types/src/collections.ts`
  - `packages/core-types/src/marketplace.ts`
  - `packages/core-types/src/index.ts`
  - `packages/core-types/src/*.test.ts`
  - `packages/pa-persistence/src/bulk-resume-intake.ts`
  - `packages/pa-persistence/src/bulk-resume-intake.test.ts`
  - `packages/pa-persistence/src/index.ts`
  - `packages/pa-persistence/package.json`
- Owns schemas, status transitions, item status mapping, idempotency helpers,
  and persistence tests.

Executor B - Functions Bulk Intake API:

- Write scope:
  - `apps/functions/src/bulk-resume-intake/*`
  - `apps/functions/src/index.ts`
  - `apps/functions/package.json` if test script needs expansion
  - focused tests under `apps/functions/src/bulk-resume-intake/*.test.ts`
  - read-only consumption of `apps/functions/src/cv-ingest/cv-ingest.ts`
    unless a small lead-approved interface extraction is required.
- Owns admin callables, secret binding, parser reuse, identity conflict mapping,
  and service tests.

Executor C - Admin Bulk Resume UI:

- Write scope:
  - `apps/dashboard-web/src/App.tsx`
  - `apps/dashboard-web/src/pages/BulkResumes.tsx`
  - `apps/dashboard-web/src/pages/__tests__/BulkResumes.test.ts`
  - optional helper under `apps/dashboard-web/src/pages/BulkResumes.helpers.ts`
- Owns `/admin/bulk-resumes` route, nav, upload table, retry controls, and UI
  tests.

Executor D - Rules, Simulation, Acceptance:

- Write scope:
  - `config/firebase/firestore.rules`
  - `config/firebase/firestore.indexes.json`
  - `.planning/v2.0/sprints/S3-bulk-resume-intake/*`
  - `apps/functions/src/bulk-resume-intake/__tests__/fixtures/*` if fixtures
    are needed and agreed with Executor B.
- Owns rules, 3-PDF simulation fixture plan, acceptance ledger, and deploy
  notes.

Shared-file owner:

- Lead owns `pnpm-lock.yaml` if package metadata changes require it.
- Lead arbitrates any needed edits to `cv-ingest.ts`.

## 9. Agent Plan Handshake

Before implementation, each executor must return `AGENT_PLAN` only. No executor
may implement until the lead appends all plans to `EXECUTOR-PLANS.md` and
writes the integration note below.

## 10. Milestones

1. Contracts and persistence plan accepted.
2. Admin callable contract accepted.
3. Dashboard route contract accepted.
4. Rules and simulation plan accepted.
5. Integrated execution note written.
6. Implementation waves begin.

## 11. Concrete Steps

Planned wave order:

1. Add core schemas and pure status/id helpers with tests.
2. Add persistence/service batch helpers with tests.
3. Add admin callable wrappers and tests using injected parse/identity deps.
4. Add dashboard `/admin/bulk-resumes`.
5. Add Firestore rules/indexes.
6. Add 3-item simulation covering clean, missing email, conflicting email.
7. Run package tests, build/typecheck, deploy changed functions/hosting/rules.
8. Live smoke admin route and non-mutating API guard. Do not send outbound.

## 12. Verification Harness

Required local checks:

- `pnpm --filter @pa/core-types test`
- `pnpm --filter @pa/core-types typecheck`
- `pnpm --filter @pa/pa-persistence test`
- `pnpm --filter @pa/pa-persistence typecheck`
- focused functions bulk tests
- `pnpm --filter @pa/functions typecheck`
- `pnpm --filter @pa/functions test`
- `pnpm --filter @pa/dashboard-web typecheck`
- dashboard tests covering `BulkResumes`
- `pnpm --filter @pa/dashboard-web build`
- existing public CV ingest validation remains green
- `git diff --check`

Required S3 simulation:

- clean PDF/email path creates or merges candidate and parsed item;
- missing email path becomes review state with no invented email;
- employer/PDF email mismatch creates identity conflict/review;
- parse failure leaves no partial `pa-users` write.

Production checks after deploy:

- `/admin/bulk-resumes` returns dashboard shell and renders in browser smoke.
- Admin callable unauthenticated call rejects.
- Public CV ingest empty-body validation remains unchanged.
- Candidate domain `/j/:jobId` remains HTTP 200.
- Admin `/j/:jobId` redirect remains HTTP 301 to candidate domain.

## 13. HITL And Flywheel Events

S3 review states:

- missing email review;
- conflicting email review;
- low-confidence parse review;
- parse failed retry.

Flywheel event targets:

- correction event for operator-resolved extracted email;
- correction event for parse field correction;
- feedback event for parse success/failure aggregate.

S3 should create the event paths even if the full HITL editor is still minimal.

## 14. Safety And Privacy Checks

- No live outbound.
- No employer-visible non-passed candidate browsing.
- No raw PII in doc ids.
- Batch docs stay operator-only.
- Candidate self profile remains redacted.
- Missing email does not create fake email handle.
- Employer email mismatch does not silently merge.
- Parse failure does not write partial candidate rows.
- Retry does not duplicate candidates or resume artifacts.

## 15. Idempotence And Recovery

- Batch create is idempotent by batch id.
- Item add is idempotent by batch id plus file hash.
- Processing one item can be retried.
- `parsed` item is terminal unless an explicit retry/reset action is added.
- Failed parse can retry from the same file payload or stored pointer.
- Identity conflict stays reviewable and does not auto-merge.

## 16. Progress

- [x] S3 worktree created from updated `origin/main`.
- [x] Context read from roadmap, harness, AGENTS/CLAUDE, S2 summary, and code.
- [x] Draft S3 plan written.
- [ ] Executor AGENT_PLAN outputs collected.
- [ ] Integration note written.
- [ ] Implementation started.
- [ ] Local verification passed.
- [ ] Production deploy and smoke completed.

## 17. Decision Log

- S3 is admin/operator intake, not employer browsing.
- Reuse S2 identity and existing `ingestCv`; do not build a parallel parser.
- Server-owned callables own mutation; dashboard reads status and submits files.
- Bulk item review states are explicit product states, not generic failures.

## 18. Surprises And Discoveries

- None yet.

## 19. Outcomes And Retrospective

Pending implementation.

## Integrated Execution Note

Executor plans are integrated.

1. File write scopes are disjoint enough to proceed:
   - A owns core contracts and persistence helpers.
   - B owns functions bulk callables and tests.
   - C owns dashboard route/UI/helper/tests.
   - D owns rules/indexes and acceptance docs.
   - Lead owns any `cv-ingest.ts` seam and `pnpm-lock.yaml` if either becomes
     necessary.
2. Shared files are sequenced:
   - A lands collection constants, schemas, statuses, and persistence helpers
     first.
   - B consumes A helpers and exports final callable contracts.
   - C consumes A statuses and B callable names.
   - D adds rules/indexes after A paths and C query shapes are known.
3. Data contracts are consistent:
   - Batch collection is `pa-bulk-upload-batches`.
   - Item subcollection is `items`.
   - Candidate output remains global `pa-users/{candidateId}` plus
     `pa-resume-artifacts`, not a new candidate root.
   - Final callable names are `paBulkResumeCreateBatch`,
     `paBulkResumeAddItems`, `paBulkResumeProcessBatch`, and
     `paBulkResumeRetryItem`.
4. Backend primitives have UI/operator visibility:
   - Every batch and item state appears in `/admin/bulk-resumes`.
   - Review states are first-class: `missing_email_review` and
     `identity_conflict`.
5. LLM behavior has trace coverage:
   - Parser/LLM outcomes are mapped to item statuses.
   - The required simulation covers clean, missing email, conflict email, and
     parse failure.
6. HITL/flywheel behavior:
   - Missing email remains a bulk review state in S3, not an identity conflict.
   - Employer/PDF mismatch uses S2 identity conflict.
   - Parse/email corrections should write correction events when the minimal
     review action exists; otherwise S3 records review status and leaves the
     editor to a later HITL sprint.
7. Product-invariant checks:
   - No plan creates employer browsing.
   - No plan moves candidate routes to admin.
   - No plan sends live outbound.
   - No plan stores raw PII in document ids.
8. Lead decisions:
   - Firebase Storage is the correct place for PDF bytes. Firestore must not
     store base64 PDFs.
   - Employer email hints can be persisted in operator-only item docs for retry.
   - Table emails are masked by default; no reveal affordance in S3.
   - Executor C imports core types after A lands instead of maintaining local
     string unions.
   - Rules gate is deploy compile plus live denial smoke; emulator tests are
     optional only if cheap.
   - A small `cv-ingest.ts` seam is approved only if B cannot otherwise prove
     missing-PDF-email stops before permanent candidate writes.
9. Execution wave order:
   - Wave A: A implements contracts/persistence. Lead inspects `cv-ingest` side
     effects and owns any required seam.
   - Wave B: B implements callables/processors against A helpers.
   - Wave C: C implements dashboard route against A/B contracts.
   - Wave D: D implements rules/indexes and acceptance harness.
   - Wave E: lead runs integration tests, deploys, live-smokes, commits, PRs,
     and advances only from updated `main`.
