# S2 Summary

**Status:** Implemented, deployed, and live-smoked.
**Date:** 2026-05-13.

## Outcome

S2 adds the candidate identity and claim layer needed for the v2 retention
marketplace.

- Candidate identity now resolves through hashed handles, not raw PII document
  ids.
- PDF-extracted email is primary for resume identity; employer-provided email
  is a hint and mismatch becomes an identity conflict.
- Public CV ingest and ATS resume bind resolve the canonical candidate before
  permanent profile/resume/tag/mem0/follow-up writes.
- Firebase email-link claim writes a server-owned
  `pa-candidate-auth/{firebaseUid}` mapping and candidate-facing redacted
  `pa-candidate-self-profiles/{candidateId}` projection.
- Candidate routes live only on `apps/pa-landing`: `/login`, `/me`,
  `/me/profile`.
- Admin can inspect identity auth mappings, events, and conflicts without
  exposing broad employer browsing.

## Verification Status

Local verification passed in the S2 worktree:

- Core contracts: tests and typecheck passed.
- Persistence identity: tests and typecheck passed.
- Functions: focused S2 tests, full test suite, typecheck, and build passed.
- Candidate landing: build passed.
- Dashboard: typecheck, build, and tests passed.
- Orchestrator regression: full test suite passed.
- `git diff --check` passed.

Production verification completed:

- Firebase deploy completed for landing hosting, dashboard hosting, Firestore
  rules/indexes, `paCandidateClaimProfile`, `paPublicCvIngest`, and
  `paAtsInboundWebhook`.
- Functions predeploy reran the full functions test suite: 1175 tests, 215
  suites, 0 failures.
- Live HTTP smokes passed for `candidate.wekruit.com`, `/login`,
  `/me/profile`, the Invoko public job route, admin `/j/:jobId` redirect,
  public CV ingest validation, and claim callable unauthenticated guard.
- Playwright render smoke passed for `/login`, signed-out `/me/profile`, and
  the public job page.

## Files Changed

Primary implementation files:

- `packages/core-types/src/collections.ts`
- `packages/core-types/src/marketplace.ts`
- `packages/core-types/src/marketplace.test.ts`
- `packages/pa-persistence/src/identity.ts`
- `packages/pa-persistence/src/identity.test.ts`
- `apps/functions/src/identity/claim-api.ts`
- `apps/functions/src/cv-ingest/cv-ingest.ts`
- `apps/functions/src/public-cv-ingest.ts`
- `apps/functions/src/ats-inbound-handler.ts`
- `apps/functions/src/ats-inbound-webhook.ts`
- `apps/pa-landing/src/pages/CandidateLogin.tsx`
- `apps/pa-landing/src/pages/CandidatePortal.tsx`
- `apps/dashboard-web/src/pages/IdentityConflicts.tsx`
- `apps/dashboard-web/src/pages/CandidateMarketplace.tsx`
- `apps/dashboard-web/src/pages/CandidateMarketplace.helpers.ts`
- `config/firebase/firestore.rules`

## Product Decisions

- `pa-users/{candidateId}` remains the canonical global candidate profile.
- Email magic-link claim uses Firebase Auth email link plus a server-owned
  `pa-candidate-auth/{firebaseUid}` mapping.
- PDF-extracted email is primary for resume identity. Employer email mismatch
  creates a review conflict.
- Candidate self-read must be scoped through auth mapping, not URL ids.
- Candidate pages must use the claim callable/redacted self-profile. Raw
  `pa-users` remains server/operator owned because Firestore cannot field-filter
  document reads.
- First interview behavior remains unchanged: S2 identity resolution does not
  add a match-score gate.
- NOT_PASS behavior remains unchanged: S2 does not remove candidates from the
  global marketplace pool.

## Known Gaps

- Live claim flow has not sent a real magic-link email in this sprint because
  that would create an external email side effect. The callable, auth guard,
  landing render, and server-side claim helper are verified; a real email-link
  UX smoke should be run only with an approved recipient.

## Next Sprint Trigger

S3 can begin only after S2 lands on `main`, is deployed, and the identity claim
and merge acceptance checks pass.
