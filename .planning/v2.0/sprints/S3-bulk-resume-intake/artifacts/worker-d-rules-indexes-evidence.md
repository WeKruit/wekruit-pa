# Worker D Rules/Indexes Evidence

Date: 2026-05-13

## Scope

- `config/firebase/firestore.rules`
- `config/firebase/firestore.indexes.json`
- S3 acceptance and summary docs

## Security Intent

- `pa-bulk-upload-batches/{batchId}` is admin/operator-read and client-write denied.
- `pa-bulk-upload-batches/{batchId}/items/{itemId}` is admin/operator-read and client-write denied.
- Cloud Functions own mutations through Admin SDK.
- Candidate auth mappings do not grant bulk intake access.
- Anonymous users do not get bulk intake access.
- Employer-visible profile rules were not expanded.

## Index Decision

No composite index was added in Worker D. The repo currently shows bulk intake
persistence by direct document and per-batch subcollection access, with no S3
collection-group query or equality-filter-plus-order query committed in this
worktree. Firestore single-field indexes cover the expected top-level batch
ordering and per-batch item ordering. If another lane adds status-filtered
dashboard/process queries, add only that exact composite query shape.

## Commands

- `node -e "JSON.parse(require('fs').readFileSync('config/firebase/firestore.indexes.json','utf8')); console.log('firestore.indexes.json: valid JSON')"`
  - Result: `firestore.indexes.json: valid JSON`
- `git diff --check -- config/firebase/firestore.rules config/firebase/firestore.indexes.json .planning/v2.0/sprints/S3-bulk-resume-intake/ACCEPTANCE.md .planning/v2.0/sprints/S3-bulk-resume-intake/SUMMARY.md .planning/v2.0/sprints/S3-bulk-resume-intake/artifacts/worker-d-rules-indexes-evidence.md`
  - Result: no whitespace errors.
- `npx firebase-tools deploy --help | rg -n "dry|only|non-interactive|project"`
  - Result: confirmed Firebase CLI deploy supports `--dry-run`.
- `npx firebase-tools deploy --only firestore:rules,firestore:indexes --project wekruit-5f89b --non-interactive --dry-run`
  - Result: rules file `config/firebase/firestore.rules` compiled successfully; dry run complete.
