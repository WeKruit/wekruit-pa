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
  - Now hard-fails if terminal memory events, candidate-job state, employer-visible snapshots, work-session boundaries, or `pa-users` no-growth checks do not match expectations.
- Artifact:
  - `.planning/prescreen-stress/artifacts/stress-2026-05-15T19-23-01-297Z.json`.
- Result matrix:
  - `pa-users` count stayed `602 -> 602`.
  - `strong_fullstack_pass`: `PASS`, 0 clarifies, terminal turn 5, memory event exists, employer-visible profile exists, candidate-job state `employer_visible`, work session ended with `boundary = terminal`.
  - `adjacent_probe_recovery`: `PASS`, 3 clarifies before recovery, terminal turn 8, memory event exists, employer-visible profile exists, candidate-job state `employer_visible`, work session ended with `boundary = terminal`.
  - `weak_no_engineering_hard_stop`: `HARD_STOP`, 4 clarifies before stop, memory event exists, no employer-visible profile, candidate-job state `not_passed`.
  - `user_exit_pause`: `PAUSE`, memory event exists, no employer-visible profile, candidate-job state `paused`.
  - `new_trigger_supersedes_active_prescreen`: a fresh trigger superseded the older active prescreen with `terminal = PAUSE`, `terminalReason = superseded_by_new_prescreen_session:*`, and `workSession.boundary = superseded`; the new active session was then cleanup-ended.
- Node 24 verification:
  - `node --import tsx --test apps/functions/src/__tests__/job-enrichment.test.ts apps/functions/src/prescreen-terminal-action.test.ts apps/functions/src/__tests__/broker-prescreen-trigger.test.ts packages/pa-orchestrator/src/prescreen/__tests__/pipeline.test.ts` passed 38/38.
  - `npm run typecheck --workspace=@pa/functions` passed.
  - `node --import tsx --test apps/functions/src/prescreen-session-start.test.ts apps/functions/src/prescreen-turn-handler.test.ts apps/functions/src/coalesce/__tests__/paMessageCoalescer.test.ts apps/functions/src/prescreen-terminal-action.test.ts apps/functions/src/prescreen-outcome-service.test.ts` passed 46/46.
  - `npm test --workspace=@pa/functions` passed 1518/1518 after the hardened stress runner change.

## 2026-05-15 Sendblue Entrypoint Matrix Verification

- Script:
  - `apps/functions/scripts/sendblue-entrypoint-matrix-firestore.ts`.
  - Uses real production Firestore and the real `handleSendblueWebhook` router.
  - Sets `X-E2E-Test: 1` and signs requests with a local test secret for direct handler execution.
  - Stubs outbound Sendblue/pre-screen/layoff sends, so no real SMS/iMessage is sent.
  - Refuses to create a new matrix user; it requires existing synthetic `pa-users/verify-prescreen-stress-user`.
  - Restores the synthetic user's pre-run profile after layoff trigger checks.
- Artifact:
  - `.planning/sendblue-entrypoint-matrix/artifacts/sbmatrix-2026-05-15T19-28-31-601Z.json`.
- Result matrix:
  - `job_prescreen_trigger`: webhook 200, action `prescreen_triggered`, created session `ps_rain-software-engineer-fullstack-8849f6ef_verify-prescreen-stress-user_20260515T192833253Z`, prescreen outbound was stubbed once.
  - `layoff_trigger`: webhook 200, action `layoff_triggered`, source temporarily set to `WeKruit_Laid_Off`, layoff outbound was stubbed once, synthetic user restored after the run.
  - `normal_start_no_pending_invite`: webhook 200, created broker inbound `inb_c79c84c137869d8a186a923c212a00d57474a5dc`, raw text stayed `START`, no trigger action fired.
  - `start_with_ats_pending_invite`: webhook 200, action `prescreen_triggered`, pending invite consumed, created session `ps_rain-software-engineer-fullstack-8849f6ef_verify-prescreen-stress-user_20260515T192839270Z`.
- User-pool safety recheck after the matrix:
  - `pa-users` count stayed 602.
  - `candidate_account = 1`.
  - The only `candidate_account` remains `pa-users/U7AwKT8nLDRa35DkuBxq`.
  - Matrix user remains `testMode = true`, `candidateLifecycleState = synthetic_test`, `phoneE164 = +19995550000`.
  - Matrix cleanup ended both sessions it created with `terminal = PAUSE` and `terminalReason = sendblue_matrix_cleanup`.
  - Live Firestore recheck after cleanup: `pa-prescreen-sessions` where `userId = verify-prescreen-stress-user` and `terminal = null` returned 0 active sessions.
  - Node 24 verification after cleanup change: `npm run typecheck --workspace=@pa/functions` passed; rerunning the matrix passed with `pa-users 602 -> 602`.

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
- Guarded root verification scripts:
  - `scripts/e2e-downstream-tag-side-effect.mjs` now refuses fresh production `pa-users` creation by default.
  - `scripts/verify-match-company-tags.mjs` now requires the target synthetic `pa-users` row to already exist in production.
  - `scripts/verify-nl-judge-urgently-seeking.mjs` now requires the target synthetic `pa-users` row to already exist in production.
- Verification:
  - `node --import tsx --test apps/functions/scripts/__tests__/prod-test-user-guard.test.ts` passed 6/6.
  - Direct production-credential run of `scripts/e2e-downstream-tag-side-effect.mjs` failed before any write with `refused to create a production pa-users row`.
  - `npm run typecheck --workspace=@pa/functions` passed under Node 24.
  - `npm test --workspace=@pa/functions` passed 1517/1517; the guard regression test is part of the normal functions test command.
  - Live Firestore recheck after the test run: `pa-users` stayed at 602; `pa-users/U7AwKT8nLDRa35DkuBxq` still exists with `email = indolencorlol@gmail.com`, `phoneE164 = +14243201960`; stable stress user remains `testMode = true`.

## 2026-05-15 Rain Fullstack Live Prescreen Verification

- Test identity:
  - Candidate: `pa-users/U7AwKT8nLDRa35DkuBxq`.
  - Email: `indolencorlol@gmail.com`.
  - Phone: `+14243201960`.
  - Job trigger: `WeKruit_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_Job`.
- Live iMessage result:
  - New same-job trigger created a fresh work session instead of deduping against an old ended session.
  - Session: `pa-prescreen-sessions/ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260515T202128136Z`.
  - The candidate gave partial and then multi-message answers; coalescing preserved the two quick messages as one turn.
  - Claire probed role fit twice and technical depth once before moving through location, compensation, and sponsorship.
  - Terminal: `PASS`, score `4.41/5.00`, ratio `0.882`, threshold `0.65`.
- Firestore result:
  - `pa-users` count stayed `602`.
  - `pa-candidate-job-states/U7AwKT8nLDRa35DkuBxq__rain-software-engineer-fullstack-8849f6ef` is `employer_visible`.
  - `pa-employer-visible-profiles/rain-software-engineer-fullstack-8849f6ef__U7AwKT8nLDRa35DkuBxq` points to the latest session.
  - `pa-users/U7AwKT8nLDRa35DkuBxq.lastPrescreenMemoryUpdate` and `conversationDerivedPreferences.prescreenEvidenceByJob.rain-software-engineer-fullstack-8849f6ef` were updated with reusable engineering evidence.

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

## 2026-05-15 Layoff Front Door And Verified Marketplace Recheck

- Root cause fixed:
  - `openListLayoffCandidates` queried `pa-users` with `source == WeKruit_Laid_Off` plus `lastLaidOffAt >= cutoff` but did not explicitly order by `lastLaidOffAt`.
  - Production Firestore requested an ascending composite index, while the declared contract/index is `pa-users(source asc, lastLaidOffAt desc)`.
  - `runListLayoffCandidates` now orders by `lastLaidOffAt desc`, matching the deployed index contract and the marketplace "newest first" behavior.
- Auth/adoption lock:
  - `packages/pa-persistence/src/identity.test.ts` now proves a prelinked layoff candidate email handle is adopted by `claimCandidateProfile`; no second `pa-users` profile is created, and existing `source = WeKruit_Laid_Off` / `layoffContext` is preserved.
- Production Firestore live-equivalent verification:
  - Script: `apps/functions/scripts/layoff-frontdoor-firestore.ts`.
  - Artifact: `.planning/layoff-frontdoor/artifacts/layoff-frontdoor-2026-05-15T21-45-22-745Z.json`.
  - Target candidate: `pa-users/U7AwKT8nLDRa35DkuBxq`, phone `+14243201960`, email `indolencorlol@gmail.com`.
  - Duplicate phone path returned `duplicate: true` and reused `U7AwKT8nLDRa35DkuBxq`.
  - Refresh path wrote full `layoffContext` to the same candidate only; `pa-users` stayed `602 -> 602`.
  - `openSubmitChatTurn` wrote `conversationDerivedPreferences.layoff_onboarding` and `layoffEvidence.latestChatTurn` on `pa-users`.
  - Existing shared resume artifact `candidate_upload_U7AwKT8nLDRa35DkuBxq_e0f213bf9fcb83c33328e2f133b31c7f` exists.
  - Verified employer listing included the refreshed candidate with redacted fields only.
  - The script restored the target `pa-users` doc, phone index, and handle docs on exit; follow-up Firestore check confirmed `pa-users = 602` and no temporary employer docs remained.
- Deployed callable verification:
  - Artifact: `.planning/layoff-frontdoor/artifacts/deployed-open-list-2026-05-15T21-49-46-921Z.json`.
  - A temporary verified employer Firebase Auth user called the deployed `openListLayoffCandidates` callable successfully (`HTTP 200`).
  - The deployed callable listed `U7AwKT8nLDRa35DkuBxq` after a temporary context refresh, proving the deployed query and index work.
  - Cleanup restored the candidate profile and deleted the temporary employer/Auth user.
- Deployment:
  - `openListLayoffCandidates` deployed as Node.js 24, `ACTIVE`, update time `2026-05-15T21:48:42Z`.
  - Deploy predeploy full functions suite passed `1525/1525`.
- Node 24 verification:
  - `node --import tsx --test apps/functions/src/openLayoff.test.ts apps/functions/src/identity/employer-claim-verification.test.ts packages/pa-persistence/src/identity.test.ts` passed `19/19`.
  - `npm run typecheck --workspace=@pa/functions` passed.

## 2026-05-15 Job Lifecycle / Candidate Page Link Verification

- Candidate-facing job pages:
  - `apps/pa-landing/src/pages/PublicJob.tsx` shows the "WeKruit collaborated" badge only when `pa-jobs/{jobId}.wekruitCollaborationStatus === "collaborated"`.
  - `apps/pa-landing/src/pages/Landing.tsx` uses the same data field for home-page job cards.
  - Public page visibility is gated by `pa-jobs/{jobId}.publicVisible`.
- Admin job source of truth:
  - `apps/dashboard-web/src/pages/admin/JobWorkspace.tsx` remains the single edit surface for the locked lifecycle fields:
    - `publicVisible`
    - `candidatePageStatus`
    - `wekruitCollaborationStatus`
  - `apps/dashboard-web/src/pages/external-supply/Jobs.tsx` now exposes a direct "Open candidate page" link for jobs where `publicVisible === true` and `candidatePageStatus === "published"`.
  - Draft/review jobs show "Publish in job workspace" instead of pretending the candidate page is live.
  - External-supply job rows now display lifecycle state and collaboration chips from the same `pa-jobs` fields used by the candidate site.
- Test lock:
  - `apps/dashboard-web/src/pages/external-supply/Jobs.helpers.ts`
  - `apps/dashboard-web/src/pages/external-supply/__tests__/Jobs.test.tsx`
  - `candidateJobPageUrl("rain-software-engineer-fullstack-8849f6ef")` resolves to `https://candidate.wekruit.com/j/rain-software-engineer-fullstack-8849f6ef`.
  - `deriveJobLifecycleDisplay` only returns a live candidate href for published public jobs and only returns `WeKruit collaborated` from `wekruitCollaborationStatus === "collaborated"`.
- Node 24 verification:
  - `node --import tsx --test apps/dashboard-web/src/pages/external-supply/__tests__/Jobs.test.tsx` passed 3/3.
  - `npm run typecheck --workspace=@pa/dashboard-web` passed.
  - `npm test --workspace=@pa/dashboard-web` passed 110/110, including the new Jobs helper test.
  - `npm run build --workspace=@pa/dashboard-web` passed.
- Live Firestore recheck:
  - `pa-jobs where companyId == "rain-xyz"` returned 26 jobs.
  - All 26 Rain jobs have `publicVisible = true`, `candidatePageStatus = "published"`, and `wekruitCollaborationStatus = "not_collaborated"`.
  - The Rain rows therefore show a candidate-page link but no WeKruit-collaborated badge.
- Deployment:
  - First `firebase deploy --only hosting:pa-dashboard` attempt failed at predeploy because the shell lacked `VITE_FIREBASE_*`.
  - Retried with `PA_DASHBOARD_VITE_ENV_FILE=/Users/adam/Desktop/WeKruit/wekruit-pa/apps/dashboard-web/.env.production.local`.
  - `hosting:pa-dashboard` released to `https://wekruit-pa.web.app`.
  - Deployed JS contains `Open candidate page`, `Publish in job workspace`, and `Live candidate page`.

## 2026-05-15 External Supply Existing-Batch Verification

- Root cause fixed:
  - Existing production external records from `runResolveBatchIdentity` had optional fields persisted as `null` (`resolvedUserId`, `resolutionConflictId`, `reviewReasons`).
  - `runEvaluation` and agent research prompt generation parsed those docs with `ExternalCandidateRecordSchema.safeParse` and silently skipped the entire record when optional fields were `null`.
  - `apps/functions/src/external-supply/record-doc.ts` now canonicalizes those Firestore docs at read boundaries.
  - `runResolveBatchIdentity` no longer writes new `null` values for those fields; empty review reasons write as `[]`, and absent optional ids are omitted.
- Test lock:
  - `runEvaluation` now has a regression test proving a production-shaped resolved record with nullable optional fields still evaluates.
  - `runGenerateAgentResearchPrompt` now has a regression test proving the same production-shaped record still renders into an agent research task.
  - `runResolveBatchIdentity` now asserts newly resolved records do not write nullable optional fields.
- Node 24 verification:
  - `node --import tsx --test apps/functions/src/external-supply/evaluate.test.ts apps/functions/src/external-supply/resolve-identity.test.ts apps/functions/src/external-supply/agent-task.test.ts` passed 46/46.
  - `npm run typecheck --workspace=@pa/functions` passed.
  - Firebase deploy predeploy ran the full functions test suite: 1520 passed, 0 failed.
- Live-equivalent production Firestore verification:
  - Script: `apps/functions/scripts/external-supply-existing-batch-verify.ts`.
  - Artifact: `.planning/external-supply-existing-batch/artifacts/verify-ext-rain-backend-engineer-482b165f-2026-05-15T20-01-14-849Z.json`.
  - Existing batch: `pa-external-sourcing-batches/81395d47-3da9-4485-8025-fcdc79a4aa93`.
  - Batch source/job/company: `manual_csv`, `rain-backend-engineer-482b165f`, `rain-xyz`.
  - Records loaded: 45 total, 26 resolved, 19 blocked.
  - Evaluation run: `verify-ext-rain-backend-engineer-482b165f-2026-05-15T20-01-14-849Z`.
  - Evaluation result: processed 26, completed 26, skipped 0.
  - Tier result: 26 `retain_only`, 0 blocked.
  - Outreach plan: `9525c81b-7eb2-40d5-aa99-a525a423b70d`, approved, channel decision `no_outreach`.
  - Mailgun dry-run was blocked because the selected retain-only candidate had no resolvable email recipient.
  - `pa-users` count stayed `602 -> 602`; the script hard-fails if production user count changes.
- Deployment:
  - `paExternalSupplyResolveBatchIdentity` deployed as Node.js 24, `ACTIVE`, update time `2026-05-15T20:05:02Z`.
  - `paExternalSupplyRunEvaluation` deployed as Node.js 24, `ACTIVE`, update time `2026-05-15T20:05:03Z`.
  - `paExternalSupplyGenerateAgentResearchPrompt` deployed as Node.js 24, `ACTIVE`, update time `2026-05-15T20:05:05Z`.

## 2026-05-15 Production User Boundary Recheck

- Firestore facts:
  - `pa-users` live count is `602`.
  - `pa-users where phoneE164 == "+14243201960"` returns exactly one row: `U7AwKT8nLDRa35DkuBxq` / `indolencorlol@gmail.com`.
  - `pa-users where phoneE164 == "+13054507715"` returns zero rows; this is the Claire/Sendblue test number, not the candidate identity allowlist.
- Root cause of the "extra users" concern:
  - The recent UUID `pa-users` rows are not from iMessage or Sendblue allowlist tests.
  - They came from external supply batch `81395d47-3da9-4485-8025-fcdc79a4aa93`, source `manual_csv`, file `lessie_export (2).xlsx`, company `rain-xyz`, job `rain-backend-engineer-482b165f`.
  - That batch has 45 records; 25 LinkedIn-resolvable records became `candidateLifecycleState: prospect` users via the external-supply identity resolver.
  - This follows the locked external-supply model where LinkedIn identity resolves into shared `pa-users`; it is separate from the phone-gated iMessage test path.
- Guardrail added:
  - `apps/functions/scripts/external-supply-prod-smoke.ts` and `apps/functions/scripts/external-supply-v2-prod-smoke.ts` now call `assertProductionPaUserCreationAllowed` before seeding or resolving.
  - These production smoke scripts now refuse to create `pa-users` unless `WEKRUIT_ALLOW_PROD_TEST_USER_CREATE=1` is explicitly set for a cleanup-tracked run.
  - `apps/functions/scripts/__tests__/prod-test-user-guard.test.ts` now checks those external-supply smoke scripts are guarded.
- Node 24 verification:
  - `node --import tsx --test apps/functions/scripts/__tests__/prod-test-user-guard.test.ts` passed 8/8.
  - `pnpm --filter @pa/functions typecheck` passed.

## Remaining Completion Gaps

- WeKruit Open web chat now merges each answer into shared `pa-users` evidence/context and refuses missing/non-layoff profiles. It is still not a full Claire state machine/mem0 conversational path; that remains a separate product integration gap.
- External supply prospects are in the shared `pa-users` pool, and an existing resolved batch is now reverified through candidate-profile evaluation, outreach draft, approval, and `pa-users` no-growth guards. The reply/import-back evidence loop after outreach remains unverified because the selected production-safe plan was `retain_only` / `no_outreach`.
- Job creation/import still appears split across enrichment approval, seeding scripts, and external-supply job surfaces. The old prescreen editor no longer creates jobs or toggles public visibility, but a single canonical job creation/import surface is not yet audited or unified.
- Manual Apple Messages UI retest for the canonical candidate/job prescreen is now re-run and captured below. The remaining gaps are broader product-surface gaps, not the core prescreen runtime boundary.

## 2026-05-16 Current Prescreen Runtime Gap And Fix

Observed regression from live-like fragmented conversation:

- Candidate gave technical evidence and later volunteered logistics such as New York hybrid, compensation range, and no sponsorship need.
- The prescreen pipeline only scored the current question and lost early answers to future hard filters.
- Result: Claire repeated already answered questions, especially location, and a fragmented but recoverable candidate could fail the stress run without terminal state.

Code fix completed on branch `codex/unified-claire-session-evidence`:

- `packages/pa-orchestrator/src/prescreen/pipeline.ts` now consumes positive early answers for future hard filters after the current question passes.
- Only deterministic positive hard-filter signals are consumed: `location_alignment`, `compensation_alignment`, and `sponsorship_status`.
- The pipeline now advances to the next unanswered question instead of blindly stepping to the next index, so consumed hard-filter questions are not re-asked.
- `packages/pa-orchestrator/src/prescreen/__tests__/pipeline.test.ts` adds a regression test for early hard-filter answers carried forward in one turn.

Node 24 regression evidence:

- RED before fix: the new pipeline regression test returned `advance` instead of terminal `PASS`.
- GREEN after fix: `PATH=/Users/adam/.nvm/versions/node/v24.3.0/bin:$PATH pnpm --filter @pa/pa-orchestrator test -- src/prescreen/__tests__/pipeline.test.ts` passed with `1507` tests, `0` failures.

Completion status:

- Production Firestore prescreen stress was re-run across strong pass, adjacent/probed recovery, fragmented multi-message recovery, weak hard-stop, user exit/pause, and new-trigger supersede scenarios.
- `pa-users` count stayed stable and the run used the canonical real-candidate identity only.
- Terminal/session/archive/memory/tag/candidate-job-state/employer-visible results were verified directly in Firestore.
- Runtime safety gates were covered by targeted tests for privacy, abuse, guardian/security, rate limit, job matching, everyday catchup, active-session blocking, suppression/cooldown, and automated outbound send/do-not-send reasoning.
- Changed functions were deployed as Node.js 24.

## 2026-05-16 Prescreen Runtime Stress Verification

Code fixes verified locally:

- `packages/pa-orchestrator/src/prescreen/pipeline.ts` captures positive future hard-filter answers at the start of every turn, even while the current technical/role question is still probing.
- `packages/pa-orchestrator/src/prescreen/pipeline.ts` still re-runs future hard-filter capture after the current question passes, then advances to the next unanswered question.
- `apps/functions/src/prescreen-terminal-action.ts` now archives `PAUSE` sessions to `pa-prescreen-memory-events` without overwriting `pa-users.lastPrescreenMemoryUpdate`, `conversationDerivedPreferences.prescreenEvidenceByJob`, or tags.
- `apps/functions/src/prescreen-terminal-action.ts` no longer derives positive skill tags from the job id or from low-score hard-stop/negative evidence.

Node 24 verification:

- `node --import tsx --test packages/pa-orchestrator/src/prescreen/__tests__/pipeline.test.ts apps/functions/src/prescreen-session-start.test.ts apps/functions/src/prescreen-turn-handler.test.ts apps/functions/src/prescreen-terminal-action.test.ts apps/functions/src/prescreen-outcome-service.test.ts apps/functions/src/coalesce/__tests__/paMessageCoalescer.test.ts` passed `79/79`.
- `pnpm --filter @pa/pa-orchestrator typecheck` passed.
- `pnpm --filter @pa/functions typecheck` passed.

Production Firestore/live-equivalent stress:

- Script: `apps/functions/scripts/prescreen-stress-firestore.ts`.
- Artifact: `.planning/prescreen-stress/artifacts/stress-2026-05-16T06-47-06-635Z.json`.
- Candidate: `pa-users/U7AwKT8nLDRa35DkuBxq`, email `indolencorlol@gmail.com`, phone `+14243201960`.
- Job: `pa-jobs/rain-software-engineer-fullstack-8849f6ef`.
- `pa-users` count stayed `602 -> 602`.
- `failedScenarios = []`; `collectionFailures = []`.
- `activeSessions` for the canonical user after the run: `[]`.

Scenario results:

- `strong_fullstack_pass`: `PASS`, session `ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T064707534Z`, 0 clarifies, terminal turn 5, candidate-job state `employer_visible`, employer-visible profile exists, memory event exists, work session `ended/terminal`.
- `adjacent_probe_recovery`: `PASS`, session `ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T064721057Z`, 4 clarifies, terminal turn 9, candidate-job state `employer_visible`, employer-visible profile exists, memory event exists, work session `ended/terminal`.
- `fragmented_multimessage_pass`: `PASS`, session `ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T064747565Z`, 0 clarifies, terminal turn 5, candidate-job state `employer_visible`, employer-visible profile exists, memory event exists, work session `ended/terminal`.
- `weak_no_engineering_hard_stop`: `HARD_STOP`, session `ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T064759254Z`, 4 clarifies before stop, candidate-job state `not_passed`, no employer-visible profile, memory event exists, work session `ended/terminal`.
- `user_exit_pause`: `PAUSE`, session `ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T064818120Z`, candidate-job state `paused`, no employer-visible profile, memory event exists, work session `ended/user_exit`.
- `new_trigger_supersedes_active_prescreen`: first session `ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T064820184Z` ended with `PAUSE`, work session `ended/superseded`, superseded by `ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T064820575Z`.

Direct Firestore memory/tag verification after the final stress run:

- `pa-prescreen-memory-events` exists for all five scenario sessions.
- The PAUSE event stores `summary = "stop"` only in its session memory event and does not overwrite `pa-users.lastPrescreenMemoryUpdate`.
- `pa-users/U7AwKT8nLDRa35DkuBxq.lastPrescreenMemoryUpdate` points to the latest non-pause terminal session, `weak_no_engineering_hard_stop`, with `evidenceTags = ["job_prescreen"]`.
- The weak hard-stop no longer writes false positive `software_engineering` or `fullstack_engineering` evidence tags from job id or negative statements.

Broader runtime regression tests:

- Safety/privacy/abuse/guardian/rate-limit:
  - `node --import tsx --test apps/functions/src/sendblue/__tests__/webhook.test.ts packages/pa-orchestrator/src/allowlist.test.ts packages/pa-orchestrator/src/__tests__/safety-gate-integration.test.ts packages/pa-orchestrator/src/guardrails/__tests__/input.test.ts packages/pa-orchestrator/src/guardrails/__tests__/output.test.ts packages/pa-orchestrator/src/guardrails/__tests__/chain.test.ts` passed `75/75`.
- Lifecycle/everyday catchup/automated outbound:
  - `node --import tsx --test apps/functions/src/outreach/__tests__/service.test.ts apps/functions/src/outreach/__tests__/admin.test.ts apps/functions/src/__tests__/candidate-lifecycle-trigger.test.ts apps/functions/src/proactive-sweep.test.ts packages/pa-orchestrator/src/proactive-turn.test.ts` passed `31/31`.
- Job matching/client-job conversation feedback/admin match debug:
  - `node --import tsx --test apps/functions/src/job-rec/__tests__/recruiter-flow.test.ts apps/functions/src/job-rec/__tests__/match-feedback.test.ts apps/functions/src/job-rec/__tests__/policy.test.ts apps/functions/src/orchestrator-deps.test.ts apps/functions/src/__tests__/admin-match-debug.test.ts` passed `69/69`.

Deploy verification:

- `firebase deploy --only functions:pa-orchestrator:paSendblueWebhook,functions:pa-orchestrator:onPaInbound,functions:pa-orchestrator:paMessageCoalescer --project wekruit-5f89b` completed successfully.
- Firebase predeploy full functions test suite passed `1558/1558`.
- `gcloud functions describe paSendblueWebhook --gen2 --region=us-central1 --project=wekruit-5f89b` returned `state = ACTIVE`, `buildConfig.runtime = nodejs24`, `updateTime = 2026-05-16T06:53:49.781185045Z`.

## 2026-05-16 Live Apple Messages Retest

Runtime fixes deployed on 2026-05-16:

- `apps/functions/src/index.ts` now lets active prescreen routing run before layoff onboarding ownership on the non-coalesced webhook path.
- `apps/functions/src/coalesce/paMessageCoalescer.ts` now lets active prescreen routing run before layoff onboarding ownership on the coalesced path.
- `apps/functions/src/lib/pre-claire-turn-owner.ts` centralizes the routing priority contract: active prescreen first, then layoff onboarding, then generic Claire.
- `apps/functions/src/prescreen-turn-handler.ts` no longer depends on a `createdAt` composite index to find the active session; it sorts matching active sessions by `updatedAt` / `createdAt` in memory.

Node 24 local verification before deploy:

- `node --import tsx --test apps/functions/src/lib/pre-claire-turn-owner.test.ts apps/functions/src/coalesce/__tests__/paMessageCoalescer.test.ts apps/functions/src/prescreen-turn-handler.test.ts` passed `42/42`.
- `pnpm --filter @pa/functions typecheck` passed.

Targeted deploy/runtime verification:

- `firebase deploy --only functions:pa-orchestrator:paSendblueWebhook,functions:pa-orchestrator:onPaInbound,functions:pa-orchestrator:paMessageCoalescer --project wekruit-5f89b`
- `gcloud functions describe paSendblueWebhook --gen2 --region=us-central1 --project=wekruit-5f89b` → `ACTIVE`, `nodejs24`, `512Mi`
- `gcloud functions describe paMessageCoalescer --gen2 --region=us-central1 --project=wekruit-5f89b` → `ACTIVE`, `nodejs24`, `512Mi`
- `gcloud functions describe onPaInbound --gen2 --region=us-central1 --project=wekruit-5f89b` → `ACTIVE`, `nodejs24`, `1024Mi`

Canonical live test identity:

- Candidate: `pa-users/U7AwKT8nLDRa35DkuBxq`
- Email: `indolencorlol@gmail.com`
- Sender thread: `+13054507715`
- Job: `pa-jobs/rain-software-engineer-fullstack-8849f6ef`

Live sequence and observed evidence:

- Before the fix, the active prescreen session `ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T130843997Z` was open on `currentQId = role_fit`, but a real engineering answer in Messages got routed back to layoff onboarding and produced `city / region / or just 'remote' is fine`.
- After deploy, the same live thread accepted a new real engineering reply:
  - `Closest fullstack overlap I owned OFO Delivery’s merchant dashboard and dispatch tooling...`
  - Firestore turn written under `pa-prescreen-sessions/ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T130843997Z/turns/tWIWxQvDQAY75sodgIbO`
  - Action: `clarify`
  - No layoff/location takeover
- Claire then replied in Messages with a role-fit probe, not an onboarding/location question:
  - `Got it - when you say you owned the merchant dashboard + dispatch tooling at OFO Delivery, what was the specific problem you were solving ... and what did you personally build/change ... ?`
- A second real reply describing the concrete problem, stack, and ops impact advanced the same session:
  - Firestore turn `K9i2RuL7nnY4PfQnoYn4`
  - Action: `advance`
  - Session moved to `currentQId = technical_depth`
  - Session score reached `0.92`
- Claire then asked the next real technical question in Messages:
  - `Which required skill are you strongest in, and what is a concrete example of using it?`

Live session end/archive verification:

- Sending real `PAUSE` in Messages ended the active session:
  - Session `ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T130843997Z`
  - `terminal = PAUSE`
  - `currentQId = null`
  - `workSession.boundary = user_exit`
  - `workSession.status = ended`
- Claire sent the pause acknowledgement in Messages:
  - `Got it — I paused this role screen. If you want to continue later, reopen it from the job page; I will keep what you have already shared on your profile.`
- The session archive exists in `pa-prescreen-memory-events/{sessionId}`:
  - `pa-prescreen-memory-events/ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T130843997Z`
  - `terminal = PAUSE`
  - `summary = "Owned fullstack merchant dashboard/dispatch tooling; built React+TS UI, Node APIs, SQL/debug workflows."`
  - `recentReplies` contains the real role-fit answer, the real impact/technical answer, and `PAUSE`
- `pa-users/U7AwKT8nLDRa35DkuBxq.lastPrescreenMemoryUpdate` stayed pointed at the prior non-pause terminal session, which confirms the pause archive did not overwrite long-term profile memory.

Live restart / fresh-session verification:

- Re-sending the exact trigger `WeKruit_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_Job` in the same Messages thread created a fresh session:
  - New session: `ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T133034229Z`
  - `terminal = null`
  - `currentQId = role_fit`
  - `workSession.boundary = trigger`
  - `workSession.status = active`
- The old paused session remained paused and did not catch the new trigger.
- Claire restarted from the correct first prescreen opener in Messages:
  - `Hi — Claire from Rain. Quick screen for Software Engineer - Fullstack. What recent work best matches this software engineering role?`

Live runtime conclusion:

- The real iMessage path now honors `active prescreen > layoff onboarding > generic Claire`.
- Real multi-turn prescreen evidence is stored in `pa-prescreen-sessions/{sessionId}/turns`.
- Real pause/archive behavior works without corrupting long-term candidate profile memory.
- A fresh trigger after pause creates a new independent prescreen session.
- `gcloud functions describe onPaInbound --gen2 --region=us-central1 --project=wekruit-5f89b` returned `state = ACTIVE`, `buildConfig.runtime = nodejs24`, `updateTime = 2026-05-16T06:53:47.909174235Z`.
- `gcloud functions describe paMessageCoalescer --gen2 --region=us-central1 --project=wekruit-5f89b` returned `state = ACTIVE`, `buildConfig.runtime = nodejs24`, `updateTime = 2026-05-16T06:53:48.286404118Z`.

## 2026-05-16 Job Prescreen Editor Flow Consolidation

- `apps/dashboard-web/src/pages/JobPrescreen.tsx` now reads `/admin/jobs/:jobId/prescreen` route params and opens the selected job directly.
- The prescreen editor no longer shows the legacy `Create new job` form.
- The prescreen editor no longer writes top-level `pa-jobs.title`, `pa-jobs.company`, or `pa-jobs.publicVisible`.
- Publishing, unpublishing, candidate page lifecycle, and `wekruitCollaborationStatus` remain owned by `/admin/jobs/:jobId`.
- Node 24 verification:
  - `pnpm --filter @pa/dashboard-web typecheck` passed.
  - `pnpm --filter @pa/dashboard-web test` passed 111/111, including the prescreen-editor lifecycle boundary regression.
  - `PA_DASHBOARD_VITE_ENV_FILE=/Users/adam/Desktop/WeKruit/wekruit-pa/apps/dashboard-web/.env.production.local pnpm --filter @pa/dashboard-web build` passed.
