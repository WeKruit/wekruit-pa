# Shared onboarding SMS QA - 2026-05-19

Goal: verify production shared onboarding over SMS/iMessage after duplicate greeting and resume-grounding fix.

## Code/Deploy Evidence
- Deployment target: functions:pa-orchestrator:onPaInbound, functions:pa-orchestrator:paSendblueWebhook
- Fixes shipped:
  - Shared onboarding active replies are now judge-gated. Duplicate greetings and kickoff strings do not become answers or advance `currentQuestionId`.
  - Active `shared_onboarding` SMS turns now use the Sendblue coalescer before orchestrator judging, matching the prescreen multi-message pattern.
  - Shared onboarding Q1 resume grounding now follows `pa-users.latestResumeArtifactId -> pa-resume-artifacts/{id}.parsedCandidateResumeId -> parsedCandidateResumes/{id}` before falling back to latest parsed resume by `userId`.
  - If the parsed resume pointer is stale or missing, shared onboarding now falls back to the resume artifact profile summary so Q1 can still ground on recent title/company.
  - Post-batch production bug fix: `createFirestoreOrchestratorStore().getOnboardingUser()` now exposes `latestResumeArtifactId`, `firstName`, `jobTitle`, `lastCompany`, and `location`. Without this projection fix, the production bootstrap path could not see the resume pointer even though the resume loader was correct.
- Automated verification:
  - `pnpm --filter @pa/pa-orchestrator exec node --import tsx --test src/__tests__/onboarding-intent-ack.test.ts src/__tests__/shared-onboarding.test.ts` -> 65/65 pass.
  - `pnpm --filter @pa/pa-orchestrator exec node --import tsx --test src/index.test.ts src/__tests__/onboarding-intent-ack.test.ts src/__tests__/shared-onboarding.test.ts` -> 127/127 pass.
  - `pnpm --filter @pa/pa-orchestrator typecheck` -> pass.
  - `pnpm --filter @pa/pa-orchestrator test` -> 1597/1597 pass.
  - `pnpm --dir apps/functions exec node --import tsx --test src/__tests__/layoff-sms-start.test.ts src/sendblue/__tests__/webhook.test.ts` -> 37/37 pass.
  - `pnpm --dir apps/functions typecheck` -> pass.
  - Firebase functions predeploy during deploy -> functions test suite 1708/1708 pass.
  - `git diff --check` -> pass.
- Deploy result:
  - `onPaInbound(us-central1)` successful update.
  - `paSendblueWebhook(us-central1)` successful update.
  - Function URL: `https://pasendbluewebhook-evm6xq7jyq-uc.a.run.app`.
  - Final targeted deploy after the artifact-summary robustness patch completed successfully for both functions.
  - Final targeted deploy after the Firestore store projection fix completed successfully for both functions.
- Post-deploy function list:
  - `onPaInbound`: Gen2, us-central1, 1024 MiB, nodejs24.
  - `paSendblueWebhook`: Gen2, us-central1, 512 MiB, nodejs24.

## Production Firestore Read-Only Check

- User: `pa-users/UThMpnAGzjaWnxDsKEMH`
- Phone: `+14243201960`
- `latestResumeArtifactId`: `candidate_upload_UThMpnAGzjaWnxDsKEMH_03ebee96e6371ed72895665d450219ff`
- Runtime resume loader result: `parsedLoaded=true` from artifact summary fallback.
- Prompt context:
  - `recentTitles=["Software Engineer Intern"]`
  - `recentCompanies=["Tesla Inc"]`
  - `skills=["c++","java","javascript","python"]`
- Built Q1:
  - `Hey Adam, I saw from your resume that you've done Software Engineer Intern work at Tesla Inc. For this next phase, what matters most in your next company: career growth, compensation, stability, mission, learning, or something else?`

## Live Conversation Runs

Pending explicit operator confirmation before sending scripted iMessage/SMS traffic from Adam's Messages app.

### Pending Messages.app Smoke Script

Status: blocked on action-time confirmation before sending real iMessages from Adam's Mac.

Target user/phone:
- `pa-users/UThMpnAGzjaWnxDsKEMH`
- `+14243201960`

Script to run after confirmation:
1. Send `__PA_RESET__`.
2. Wait for reset confirmation or verify Firestore cleanup.
3. Send `Hello, WeKruit!`.
4. Verify visible Q1 is resume-grounded with `Software Engineer Intern` and `Tesla Inc`.
5. Send duplicate `Hello, WeKruit!`.
6. Verify Q2 does not fire and `sharedOnboarding.currentQuestionId` remains `main_goal`.
7. Send `Career growth and learning matter most, with compensation as a close second.`
8. Verify Q2 asks the culture/stage question.
9. Send an irrelevant/greeting-like answer such as `hi` or `what?`.
10. Verify the current question is re-asked or clarified and no `culture_stage` answer is recorded.
11. Continue with real answers through Q5.
12. Verify two job recommendations are returned.
13. Send one normal post-onboarding chat turn.
14. Verify Claire replies in normal chat mode without internal tokens and without reviving onboarding.
15. Verify Firestore: `workSession.kind=shared_onboarding` during onboarding, completed shared-onboarding answers and tags/stated preferences at completion, no legacy `layoff_onboarding`, no `q_email`, no premature advancement.

Confirmation phrase needed before sending:
- `Yes, send the Messages.app smoke to +14243201960`

## Final Audit - 2026-05-19 11:58 UTC

- Branch/PR:
  - Branch: `claude/ecstatic-swartz-954e33`
  - HEAD: `8e250b1 Verify shared onboarding SMS production path`
  - PR: `https://github.com/WeKruit/wekruit-pa/pull/114`
  - PR state: open, ready for review, mergeable.
- GitHub checks on PR #114:
  - `typecheck + unit tests`: success.
  - `v1.5 QA team (4 agents × 8 personas × bilingual)`: success.
  - CodeQL `Analyze (actions)`: success.
  - CodeQL `Analyze (javascript-typescript)`: success.
  - CodeQL `Analyze (python)`: success.
  - CodeQL aggregate check: success.
- Production artifact re-read:
  - Re-read all passed shared-onboarding batch artifacts and validated their internal invariants.
  - Counted `216` passed onboarding conversations, `10` complete onboarding -> job-rec -> normal-chat conversations, and `1120` unique inbound event IDs.
  - Re-read all `1120` inbound event IDs from production Firestore; all were `succeeded` or `completed`.
  - Queried `pa-outbound` for matching `outbound-{eventId}` idempotency keys; found `0`.
- Production runtime state:
  - `onPaInbound`: Gen2, us-central1, nodejs24, 1024 MiB, `maxInstances=1`.
  - `paSendblueWebhook`: Gen2, us-central1, nodejs24, 512 MiB, `maxInstances=1`.
  - `pa-users/UThMpnAGzjaWnxDsKEMH` cleanup state: `onboardingState=pending`, `onboardingStatus=invited`, `sharedOnboarding=null`, `workSession=null`, `latestResumeArtifactId` preserved as `candidate_upload_UThMpnAGzjaWnxDsKEMH_03ebee96e6371ed72895665d450219ff`.
- Remaining unproven surface:
  - Actual local Messages.app transcript is still pending because sending real iMessages from Adam's account requires action-time confirmation under the Computer Use policy.

## Continuation Audit - 2026-05-19 12:17 UTC

- Current repo state:
  - Worktree: `/Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/ecstatic-swartz-954e33`
  - Local branch: `claude/ecstatic-swartz-954e33`
  - Local HEAD: `0ac3cb2243e4ecb1fbdeb69c211d0ef72d0c7129`
  - `origin/main`: `9b097a771e764832c5bd6d5ff445f64f7c7636b9`
  - PR #114 is merged into `main` at `9b097a771e764832c5bd6d5ff445f64f7c7636b9`.
- Current live function state from `firebase functions:list --project wekruit-5f89b --json` under Node 24:
  - `onPaInbound`: `nodejs24`, Gen2, us-central1, 1024 MiB, `maxInstances=1`, `state=ACTIVE`, hash `ebbdfc791153300b1ba0627076c657535f3373b4`.
  - `paSendblueWebhook`: `nodejs24`, Gen2, us-central1, 512 MiB, `maxInstances=1`, `state=ACTIVE`, hash `dc67428d556370dd3eb5013955e0813299bb070f`.
- Current production user state from Firestore:
  - `pa-users/UThMpnAGzjaWnxDsKEMH` exists.
  - `phoneE164=+14243201960`.
  - `onboardingState=pending`.
  - `onboardingStatus=invited`.
  - `latestResumeArtifactId=candidate_upload_UThMpnAGzjaWnxDsKEMH_03ebee96e6371ed72895665d450219ff`.
  - `sharedOnboarding=null`.
  - `workSession=null`.
  - `testMode=true`.
- Current test rerun:
  - `source ~/.zshrc && nvm use 24 && pnpm --filter @pa/pa-orchestrator exec node --import tsx --test src/index.test.ts src/__tests__/onboarding-intent-ack.test.ts src/__tests__/shared-onboarding.test.ts` -> 127/127 pass.
- Current artifact re-read:
  - Passed shared-onboarding artifacts total `216` conversations, `10` full onboarding -> job rec -> normal chat completions, `1120` turns, `904` assistant replies, `0` failed conversations in the passed artifact set.
  - `prescreen-batch-2026-05-19T07-56-44-140Z` still shows `sentCount=20`, `userRestored=true`, and cleanup rows with `terminal=PAUSE`, `currentQId=null`.
  - `sbmatrix-2026-05-19T07-54-05-446Z` still shows all four entrypoint cases passed.
- Remaining unproven surface:
  - Actual local Messages.app transcript remains the only blocked acceptance item. It requires action-time confirmation before sending from Adam's Mac.

## Production Shared-Onboarding SMS Batch

- Script: `apps/functions/scripts/shared-onboarding-sms-batch.ts`
- Driver: worker-shaped iMessage rows written to production `pa-inbound-events` with `rawPayload.harness.suppressOutbound=true`.
- User/phone: `pa-users/UThMpnAGzjaWnxDsKEMH`, `+14243201960`
- Safety boundary: no `pa-outbound` rows allowed for harness events; assistant replies are recorded in `pa-messages`.
- Cleanup boundary: each scenario resets only the top-level onboarding/work-session state; final restore mode `clean` leaves `sharedOnboarding=null`, `workSession=null`, `onboardingState=pending`, `onboardingStatus=invited`, and preserves `latestResumeArtifactId`.

### Batch Findings

- `shared-onboarding-sms-batch-2026-05-19T08-07-08-048Z`: failed 1/1 before the projection fix. Q1 was not resume-grounded because production `getOnboardingUser()` did not expose `latestResumeArtifactId`; duplicate greeting and later state gating still worked.
- `shared-onboarding-sms-batch-2026-05-19T08-16-15-122Z`: failed because the harness expected the exact deterministic re-ask wording; production correctly stayed on `culture_stage` and returned short LLM judge clarifications like "Could you tell me more about your company culture and stage?"
- Unpaced 50-run attempt hit the real inbound safety guard (`inbound_safety_block`, user-visible text "You're sending a bit too fast"). This is expected SMS anti-spam behavior, so all larger runs below use pacing.

### Passed Batch Artifacts

- `shared-onboarding-sms-batch-2026-05-19T08-15-03-867Z`: 1/1 passed, completeCount=1, totalTurns=9, assistantReplies=8.
- `shared-onboarding-sms-batch-2026-05-19T08-18-26-620Z`: 5/5 passed, completeCount=2, totalTurns=33, assistantReplies=28.
- `shared-onboarding-sms-batch-2026-05-19T08-26-35-905Z`: 10/10 passed, completeCount=2, totalTurns=58, assistantReplies=48, paced at 6000ms/turn + 10000ms/conversation.
- `shared-onboarding-sms-batch-2026-05-19T08-37-32-166Z`: 50/50 passed, completeCount=5, totalTurns=270, assistantReplies=220, paced at 6000ms/turn + 10000ms/conversation.
- `shared-onboarding-sms-batch-2026-05-19T09-26-57-033Z`: 150/150 passed, completeCount=0, totalTurns=750, assistantReplies=600, paced at 6000ms/turn + 10000ms/conversation.
- Total recorded passed onboarding conversations: 216.
- Full onboarding -> 2 job recs -> normal post-onboarding chat completions: 10.
- Repeated invariants verified across the batch:
  - Q1 is grounded in Adam's resume: `Software Engineer Intern` at `Tesla Inc`.
  - Duplicate `Hello, WeKruit!` at Q1 records no answer and does not advance.
  - Real Q1 answers advance to `culture_stage`.
  - Greeting/irrelevant Q2 replies re-ask and do not record `culture_stage`.
  - Real Q2 answers advance to `industry_interest`.
  - Complete scenarios save all five answers, tag/statedPreference snapshots, and return two job recommendations.
  - Normal chat after completed onboarding returns a non-empty persona-consistent answer without internal tokens.
  - Suppressed harness events created no matching `pa-outbound` rows.

## Production Sendblue Entrypoint Matrix

- Script: `apps/functions/scripts/sendblue-entrypoint-matrix-firestore.ts`
- Run: `sbmatrix-2026-05-19T07-54-05-446Z`
- Artifact: `.planning/sendblue-entrypoint-matrix/artifacts/sbmatrix-2026-05-19T07-54-05-446Z.json`
- User/phone: `pa-users/UThMpnAGzjaWnxDsKEMH`, `+14243201960`
- Result: pass.
- Covered:
  - `WeKruit_rain-software-engineer-fullstack-8849f6ef_UThMpnAGzjaWnxDsKEMH_Job` routed to prescreen start.
  - Raw `WeKruit_LAID_OFF` source token remained suppressed/unauthorized and did not mutate the user source.
  - Normal `START` fell through to `pa-inbound-events` with `harness.suppressOutbound=true`.
  - ATS pending invite `START` routed to prescreen and consumed the invite.
- Cleanup proof:
  - Created prescreen sessions `ps_rain-software-engineer-fullstack-8849f6ef_UThMpnAGzjaWnxDsKEMH_20260519T075407066Z` and `ps_rain-software-engineer-fullstack-8849f6ef_UThMpnAGzjaWnxDsKEMH_20260519T075415630Z`.
  - Both are ended with `terminal=PAUSE`, `currentQId=null`, `terminalReason=sendblue_matrix_cleanup`.
  - The normal `START` inbound has `rawPayload.harness.suppressOutbound=true`; matching `pa-outbound` count is `0`.

## Production Prescreen Start Batch

- Run: `prescreen-batch-2026-05-19T07-56-44-140Z`
- Artifact: `.planning/sendblue-prescreen-start-batch/artifacts/prescreen-batch-2026-05-19T07-56-44-140Z.json`
- User/phone: `pa-users/UThMpnAGzjaWnxDsKEMH`, `+14243201960`
- Exact trigger body: `WeKruit_rain-software-engineer-fullstack-8849f6ef_UThMpnAGzjaWnxDsKEMH_Job`
- Result: 20/20 prescreen starts passed through production Sendblue webhook routing with outbound SMS sends stubbed.
- Cleanup proof:
  - `sentCount=20`, all stubbed.
  - `userRestored=true`.
  - All 20 created `pa-prescreen-sessions` were re-read after cleanup; `bad=[]`.
  - Each checked session has `terminal=PAUSE`, `currentQId=null`, `workSession.status=ended`.
