# S2 Acceptance

This file records S2 verification.

## Required Checks

| Check | Command or action | Expected result | Actual result | Status |
|---|---|---|---|---|
| Branch | `git branch --show-current` | `codex/v2-S2-identity-candidate-claim` | `codex/v2-S2-identity-candidate-claim` | PASS |
| Base | `git merge-base HEAD origin/main && git rev-parse HEAD origin/main` | S2 branch starts from S1 deploy-evidence main `7afe2e7` | merge-base, `HEAD`, and `origin/main` are all `7afe2e79d3f82248e923dfbc943cb18f3c8e027c` before local S2 commits | PASS |
| Core identity contracts | `pnpm --filter @pa/core-types test` | identity schemas and existing marketplace reducers pass | S2 worktree run passed | PASS |
| Core typecheck | `pnpm --filter @pa/core-types typecheck` | shared contracts compile | S2 worktree run passed | PASS |
| Persistence identity tests | `pnpm --filter @pa/pa-persistence test` | identity resolution, conflict, auth mapping, idempotency pass | S2 worktree run passed: 103 tests | PASS |
| Persistence typecheck | `pnpm --filter @pa/pa-persistence typecheck` | persistence package compiles | S2 worktree run passed | PASS |
| Functions tests | `pnpm --filter @pa/functions test` | public CV ingest, ATS, claim callable, and existing functions pass | S2 worktree full run passed: 1175 tests, 215 suites | PASS |
| Functions typecheck | `pnpm --filter @pa/functions typecheck` | functions compile | S2 worktree run passed after package dist rebuilds | PASS |
| Functions build | `pnpm --filter @pa/functions build` | deploy bundle compiles | S2 worktree run passed | PASS |
| Candidate build | `pnpm --filter @pa/landing build` | `/login`, `/me`, `/me/profile` compile | S2 worktree run passed | PASS |
| Dashboard tests | `pnpm --filter @pa/dashboard-web test -- --test-reporter=dot apps/dashboard-web/src/pages/__tests__/CandidateMarketplace.test.ts` | admin conflict/marketplace helpers pass | dashboard test script ran all dashboard tests: 26 pass | PASS |
| Dashboard typecheck | `pnpm --filter @pa/dashboard-web typecheck` | admin conflict queue compiles | S2 worktree run passed | PASS |
| Dashboard build | `pnpm --filter @pa/dashboard-web build` | admin conflict queue compiles | S2 worktree run passed | PASS |
| Identity scenario: same email | `packages/pa-persistence/src/identity.test.ts` | two PDF uploads with same extracted email map to one candidate | covered by same-email/browser-id canonical resolution tests | PASS |
| Identity scenario: browser uid | `packages/pa-persistence/src/identity.test.ts` and `apps/functions/src/cv-ingest/__tests__/cv-ingest.test.ts` | same email across two `wkr_uid` values maps to one candidate | covered; public browser upload resolves canonical user before sha256 resume writes | PASS |
| Identity scenario: email mismatch | `packages/pa-persistence/src/identity.test.ts`, CV ingest tests, ATS tests | PDF email wins; employer email mismatch creates conflict | covered; conflict returns `identity_conflict` and blocks resume/tag/mem0/follow-up/outbound writes | PASS |
| Identity scenario: phone-only | `packages/pa-persistence/src/identity.test.ts` | phone-only profile links by E.164 without invented email | covered | PASS |
| Identity scenario: duplicate upload | `packages/pa-persistence/src/identity.test.ts` and CV ingest tests | duplicate upload is idempotent | covered under canonical candidate id | PASS |
| Firestore rules/indexes | included in S2 deploy command | candidate reads are limited to auth mapping + redacted self-profile; raw `pa-users` and identity internals remain public-denied | rules compiled successfully; rules released to cloud.firestore; indexes deployed | PASS |
| Orchestrator regression | `pnpm --filter @pa/pa-orchestrator test` | existing candidate journey logic remains green | S2 worktree run passed: 1479 tests, 89 suites | PASS |
| Deploy | `pnpm exec firebase deploy --only hosting:pa-dashboard,hosting:pa-landing,firestore:rules,firestore:indexes,functions:pa-orchestrator:paCandidateClaimProfile,functions:pa-orchestrator:paPublicCvIngest,functions:pa-orchestrator:paAtsInboundWebhook --project wekruit-5f89b --non-interactive` | changed hosting, rules/indexes, claim callable, public CV ingest, and ATS inbound deploy | deploy completed; `paCandidateClaimProfile` created, `paPublicCvIngest` and `paAtsInboundWebhook` updated; both hosting targets released | PASS |
| Candidate landing | `curl -sS -i -I https://candidate.wekruit.com/` | HTTP 200 | `HTTP/2 200`; `last-modified: Wed, 13 May 2026 18:25:20 GMT` | PASS |
| Public job page | `curl -sS -i -I https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer` plus Playwright render smoke | HTTP 200 and actual job content renders | `HTTP/2 200`; Playwright rendered Invoko Product Designer content with no page errors | PASS |
| Admin redirect | `curl -sS -i -I https://wekruit-pa.web.app/j/hs-11005382-invoko-product-designer` | HTTP 301 to candidate domain | `HTTP/2 301`, `location: https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer` | PASS |
| Candidate login route | `curl -sS -i -I https://candidate.wekruit.com/login` plus Playwright render smoke | HTTP 200 SPA route with email-link form | `HTTP/2 200`; Playwright found `input[type="email"]` and visible `Send link` | PASS |
| Candidate profile route | `curl -sS -i -I https://candidate.wekruit.com/me/profile` plus Playwright render smoke | HTTP 200 SPA route with signed-out guard | `HTTP/2 200`; Playwright found signed-out `Sign in required` gate and `/login` link | PASS |
| Public CV ingest validation | `curl -sS -i -X POST https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicCvIngest -H content-type:application/json -d {}` | `HTTP/2 400` and `{"ok":false,"reason":"missing_userId_or_tempUserId"}` | exact expected status/body | PASS |
| Candidate claim unauth guard | `curl -sS -i -X POST https://us-central1-wekruit-5f89b.cloudfunctions.net/paCandidateClaimProfile -H content-type:application/json -d '{"data":{}}'` | unauthenticated calls rejected before claim/write | `HTTP/2 401` and `UNAUTHENTICATED` message: `Sign in before claiming a candidate profile.` | PASS |

## Hard Fail Conditions

- Candidate claim uses Gmail-only OAuth instead of email magic link.
- Raw email or phone is used as a document id.
- Client-provided `candidateId` grants profile read access.
- Candidate can directly read raw `pa-users/{candidateId}`.
- Employer-provided email overrides a different PDF-extracted email silently.
- Merge logic deletes or destructively rewrites production data.
- Candidate routes move to the admin domain.
- Match score blocks first interview.
- NOT_PASS exits the candidate from the global marketplace pool.
- Live outbound is sent during S2 without explicit approval.

## Evidence

### Implemented

- Identity contracts and collection constants for auth mapping, redacted self
  profiles, identity events, and identity conflicts.
- Persistence identity service for hashed handle linking, deterministic
  canonical candidate resolution, conflict recording, claim mapping, lifecycle
  event emission, and redacted self-profile projection.
- Public CV ingest now resolves the canonical candidate after PDF parse and
  before permanent resume/tag/mem0/follow-up writes when identity evidence is
  present.
- ATS resume bind is identity-gated. Resume/email mismatch returns
  `identity_conflict`, records an audit reason, and sends no invite.
- `paCandidateClaimProfile` callable verifies Firebase Auth email, resolves or
  creates the canonical candidate, writes `pa-candidate-auth`, and returns only
  the redacted profile.
- Candidate C-end routes added on `apps/pa-landing`: `/login`, `/me`,
  `/me/profile`.
- Admin identity conflict queue added under `/admin/identity-conflicts`; the
  marketplace inspector shows auth mappings, identity events, and open
  conflicts.
- Firestore rules keep raw `pa-users` operator-only and expose only
  `pa-candidate-auth/{request.auth.uid}` plus mapped
  `pa-candidate-self-profiles/{candidateId}` to the signed-in candidate.

### Local Verification Completed Before Deploy

- `pnpm --filter @pa/core-types test && pnpm --filter @pa/core-types typecheck`
- `pnpm --filter @pa/pa-persistence test && pnpm --filter @pa/pa-persistence typecheck`
- `pnpm --filter @pa/landing build`
- `pnpm --filter @pa/dashboard-web typecheck`
- `pnpm --filter @pa/dashboard-web test -- --test-reporter=dot apps/dashboard-web/src/pages/__tests__/CandidateMarketplace.test.ts`
- `node --import tsx --test apps/functions/src/identity/claim-api.test.ts apps/functions/src/ats-inbound-handler.test.ts apps/functions/src/cv-ingest/__tests__/cv-ingest.test.ts apps/functions/src/sendblue/__tests__/webhook.test.ts`
- `pnpm --filter @pa/functions typecheck`
- `pnpm --filter @pa/functions build`
- `pnpm --filter @pa/functions test`
- `pnpm --filter @pa/dashboard-web build`
- `pnpm --filter @pa/pa-orchestrator test`
- `git diff --check`

### Production Verification Completed

- Firebase deploy completed for `hosting:pa-dashboard`, `hosting:pa-landing`,
  `firestore:rules`, `firestore:indexes`,
  `functions:pa-orchestrator:paCandidateClaimProfile`,
  `functions:pa-orchestrator:paPublicCvIngest`, and
  `functions:pa-orchestrator:paAtsInboundWebhook`.
- Functions predeploy reran and passed full functions tests:
  1175 tests, 215 suites, 0 failures.
- Firestore rules compiled and released.
- `candidate.wekruit.com`, `/login`, `/me/profile`, and the Invoko public job
  route returned HTTP 200.
- Playwright render smoke confirmed `/login`, signed-out `/me/profile`, and the
  public job page render nonblank UI with no page errors.
- Admin `/j/:jobId` redirect still returns HTTP 301 to the candidate domain.
- Public CV ingest empty-body validation still returns the exact expected 400
  response.
- Claim callable unauthenticated requests return HTTP 401 before any claim
  write.
