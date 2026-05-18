# Agent Harness Beta To Production Goal

Execute the remaining beta-to-production hardening work for the Claire/WeKruit agent harness.

Primary reference:

- `.planning/AGENT-HARNESS-PRODUCTION-GAPS.md`

Scope:

1. Verify the current deployed `main` flow before changing code.
   - Confirm the active deploy includes latest `main`.
   - Confirm no stale voice/runtime branch can overwrite the current Claire iMessage/runtime fixes.
   - Use Node 24 for every local script/test/build/deploy command.

2. Re-test the candidate website flow end to end.
   - Candidate web job page loads from `candidate.wekruit.com`.
   - Login via Google and LinkedIn returns to the intended job page.
   - Resume gate works after login.
   - Resume upload accepts valid PDF/DOCX and rejects invalid/oversized files with clear UI.
   - Resume parsing writes canonical `parsedCandidateResumes` state.
   - Parsed resume updates/links the correct `pa-users/{uid}` by email/LinkedIn/phone identity.
   - Resume enrichment/tags are written through the same canonical user/tag path used by iMessage.
   - Candidate cannot unlock iMessage pre-screen until required resume parse/enrichment state is ready.

3. Re-test live iMessage flows with Firestore proof.
   - Normal onboarding.
   - Layoff onboarding.
   - Job prescreen strong PASS.
   - Job prescreen adjacent/probing PASS.
   - Job prescreen weak HARD_STOP after repeated probing.
   - PAUSE/STOP/START.
   - Job recommendation request and post-terminal job recommendations, always including job URL and requirements.
   - Privacy/export/delete-memory questions.
   - Random/off-topic questions during onboarding and prescreen.

4. Run stress and concurrency gates.
   - Run `apps/stress` staging Artillery scenarios: inbound burst, upstream webhook, downstream fire.
   - Run `apps/functions/scripts/prescreen-stress-firestore.ts` against the intended environment with outbound SMS stubbed unless explicitly approved.
   - Record p50/p95/p99, 2xx/429/5xx, Firestore transaction errors, duplicate sends, queue lag, and any stuck sessions.

5. Verify safety, privacy, and suppression gates.
   - Prompt injection.
   - Illegal content flag state.
   - Rate abuse flag state.
   - Stop/opt-out suppression.
   - Allowlist/quota behavior.
   - No tapback or extra outbound on blocked/privacy/suppressed turns.

6. Verify operator observability.
   - Dashboard or documented Firestore view must show: session owner, current question/state, last user message, last Claire message, terminal state, safety blocks, memory writes, job-rec sends, resume parse state, and outbound delivery status.
   - If dashboard is insufficient, either fix it or document exact Firestore inspection commands as an interim beta runbook.

7. Produce a final beta-to-production evidence report.
   - Update `.planning/AGENT-HARNESS-PRODUCTION-GAPS.md` with DONE/BLOCKED status per item.
   - Add exact evidence IDs: Firestore doc paths, outbound IDs, session IDs, screenshots if used, logs, test commands, deploy command, and commit SHAs.
   - Do not mark production-ready from tests alone; live customer-visible flows plus Firestore proof are required.

Completion criteria:

- All beta-critical user flows are live-tested or explicitly marked blocked with root cause.
- Website submission and resume parsing are verified end to end.
- Live iMessage conversations read naturally to a business tester.
- Job recommendations always include URL and requirements.
- Stress/concurrency gates pass or blockers are fixed.
- Safety/privacy/suppression gates are verified.
- Evidence docs are updated.
- Fixes are deployed with Node 24.
- All changes are merged/pushed to `main`.
