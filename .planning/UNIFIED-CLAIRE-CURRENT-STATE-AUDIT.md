# Unified Claire Candidate Product Current-State Audit

Date: 2026-05-15
Branch: `codex/unified-claire-candidate-product`
Firebase project: `wekruit-5f89b`

## Identity And User Pool Boundary

`pa-users` is currently serving two distinct product roles:

- Real candidate accounts / SMS candidates, for example `pa-users/U7AwKT8nLDRa35DkuBxq`.
- External-supply prospects created from operator imports, for example manual CSV rows linked by LinkedIn handles.

Live Firestore evidence:

- `indolencorlol@gmail.com` resolves to exactly one profile: `pa-users/U7AwKT8nLDRa35DkuBxq`.
- That profile has `phoneE164 = +14243201960`, `latestResumeArtifactId = candidate_upload_U7AwKT8nLDRa35DkuBxq_e0f213bf9fcb83c33328e2f133b31c7f`, and active historical job prescreen sessions.
- `+13054507715` is not a candidate phone. It is the active Sendblue sender in `pa-config/sendblue-pool` with label `Pool A (305)`.
- Recent UUID `pa-users` rows around `2026-05-14T23:54:44Z` through `2026-05-15T00:58:27Z` were created by external supply batch `81395d47-3da9-4485-8025-fcdc79a4aa93`, source `manual_csv`, via `pa-candidate-source-links`.
- Older phone-backed `pa-users` rows include many synthetic E2E/QA profiles (`e2e-*`, `p9-*`, `qa*`, `recheck-*`, `synthetic*`, `*reset*`, `*smoke*`, `*test*`, `+19999...`, `+1888...`, `*@example.com`, `*@local`). These are also not real candidate accounts and must be excluded from user-wise acceptance checks.

Root cause of the "many users" confusion:

- Sendblue allowlist gates iMessage traffic by the inbound sender phone (`from_number`).
- External supply imports do not pass through the Sendblue allowlist. They create or merge `pa-users` profiles through the LinkedIn-first identity resolver.
- Therefore a global `pa-users` count is not a valid user-wise prescreen test signal.

Required fix boundary:

- Job prescreen, logged-in candidate pages, and live iMessage tests must always use the canonical candidate id resolved from auth/email/phone: `U7AwKT8nLDRa35DkuBxq` for `indolencorlol@gmail.com`.
- Dashboard and admin views must visually separate real candidate accounts/SMS candidates from external-supply prospects.
- Dashboard and admin views must visually separate synthetic test profiles from real candidate accounts.
- External-supply prospects may remain in the shared candidate pool, but they must not pollute user-wise onboarding/prescreen verification.

## Code Paths Observed

### iMessage Allowlist And Phone Resolution

- `apps/functions/src/sendblue/allowlist.ts`
  - Uses `IMESSAGE_PEERS`, `IMESSAGE_PEER`, and `IMESSAGE_DEFAULT_PEER`.
  - Normalizes phone-like handles to E.164.
  - Fails closed unless `IMESSAGE_DM_ALLOWLIST=0`.

- `apps/functions/src/sendblue/webhook.ts`
  - Checks allowlist against `normalized.fromNumber`.
  - Looks up `pa-users` with `where("phoneE164", "==", fromNumber)`.
  - Creates `pa-inbound-events` after allowlist passes.

- `apps/functions/src/sendblue/triggers/prescreen.ts`
  - Handles `WeKruit_<jobId>_<userId>_Job`.
  - Requires sender phone to resolve to the parsed user, an admin, or a valid pending-invite binding.

### Candidate Auth And Resume Upload

- `apps/functions/src/identity/claim-api.ts`
  - Claims a candidate profile using Firebase Auth email and browser uid.
  - Current live auth for `indolencorlol@gmail.com` points to `pa-users/U7AwKT8nLDRa35DkuBxq`.

- `apps/functions/src/public-cv-ingest.ts`
  - Public CV ingest accepts a caller-provided `userId`.
  - This must only be used after canonical profile resolution on logged-in candidate pages.

### External Supply User Creation

- `packages/pa-persistence/src/external-supply-upsert.ts`
  - `create_new` mints `pa-users/{uuid}` for LinkedIn-anchored external prospects.
  - Writes `pa-candidate-handles`, `pa-candidate-source-links`, and `pa-candidate-identity-events`.
  - This bypasses Sendblue allowlist by design.

## Immediate Gaps

- Dashboard language still encourages reading `pa-users` as "users" instead of a candidate pool with source classes. Status: partly fixed on `/admin/candidates`; other admin pages still need audit.
- User-wise test acceptance must filter to the canonical candidate id or a real candidate account subset. Status: fixed for `/admin/candidates` default view and documented for live prescreen checks.
- The unified candidate product needs an explicit source taxonomy in dashboard and test scripts:
  - `candidate_account`
  - `sms_candidate`
  - `external_supply_prospect`
  - `synthetic_test_profile`
  - `layoff_candidate`
  - `ats_candidate`

## 2026-05-15 Fix Verification

- `apps/dashboard-web/src/pages/Candidates.tsx` now defaults to "Candidate accounts only" and separately counts candidate accounts, external prospects, and synthetic tests.
- `apps/dashboard-web/src/pages/Candidates.helpers.ts` now treats old phone-only SMS rows as `legacy_sms_profile`, not `candidate_account`. A real dashboard candidate account requires current candidate/profile signal such as claimed auth identity, resume/profile evidence, PII consent, or the explicit layoff source tag; `mem0UserId` alone is not enough.
- `paCandidateClaimProfile` and `paCandidateResumeGateStatus` now reject `@wekruit.com` operator emails on the candidate app, so admin logins cannot create new candidate profiles.
- Node 24 verification:
  - `node --import tsx --test apps/functions/src/identity/claim-api.test.ts apps/functions/src/identity/candidate-resume-gate.test.ts` passed 11/11.
  - `npm run typecheck --workspace=@pa/functions` passed.
  - `npm run build --workspace=@pa/functions` passed.
  - Firebase deploy predeploy ran the full functions test suite: 1451 passed, 0 failed.
- Deployment:
  - `paCandidateClaimProfile` updated as Node.js 24, callable, us-central1.
  - `paCandidateResumeGateStatus` updated as Node.js 24, callable, us-central1.
  - `hosting:pa-dashboard` released to `https://wekruit-pa.web.app`.
- Live Firestore recheck:
  - `indolencorlol@gmail.com` still resolves to exactly `pa-users/U7AwKT8nLDRa35DkuBxq`.
  - `pa-config/sendblue-pool` active number is `+13054507715`.
  - Latest 500 `pa-users` classify as 5 candidate accounts, 28 external prospects, and 467 synthetic tests.

## 2026-05-15 Follow-Up Verification

- Sendblue inbound allowlist:
  - Deployed `paSendblueWebhook` is Node.js 24.
  - Deployed `IMESSAGE_PEERS` contains one allowed candidate peer: Adam's `+1424...1960` test phone.
  - A signed webhook canary from the previously allowed `...4668` phone returned `{ ok: true, ignored: "allowlist_deny" }`.
  - Firestore wrote an audit event with `type = allowlist_deny` and did not create a `pa-inbound-events` row for that denied canary.
- Dashboard candidate-pool classification:
  - `node --import tsx --test apps/dashboard-web/src/pages/__tests__/Candidates.test.ts` passed 6/6.
  - `npm run typecheck --workspace=@pa/dashboard-web` passed under Node 24.
  - Live Firestore latest-500 recheck through the same dashboard helper classified:
    - `candidate_account = 1`
    - `external_supply_prospect = 28`
    - `legacy_sms_profile = 0`
    - `synthetic_test_profile = 467`
    - `incomplete_identity_artifact = 4`
  - The only default dashboard `candidate_account` row is `pa-users/U7AwKT8nLDRa35DkuBxq`.
- Dashboard candidate-pool correction:
  - `verify-*` production verification docs are classified as `synthetic_test_profile`.
  - `mem0UserId` alone no longer promotes old phone-only SMS rows to `candidate_account`.
  - Live Firestore all-rows recheck through the same dashboard helper classified all 599 `pa-users` rows:
    - `candidate_account = 1`
    - `external_supply_prospect = 28`
    - `legacy_sms_profile = 5`
    - `synthetic_test_profile = 559`
    - `incomplete_identity_artifact = 6`
  - The only `candidate_account` row remains `pa-users/U7AwKT8nLDRa35DkuBxq`.
- After the prescreen stress runner cleanup, live Firestore all-rows recheck through the same dashboard helper classified all 602 `pa-users` rows:
  - `candidate_account = 1`
  - `external_supply_prospect = 28`
  - `legacy_sms_profile = 5`
  - `synthetic_test_profile = 562`
  - `incomplete_identity_artifact = 6`
  - The only `candidate_account` row remains `pa-users/U7AwKT8nLDRa35DkuBxq`.
  - Existing `@wekruit.com` operator docs, including `admin1@wekruit.com`, are excluded from candidate account counts.
  - Old generated `verify-prescreen-stress-*` user docs from early failed stress runs were deleted; one stable synthetic profile remains for repeatable stress testing: `pa-users/verify-prescreen-stress-user`.
- E2E/test webhook user-creation boundary:
  - `onPaInbound` now treats `rawPayload.e2eTest === true` as test traffic that must already be bound to an existing `pa-users` row.
  - If an E2E Sendblue webhook reaches broker processing from an unbound phone, it marks the inbound row completed with `routedTo = e2e_unbound_user` and `errorCode = E2E_UNBOUND_USER`; it does not call `createProvisionalUser`.
  - Node 24 targeted test passed: `node --import tsx --test apps/functions/src/__tests__/broker-e2e-user-boundary.test.ts` (2/2).
  - Node 24 functions typecheck passed: `npm run typecheck --workspace=@pa/functions`.
  - Full functions predeploy test during deploy passed 1512/1512.
  - Deployed `onPaInbound` to production as Node.js 24.
  - Live signed deployed-webhook verification used an unbound `+1999555...` test phone with `X-E2E-Test: 1`; result: webhook 200, `pa-users` count stayed 602 -> 602, no row matched that phone, and `pa-inbound-events/inb_e5204c1943abb55a5173b83cb8e2fd72c2871ff8` completed with `E2E_UNBOUND_USER`.

## 2026-05-15 Prescreen Conversation Verification

- Code locks:
  - New trigger starts a new `workSession` and supersedes older active prescreens for that user with `terminal = PAUSE`, `boundary = superseded`.
  - Idle active sessions expire instead of routing late replies into the wrong job.
  - Explicit user exit pauses the work session with `boundary = user_exit`.
  - Coalesced multi-message role-fit replies are scored as one probe turn and persisted as one turn.
  - Weak engineering evidence now has a regression test requiring four probe turns before `HARD_STOP`.
  - Adjacent but credible engineering evidence after repeated probing advances instead of abrupt hard-stop.
  - Terminal actions write terminal stamps, memory update events, and candidate-job state; PAUSE does not start PII or job recs.
- Node 24 verification:
  - `node --import tsx --test packages/pa-orchestrator/src/prescreen/__tests__/pipeline.test.ts apps/functions/src/prescreen-turn-handler.test.ts apps/functions/src/prescreen-session-start.test.ts apps/functions/src/prescreen-terminal-action.test.ts` passed 31/31.
  - `npm run typecheck --workspace=@pa/pa-orchestrator` passed.
  - `npm run typecheck --workspace=@pa/functions` passed.
- Git:
  - `d430da8 test(prescreen): require full weak-candidate probing` is pushed to `main`.

## 2026-05-15 Rain Fullstack Prescreen Stress Verification

- Production job verified and refreshed:
  - `pa-jobs/rain-software-engineer-fullstack-8849f6ef`.
  - Old production `prescreenConfig.questions[0]` had `matchThreshold = 0.85` and bare keyword/hint `role_fit`.
  - Refreshed production config has `role_fit.matchThreshold = 0.70`, keyword `role_fit_software_engineer`, and a role-aware hint that counts adjacent owned engineering/product systems while later questions still check technical depth and logistics.
- Stress runner:
  - `apps/functions/scripts/prescreen-stress-firestore.ts`.
  - Uses real production Firestore and real `runPreScreenForUser`, `runPrescreenTurnIfActive`, and `runPrescreenTerminalAction`.
  - Stubs outbound SMS, so no test texts are sent while sessions, turns, memory events, candidate-job state, and employer-visible profiles are still written.
  - Uses one stable synthetic/testMode user: `pa-users/verify-prescreen-stress-user`; each scenario clears only this synthetic user's job state/snapshot before starting.
- Artifact:
  - `.planning/prescreen-stress/artifacts/stress-2026-05-15T18-04-36-947Z.json`.
- Result matrix:
  - `strong_fullstack_pass`: `PASS`, 0 clarifies, score `4.72/5`, memory event exists, employer-visible profile exists, candidate-job state `employer_visible`.
  - `adjacent_probe_recovery`: `PASS`, 3 clarifies before recovery, score `4.64/5`, memory event exists, employer-visible profile exists, candidate-job state `employer_visible`.
  - `weak_no_engineering_hard_stop`: `HARD_STOP`, 4 clarifies before stop, memory event exists, no employer-visible profile, candidate-job state `not_passed`.
  - `user_exit_pause`: `PAUSE`, memory event exists, no employer-visible profile, candidate-job state `paused`.
- Node 24 verification:
  - `node --import tsx --test apps/functions/src/__tests__/job-enrichment.test.ts apps/functions/src/prescreen-terminal-action.test.ts apps/functions/src/__tests__/broker-prescreen-trigger.test.ts packages/pa-orchestrator/src/prescreen/__tests__/pipeline.test.ts` passed 38/38.
  - `npm run typecheck --workspace=@pa/functions` passed.

## 2026-05-15 Sendblue Entrypoint Matrix Verification

- Script:
  - `apps/functions/scripts/sendblue-entrypoint-matrix-firestore.ts`.
  - Uses real production Firestore and the real `handleSendblueWebhook` router.
  - Sets `X-E2E-Test: 1` and signs requests with a local test secret for direct handler execution.
  - Stubs outbound Sendblue/pre-screen/layoff sends, so no real SMS/iMessage is sent.
  - Refuses to create a new matrix user; it requires existing synthetic `pa-users/verify-prescreen-stress-user`.
  - Restores the synthetic user's pre-run profile after layoff trigger checks.
- Artifact:
  - `.planning/sendblue-entrypoint-matrix/artifacts/sbmatrix-2026-05-15T18-38-01-519Z.json`.
- Result matrix:
  - `job_prescreen_trigger`: webhook 200, action `prescreen_triggered`, created session `ps_rain-software-engineer-fullstack-8849f6ef_verify-prescreen-stress-user_20260515T183803145Z`, prescreen outbound was stubbed once.
  - `layoff_trigger`: webhook 200, action `layoff_triggered`, source temporarily set to `WeKruit_Laid_Off`, layoff outbound was stubbed once, synthetic user restored after the run.
  - `normal_start_no_pending_invite`: webhook 200, created broker inbound `inb_d303edaeb735de86658b4087c09896eef468019c`, raw text stayed `START`, no trigger action fired.
  - `start_with_ats_pending_invite`: webhook 200, action `prescreen_triggered`, pending invite consumed, created session `ps_rain-software-engineer-fullstack-8849f6ef_verify-prescreen-stress-user_20260515T183807739Z`.
- User-pool safety recheck after the matrix:
  - `pa-users` count stayed 602.
  - `candidate_account = 1`.
  - The only `candidate_account` remains `pa-users/U7AwKT8nLDRa35DkuBxq`.
  - Matrix user remains `testMode = true`, `candidateLifecycleState = synthetic_test`, `phoneE164 = +19995550000`.

## 2026-05-15 Current User-Pool Diagnosis

- Live `pa-users` total: 602.
- Source breakdown:
  - `external_sourcing:manual_csv = 28`.
  - `identity:candidate = 3`.
  - `identity:resume = 1`.
  - `ats:handshake = 1`.
  - `test:prescreen_stress = 1`.
  - no `signupSource = 568`, mostly old synthetic onboarding/test rows.
- Real candidate-account boundary:
  - Only `pa-users/U7AwKT8nLDRa35DkuBxq` is the active real candidate account for this test environment.
  - It is tied to `indolencorlol@gmail.com`, parsed resume phone `+14243201960`, and the current candidate profile/resume/prescreen data.
- Pollution/artifact examples:
  - `pa-users/itYEwzaJjVPjWbN01fzk` has `email = admin1@wekruit.com`; this is a historical operator-created candidate-app artifact and is excluded by current dashboard classification and current candidate-claim code.
  - `pa-users/REmvNNz52scHkfGZqxfp` is an empty historical `identity:candidate` shell with no reachable identity; it is excluded as `incomplete_identity_artifact`.
  - `pa-users/cBg4UzOJKv3S2PyUc4vM` is an old `identity:resume` duplicate marked `duplicateOfCandidateId = U7AwKT8nLDRa35DkuBxq`.
  - `pa-users/a980354d-725f-4b10-a9ce-f96e48788913` is an old ATS/Handshake test row with `@example.com` email and is not a real candidate account.
- Root cause:
  - The Sendblue/iMessage path is phone allowlisted.
  - Candidate auth/resume, external supply, ATS/import, and old production Firestore E2E scripts are not phone-allowlist paths.
  - Therefore "phone allowlist" was not sufficient as a global `pa-users` creation policy.
- Current guard status:
  - `paSendblueWebhook` is allowlist-gated by phone.
  - `onPaInbound` now refuses to create production users from unbound `X-E2E-Test` traffic.
  - `paCandidateClaimProfile` and `paCandidateResumeGateStatus` reject `@wekruit.com` operator accounts.
  - `/admin/candidates` defaults to candidate accounts only and excludes external prospects, synthetic tests, old SMS profiles, and incomplete identity artifacts.

## 2026-05-15 Production E2E User-Creation Guard

- New shared guard:
  - `apps/functions/scripts/lib/prod-test-user-guard.mjs`.
  - In production project `wekruit-5f89b`, scripts refuse to create fresh `pa-users` rows unless `WEKRUIT_ALLOW_PROD_TEST_USER_CREATE=1` is explicitly set.
  - This is intentionally not a Sendblue phone allowlist; it protects non-webhook production validation scripts that write Firestore directly or create users indirectly through broker events.
- Guarded legacy scripts:
  - `e2e-single-no-cleanup.mjs`
  - `e2e-memory-verify.mjs`
  - `e2e-post-onboarding.mjs`
  - `e2e-onboarding-sim.mjs`
  - `e2e-onboarding-20-iter.mjs`
  - `e2e-onboarding-20-iter-v3.mjs`
  - `e2e-reset-cold-start.mjs`
  - `e2e-bug-a-b-verify.mjs`
  - `e2e-bug-d-verify.mjs`
  - `qa-iter30-v4-reset-multi.mjs`
- Verification:
  - `node --import tsx --test apps/functions/scripts/__tests__/prod-test-user-guard.test.ts` passed 5/5.
  - `npm run typecheck --workspace=@pa/functions` passed under Node 24.
  - `npm test --workspace=@pa/functions` passed 1517/1517; the guard regression test is part of the normal functions test command.
  - Live Firestore recheck after the test run: `pa-users` stayed at 602; `pa-users/U7AwKT8nLDRa35DkuBxq` still exists with `email = indolencorlol@gmail.com`, `phoneE164 = +14243201960`; stable stress user remains `testMode = true`.

## 2026-05-15 WeKruit Open / Layoff Front Door Verification

- Separate repo: `/Users/adam/Desktop/WeKruit/wekruit-layoff`.
- Backend already writes layoff candidates into `pa-users` via `openRegisterLayoffCandidate`.
- Frontend fix:
  - Signup no longer treats `resumeFileName` as enough.
  - After `openRegisterLayoffCandidate` returns `candidateId`, signup uploads the selected PDF to `paPublicCvIngest` with `userId = candidateId`.
  - Duplicate/reuse path also uploads the pending resume to the reused `candidateId`.
  - Registration/upload/SMS failures now show an error instead of falling back to fake `local-*` candidate ids.
  - File picker now only advertises PDF, matching current `paPublicCvIngest` PDF sniffing.
- Node 24 verification:
  - `npm run typecheck` passed.
  - `npm run build` passed.
- Deployment:
  - `hosting:open` released to `https://layoff-wekruit.web.app`.
- Git:
  - `wekruit-layoff/main` has `2429fd3 fix(signup): parse resumes into pa users`.
- Shared-profile chat fix:
  - `openSubmitChatTurn` now refuses to create missing `pa-users` docs.
  - It requires the candidate profile to already have `source = WeKruit_Laid_Off`.
  - Layoff chat answers now merge into `pa-users.conversationDerivedPreferences.layoff_onboarding`, `pa-users.layoffEvidence.latestChatTurn`, and `pa-users.layoffContext`, rather than writing only an isolated `layoffChatAnswers` map.
  - Node 24 targeted test passed: `node --import tsx --test apps/functions/src/openLayoff.test.ts` (8/8).
  - Node 24 functions typecheck passed: `npm run typecheck --workspace=@pa/functions`.
  - Firebase deploy predeploy full functions suite passed 1512/1512.
  - `openSubmitChatTurn` deployed as Node.js 24 callable in `us-central1`.

## Remaining Completion Gaps

- WeKruit Open web chat now merges each answer into shared `pa-users` evidence/context and refuses missing/non-layoff profiles. It is still not a full Claire state machine/mem0 conversational path; that remains a separate product integration gap.
- External supply prospects are in the shared `pa-users` pool, but the end-to-end operator path from imported prospect to candidate profile, match/eval, approved outreach, reply, and unified evidence is not yet reverified in this goal.
- Job creation/import still appears split across enrichment approval, seeding scripts, and external-supply job surfaces. The single job creation/publication flow is not yet audited or unified.
- Manual Apple Messages UI testing is still not fully repeated after the stress-runner fixes. The production Firestore prescreen matrix and Sendblue entrypoint matrix are verified with outbound SMS stubbed; one live signed deployed-webhook user-boundary canary and one allowlist-deny canary were verified.
