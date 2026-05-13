# S3 Acceptance

This file records S3 verification.

## Worker D Scope: Firestore Rules and Indexes

Current state: deployed and live-smoke verified. S3 adds
explicit operator-read/server-write rules for:

- `pa-bulk-upload-batches/{batchId}`
- `pa-bulk-upload-batches/{batchId}/items/{itemId}`

Operators are defined by the existing `isPaOperator()` rule helper:
`@wekruit.com` Google accounts or the existing allowlisted address. Candidates,
non-operators, and unauthenticated users receive no access to bulk-upload batch
or item documents. Cloud Functions use the Admin SDK and bypass Firestore rules,
so client writes are denied and no server-write exception is required.

No composite index was added. The expected S3 dashboard reads are:

- top-level `pa-bulk-upload-batches` ordered by `updatedAt` or `createdAt`
- per-batch `items` subcollection ordered by `createdAt` or `updatedAt`

Those are single-collection, single-field ordering shapes covered by Firestore
single-field indexes. If another lane adds equality filters plus ordering or
collection-group queries, that new query shape must be rechecked before adding
a composite index.

## Required Checks

| Check | Command or action | Expected result | Actual result | Status |
|---|---|---|---|---|
| Branch | `git branch --show-current` | `codex/v2-S3-bulk-resume-intake` | `codex/v2-S3-bulk-resume-intake` | PASS |
| Base | `git rev-parse origin/main HEAD` and merge-base | branch starts from S2-merged main `0a8b794` | `origin/main`, `HEAD`, and merge-base all `0a8b7946247dc7ccc7cb751c35663975f5e8f760` | PASS |
| Core bulk contracts | `pnpm --filter @pa/core-types test` | bulk batch/item schemas and existing marketplace contracts pass | 12/12 tests passed | PASS |
| Core typecheck | `pnpm --filter @pa/core-types typecheck` | shared contracts compile | passed | PASS |
| Persistence bulk tests | `pnpm --filter @pa/pa-persistence test` | batch/item idempotency and status mapping pass | 107/107 tests passed | PASS |
| Persistence typecheck | `pnpm --filter @pa/pa-persistence typecheck` | persistence compiles | passed | PASS |
| Functions bulk tests | `node --import tsx --test apps/functions/src/bulk-resume-intake.test.ts` | clean/missing/conflict/parse-failure paths pass without live network | 7/7 tests passed | PASS |
| CV ingest seam tests | `node --import tsx --test apps/functions/src/cv-ingest/__tests__/cv-ingest.test.ts` | bulk missing-email guard and identity conflict metadata remain correct | 54/54 tests passed | PASS |
| Functions full tests | `pnpm --filter @pa/functions test` | existing functions remain green | 1183/1183 tests passed | PASS |
| Functions typecheck | `pnpm --filter @pa/functions typecheck` | functions compile | passed | PASS |
| Dashboard tests | `pnpm --filter @pa/dashboard-web test` | `/admin/bulk-resumes` statuses, masking, retry buckets pass | 32/32 tests passed | PASS |
| Dashboard typecheck | `pnpm --filter @pa/dashboard-web typecheck` | dashboard compiles | passed | PASS |
| Dashboard build | `pnpm --filter @pa/dashboard-web build` | admin bundle builds | passed; Vite emitted existing chunk-size warning only | PASS |
| Simulation: clean PDF | focused service test | clean extracted email creates or merges global candidate and parsed resume | `bulk-resume-intake.test.ts` successful parse case wrote `employer_bulk` artifact and candidate pointer | PASS |
| Simulation: missing email | focused service + cv-ingest tests | missing extracted email becomes review state; no fake email | item status `missing_email_review`; no candidate/artifact/identity conflict writes | PASS |
| Simulation: conflict email | focused service + cv-ingest tests | employer/PDF email mismatch creates identity conflict/review state | item status `identity_conflict`; conflict id persisted; no resume artifact write | PASS |
| Simulation: parse failure | focused service test | parse failure writes no partial profile | item status `parse_failed`; retry requeues as `retry_ready`; no artifact write | PASS |
| Firestore rules compile/deploy | Firebase deploy dry-run | rules validate and deploy with S3 bulk paths present | `npx firebase-tools deploy --only firestore:rules,firestore:indexes --project wekruit-5f89b --non-interactive --dry-run` compiled rules successfully; dry run complete | PASS |
| Firebase deploy | `PA_DASHBOARD_VITE_ENV_FILE=/Users/adam/Desktop/WeKruit/wekruit-pa/apps/dashboard-web/.env.production.local pnpm exec firebase deploy --only hosting:pa-dashboard,firestore:rules,firestore:indexes,functions:pa-orchestrator:paBulkResumeCreateBatch,functions:pa-orchestrator:paBulkResumeAddItems,functions:pa-orchestrator:paBulkResumeProcessBatch,functions:pa-orchestrator:paBulkResumeRetryItem,functions:pa-orchestrator:paPublicCvIngest --project wekruit-5f89b --non-interactive` | deploy dashboard, rules/indexes, S3 callables, and public CV ingest | exited 0; Gen2 S3 callables listed ACTIVE with 2026-05-13T19:09Z update times; deploy emitted create-race 409 warnings for newly-created callables but final function state is ACTIVE | PASS |
| Firestore admin allowed live read smoke | temporary Firebase Auth token with `codex-smoke@wekruit.com`; callable-created batch; Firestore REST read | operator can read batch docs and item docs; writes go through callables only | callable create 200; empty process 200 processed=0; operator Firestore read 200 | PASS |
| Firestore client write denied live smoke | same operator token attempts Firestore REST PATCH on batch doc | client write denied even for operator; server writes only through Admin SDK callables | Firestore PATCH returned 403 | PASS |
| Firestore unauth denied live read smoke | unauthenticated REST read of `pa-bulk-upload-batches/smoke` | read denied for `pa-bulk-upload-batches/{batchId}` | returned 403 `PERMISSION_DENIED` | PASS |
| Firestore non-operator/candidate denied live read smoke | temporary non-operator token and mapped-candidate token attempt batch read | read denied; candidate portal cannot see supply-intake docs | non-operator read 403; mapped candidate read 403; temporary mapping/doc/auth users cleaned up | PASS |
| Firestore index decision | review dashboard query shape | no composite index required for top-level batch orderBy or per-batch item orderBy | no composite index added by Worker D | PASS |
| Callable tests | focused callable/function tests for S3 intake | callable surface honors operator-only admin path and does not expose candidate access | admin claim, `@wekruit.com`, and token paths covered; non-admin denied | PASS |
| Public CV regression | `curl -sS -i -X POST https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicCvIngest -H content-type:application/json -d {}` | unchanged 400 validation | HTTP 400 `{"ok":false,"reason":"missing_userId_or_tempUserId"}` | PASS |
| Candidate route regression | `curl -sS -i -I https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer` | HTTP 200 | HTTP 200 | PASS |
| Admin redirect regression | `curl -sS -i -I https://wekruit-pa.web.app/j/hs-11005382-invoko-product-designer` | HTTP 301 to candidate domain | HTTP 301 `location: https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer` | PASS |
| Public candidate regression smoke | public candidate journey smoke after deploy | candidate-facing C-end routes still work and cannot access bulk-upload supply intake | candidate job route HTTP 200; mapped candidate Firestore read of bulk batch returned 403 | PASS |
| No outbound regression smoke | Firestore/admin smoke after S3 simulation | bulk resume intake does not create `pa-outbound` rows or send live outreach | callable-created empty batch processed 0 items; `pa-outbound` count stayed 190 before/after; smoke batches cleaned up | PASS |
| Admin bulk route live smoke | browser or curl after deploy | `/admin/bulk-resumes` dashboard route is live | `curl -I https://wekruit-pa.web.app/admin/bulk-resumes` returned HTTP 200 | PASS |

## Hard Fail Conditions

- Bulk intake creates a parallel candidate root.
- Raw email or phone is used as a document id.
- Missing email creates an invented email handle.
- Employer email silently overrides a different PDF-extracted email.
- Parse failure writes partial `pa-users` data.
- Retry creates duplicate candidates for the same extracted email.
- Candidate can read batch docs.
- Employer can browse non-passed candidates.
- Candidate routes move to admin domain.
- Live outbound is sent during S3.

## Evidence

Worker D local evidence:

- `config/firebase/firestore.rules` now contains explicit S3 rules for the batch
  collection and nested items subcollection.
- `config/firebase/firestore.indexes.json` was reviewed and left unchanged
  because the expected S3 query shapes do not require a composite index.
- Firebase CLI dry-run compiled `config/firebase/firestore.rules` successfully
  and completed without deploying.
- Production Firebase deploy completed for `pa-dashboard`, Firestore rules and
  indexes, S3 callables, and `paPublicCvIngest`.
- Live smokes verified public CV validation, candidate/admin route split,
  operator read, client write denial, unauth/non-operator/candidate denial, and
  no `pa-outbound` count change during the deployed empty-batch callable smoke.
- Temporary smoke batch docs, candidate-auth mapping docs, and Firebase Auth
  smoke users were cleaned up after live verification.
- `git diff --check` passed.
- Full functions test suite passed with 1183 tests.
- Dashboard tests, typecheck, and production build passed.
- Worker D command output is recorded in
  `artifacts/worker-d-rules-indexes-evidence.md`.
