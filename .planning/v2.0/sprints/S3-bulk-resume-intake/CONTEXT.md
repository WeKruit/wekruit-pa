# S3 Context - Bulk Resume Intake

## Current Worktree

- Worktree: `/Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/v2-S3-bulk-resume-intake`
- Branch: `codex/v2-S3-bulk-resume-intake`
- Base: `origin/main` at `0a8b794 feat(v2): add candidate identity claim layer (#25)`
- Dirty files at sprint start: none.

## Prior Sprint State

S2 is merged and deployed.

- PR: `https://github.com/WeKruit/wekruit-pa/pull/25`
- Production deploy covered:
  - `hosting:pa-dashboard`
  - `hosting:pa-landing`
  - `firestore:rules`
  - `firestore:indexes`
  - `functions:pa-orchestrator:paCandidateClaimProfile`
  - `functions:pa-orchestrator:paPublicCvIngest`
  - `functions:pa-orchestrator:paAtsInboundWebhook`
- Live smoke passed for candidate routes, admin redirect, public CV ingest
  validation, and claim callable unauth guard.

S2 intentional gap:

- Real magic-link email was not sent because that is an external email side
  effect. S3 must not depend on a real email send.

## Product Invariant Advanced By S3

S3 advances: every candidate who enters the system becomes durable global
supply.

Bulk resume intake is a supply ingestion path. It must create or merge global
candidate profiles, not create employer-owned candidate rows or job-specific
candidate roots.

## Locked Constraints

- Candidate profile root remains `pa-users/{candidateId}`.
- PDF-extracted email drives identity.
- Employer-provided email is a hint. If it conflicts with PDF email, create
  review state; do not silently override.
- Raw PII must not appear in document ids.
- Candidate routes stay on `candidate.wekruit.com` / `pa.wekruit.com`.
- Admin route for this sprint is `/admin/bulk-resumes`.
- Employer surface remains passed-profile-only. S3 is operator/admin intake,
  not employer candidate browsing.
- No live outbound is sent in S3.
- Batch processing must be idempotent by file hash plus extracted email when
  available.

## Existing Code Anchors

- `apps/functions/src/public-cv-ingest.ts`
  - Public HTTP wrapper around `ingestCv`.
  - Already passes browser uid, ATS applicant id, and employer email hint into
    S2 identity resolution.
- `apps/functions/src/cv-ingest/cv-ingest.ts`
  - Parses PDF, extracts structured CV, resolves canonical identity, writes
    `parsedCandidateResumes`, merges tags through `mergeUserTags`, writes
    resume artifacts and self-profile data.
- `packages/pa-persistence/src/identity.ts`
  - Hashes handles, resolves canonical candidate, records identity conflicts,
    writes claim/auth/self-profile projections.
- `packages/core-types/src/marketplace.ts`
  - Already defines `ResumeArtifactSchema`, identity conflicts, and marketplace
    state primitives.
- `apps/dashboard-web/src/App.tsx`
  - Admin navigation and routes.
- `apps/dashboard-web/src/lib/firebase.ts`
  - Dashboard Firebase Auth, Firestore, and callable Functions helpers.
- `apps/dashboard-web/src/pages/CandidateMarketplace.tsx`
  - Existing operator marketplace debug style for candidate/resume data.
- `config/firebase/firestore.rules`
  - Raw `pa-users` operator-only. New bulk collections must remain
    operator-only.

## S3 User-Facing Shape

Admin/operator can:

- open `/admin/bulk-resumes`;
- create a batch;
- add three or more PDF resumes with optional employer-provided email hints;
- start processing;
- see each item move through queued, parsing, parsed, conflict, missing email,
  parse failed, or retry-ready states;
- see created or merged candidate id and resume artifact id;
- retry parse failures without duplicate profile writes.

Candidate can:

- later claim or open `/me`;
- see the latest uploaded resume reflected through the S2 redacted self
  profile projection.

## First Known Verification Targets

- Core schema tests for new bulk batch/item contracts.
- Function/service tests for:
  - clean email PDF creates or merges candidate;
  - missing email becomes review state and does not invent an email;
  - employer email mismatch becomes identity conflict/review state;
  - parse failure does not write a partial candidate profile;
  - retry is idempotent.
- Dashboard tests for `/admin/bulk-resumes` state rendering.
- Existing single public CV ingest tests remain green.
- Live deploy and smoke only after local tests pass.
