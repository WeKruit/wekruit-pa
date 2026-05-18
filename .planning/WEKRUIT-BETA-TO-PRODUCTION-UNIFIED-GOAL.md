# WeKruit Beta To Production Unified Goal

Execute one unified product readiness goal: make WeKruit usable for controlled business beta, then close the remaining beta-to-production gaps.

This supersedes scattered partial goals and should use these files as input:

- `.planning/AGENT-HARNESS-PRODUCTION-GAPS.md`
- `.planning/AGENT-HARNESS-BETA-TO-PRODUCTION-GOAL.md`
- `.planning/CLAIRE-LIVE-RUNTIME-TEST-EVIDENCE.md`
- `.planning/V2-CLAIRE-UNIFIED-CANDIDATE-PRODUCT-GOAL.md`

Core product question:

- WeKruit must be usable beyond the layoff intake.
- A business tester should be able to create/find a job, send a candidate through candidate web + resume + iMessage pre-screen, and then see a clear job-scoped result in admin.
- Do not call the product beta-ready from backend tests alone. Completion requires customer-visible web/iMessage proof plus Firestore/admin proof.

## Required User Flows

### 1. Candidate Web Flow

Verify and fix:

- `https://candidate.wekruit.com/` shows a coherent candidate home with public/open jobs.
- Public job detail pages use the same visual/product pattern as home.
- Job detail has a clear path to start the screen.
- Google login returns to the intended job page.
- LinkedIn login returns to the intended job page.
- Logged-in user is resolved to the correct `pa-users/{uid}`.
- If the user has no usable parsed resume, the page blocks iMessage unlock and asks for resume upload first.
- Resume upload accepts valid PDF/DOCX, rejects invalid/oversized files with clear UI, and shows every step: uploading, parsing, enriching, ready/error.
- Resume parsing writes canonical `parsedCandidateResumes`.
- Resume enrichment writes canonical user evidence/tags through the same `pa-users` path used by iMessage.
- Profile page must not hang forever; it must show profile state, missing resume state, or a recoverable error.

### 2. iMessage Conversation Flow

Live test and fix:

- Normal onboarding.
- Layoff onboarding.
- Generic onboarding questions and random process questions such as "are you legit?".
- Job pre-screen strong PASS.
- Job pre-screen adjacent/probing PASS.
- Job pre-screen weak HARD_STOP only after repeated probing.
- PAUSE/STOP/START behavior.
- Privacy/export/delete-memory questions.
- Job recommendation request and post-terminal job recommendations.
- Every job recommendation must include job URL and requirements.
- Conversation must read like Claire is a professional friend probing candidate experience, not a brittle form or abrupt evaluator.

### 3. Job-Scoped Admin Result Flow

Verify and fix:

- On pre-screen PASS, the system writes `pa-candidate-job-states/{uid}__{jobId}`.
- PASS transitions the job state to `employer_visible`.
- PASS creates or refreshes `pa-employer-visible-profiles/{jobId}__{uid}`.
- The state points to the latest `prescreenSessionId`.
- `/admin/passed-candidates?jobId=<jobId>` shows the passed candidate.
- The admin view includes enough context for business users: candidate identity, job, pass status, pass reason, transcript summary, key answers/evidence, resume/profile link or summary, and timestamp.
- The admin view must not expose non-passed candidates in employer-visible surfaces.
- If the dashboard is too sparse or confusing, build the missing admin UI rather than accepting Firestore-only proof.

### 4. Admin Job / Public Job Consistency

Verify and fix:

- Admin-created/public jobs and candidate-visible jobs share one canonical data path.
- Public visibility and WeKruit-collaborated badge are data-driven, not hardcoded.
- Wekruit-collaborated and non-collaborated jobs use the same base job schema and rendering pattern.
- Job creation/seeding/import paths must converge into the same `pa-jobs` shape used by candidate web, matching, pre-screen, and admin.
- Dashboard should make it obvious which jobs are public, which are collaborated, and which have passed candidates.

### 5. Stress, Safety, And Runtime Proof

Run and record:

- Node 24 full relevant tests for functions, orchestrator, agent-runtime, safety, candidate web, and dashboard.
- Staging Artillery stress: inbound burst, upstream webhook flood, downstream fire.
- Prescreen Firestore stress: strong PASS, adjacent PASS, fragmented PASS, weak HARD_STOP, PAUSE.
- Safety/guardian checks: prompt injection, privacy, illegal content flag state, rate abuse flag state, opt-out suppression, allowlist/quota, no tapback on blocked/privacy/suppressed turns.
- Confirm no duplicate sends, no stuck buffers, no stuck work sessions, no missing terminal archives, and no job recommendations without links.

## Execution Rules

- Start by syncing/merging latest `main` into the active branch. Do not deploy from stale voice/runtime branches.
- Use Node 24 for every local test/build/deploy.
- Prefer parallel verification where safe:
  - Web auth/resume flow.
  - iMessage live matrix.
  - Firestore/admin state proof.
  - Stress/safety scripts.
  - Dashboard UI verification.
- Stop and debug at the first customer-visible divergence.
- Fix, test, deploy, then rerun the failing path.
- Verify Firestore directly, but do not use Firestore-only proof as final completion for customer-facing flows.
- Deploy directly after code changes.
- Merge/push all fixes and evidence docs to `main`.

## Completion Evidence

Update this goal or a linked evidence doc with:

- Exact test commands and results.
- Browser URLs tested.
- iMessage transcript summaries.
- Firestore document paths.
- `pa-outbound` ids.
- `pa-prescreen-sessions` ids.
- `pa-candidate-job-states` ids.
- `pa-employer-visible-profiles` ids.
- Dashboard screenshots or route evidence if used.
- Deploy commands.
- Commit SHAs merged to `main`.

## Done Definition

This is done only when:

- A controlled business tester can complete the full candidate web + resume + iMessage flow.
- A passed candidate appears clearly in admin for the specific job.
- Layoff, normal onboarding, and job pre-screen flows all use the same session/memory/state discipline.
- Job recommendations always include URL and requirements.
- Resume parsing/enrichment is verified end to end.
- Public/collaborated job state is data-driven.
- Stress/safety gates pass or any blockers are fixed.
- Dashboard is good enough for a non-engineer operator to understand what happened.
- Evidence is documented.
- Code is deployed and merged to `main`.
