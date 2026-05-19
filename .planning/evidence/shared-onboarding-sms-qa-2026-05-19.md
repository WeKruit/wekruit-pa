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
