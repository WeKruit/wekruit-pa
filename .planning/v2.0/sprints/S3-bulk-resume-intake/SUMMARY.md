# S3 Summary

**Status:** Landed, deployed, and live-smoke verified.
**Date:** 2026-05-13.

## Outcome

S3 bulk resume intake is implemented across shared contracts, persistence,
Cloud Functions, dashboard UI, Firestore rules, and acceptance evidence.
Bulk upload batch docs and nested item docs are operator-read/server-write
collections:

- `pa-bulk-upload-batches/{batchId}`
- `pa-bulk-upload-batches/{batchId}/items/{itemId}`

Candidate/private C-end access was not added. Dashboard mutations go through
the four admin callables; Cloud Functions write with Admin SDK and bypass
Firestore rules.

Implemented callable surface:

- `paBulkResumeCreateBatch`
- `paBulkResumeAddItems`
- `paBulkResumeProcessBatch`
- `paBulkResumeRetryItem`

Implemented admin route:

- `/admin/bulk-resumes`

## Verification Status

Local verification passed:

- `pnpm --filter @pa/core-types test`
- `pnpm --filter @pa/core-types typecheck`
- `pnpm --filter @pa/pa-persistence test`
- `pnpm --filter @pa/pa-persistence typecheck`
- `node --import tsx --test apps/functions/src/bulk-resume-intake.test.ts`
- `node --import tsx --test apps/functions/src/cv-ingest/__tests__/cv-ingest.test.ts`
- `pnpm --filter @pa/functions typecheck`
- `pnpm --filter @pa/functions test` (`1183/1183`)
- `node --import tsx --test apps/dashboard-web/src/pages/__tests__/BulkResumes.test.ts`
- `pnpm --filter @pa/dashboard-web test`
- `pnpm --filter @pa/dashboard-web typecheck`
- `pnpm --filter @pa/dashboard-web build`
- `npx firebase-tools deploy --only firestore:rules,firestore:indexes --project wekruit-5f89b --non-interactive --dry-run`
- `git diff --check`

Deployment and live smokes passed:

- Firebase deploy completed for `pa-dashboard`, Firestore rules/indexes, the
  four S3 callables, and `paPublicCvIngest`.
- `paBulkResumeCreateBatch` live callable smoke returned 200 for a temporary
  operator token.
- `paBulkResumeProcessBatch` processed the temporary empty batch with
  `processed=0`.
- Firestore deployed rules allowed operator read and denied operator client
  write, unauthenticated read, non-operator read, and mapped-candidate read.
- Public CV ingest empty-body regression returned HTTP 400
  `missing_userId_or_tempUserId`.
- `https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer`
  returned HTTP 200.
- `https://wekruit-pa.web.app/j/hs-11005382-invoko-product-designer`
  returned HTTP 301 to the candidate domain.
- `https://wekruit-pa.web.app/admin/bulk-resumes` returned HTTP 200.
- `pa-outbound` count stayed 190 before/after the deployed empty-batch smoke.

Temporary smoke batch docs, candidate-auth mapping docs, and temporary Firebase
Auth smoke users were cleaned up.

## Files Changed

- `config/firebase/firestore.rules`
- `apps/functions/src/bulk-resume-intake.ts`
- `apps/functions/src/bulk-resume-intake.test.ts`
- `apps/functions/src/cv-ingest/cv-ingest.ts`
- `apps/functions/src/cv-ingest/__tests__/cv-ingest.test.ts`
- `apps/functions/src/index.ts`
- `apps/functions/package.json`
- `apps/dashboard-web/src/App.tsx`
- `apps/dashboard-web/src/pages/BulkResumes.tsx`
- `apps/dashboard-web/src/pages/BulkResumes.helpers.ts`
- `apps/dashboard-web/src/pages/__tests__/BulkResumes.test.ts`
- `packages/core-types/src/collections.ts`
- `packages/core-types/src/marketplace.ts`
- `packages/core-types/src/marketplace.test.ts`
- `packages/core-types/src/index.ts`
- `packages/pa-persistence/src/bulk-resume-intake.ts`
- `packages/pa-persistence/src/bulk-resume-intake.test.ts`
- `packages/pa-persistence/src/index.ts`
- `packages/pa-persistence/package.json`
- `.planning/v2.0/sprints/S3-bulk-resume-intake/ACCEPTANCE.md`
- `.planning/v2.0/sprints/S3-bulk-resume-intake/SUMMARY.md`
- `.planning/v2.0/sprints/S3-bulk-resume-intake/artifacts/worker-d-rules-indexes-evidence.md`

`config/firebase/firestore.indexes.json` was reviewed and intentionally left
unchanged. The expected S3 query shapes are single-field orderings on a top-level
batch collection and per-batch item subcollections, so no composite index is
required at this lane.

## Product Decisions

- S3 is an admin/operator supply-ingestion path, not employer candidate
  browsing.
- Batch docs are containers and review state. Global candidate profiles remain
  rooted at `pa-users/{candidateId}`.
- PDF-extracted email remains primary. Employer email is only a hint.
- Missing email is a review state, not an invented identity.
- No live outbound in S3.

## Known Gaps

- Browser UI was not clicked with a human Google session; route availability,
  callable auth, and Firestore rules were verified through deployed HTTP,
  callable, and REST smokes.

## Next Sprint Trigger

S3 landed on `main` as
`8484a36 feat(v2): add bulk resume intake (#26)`. S4 has already landed after
S3.
