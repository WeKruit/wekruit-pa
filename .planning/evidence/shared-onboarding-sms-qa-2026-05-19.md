# Shared onboarding SMS QA - 2026-05-19

Goal: verify production shared onboarding over SMS/iMessage after duplicate greeting and resume-grounding fix.

## Code/Deploy Evidence
- Deployment target: functions:pa-orchestrator:onPaInbound, functions:pa-orchestrator:paSendblueWebhook
- Fixes shipped:
  - Shared onboarding active replies are now judge-gated. Duplicate greetings and kickoff strings do not become answers or advance `currentQuestionId`.
  - Active `shared_onboarding` SMS turns now use the Sendblue coalescer before orchestrator judging, matching the prescreen multi-message pattern.
  - Shared onboarding Q1 resume grounding now follows `pa-users.latestResumeArtifactId -> pa-resume-artifacts/{id}.parsedCandidateResumeId -> parsedCandidateResumes/{id}` before falling back to latest parsed resume by `userId`.
  - If the parsed resume pointer is stale or missing, shared onboarding now falls back to the resume artifact profile summary so Q1 can still ground on recent title/company.
- Automated verification:
  - `pnpm --filter @pa/pa-orchestrator exec node --import tsx --test src/__tests__/onboarding-intent-ack.test.ts src/__tests__/shared-onboarding.test.ts` -> 65/65 pass.
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
  - Final targeted deploy after the artifact-summary robustness patch also completed successfully for both functions.
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
