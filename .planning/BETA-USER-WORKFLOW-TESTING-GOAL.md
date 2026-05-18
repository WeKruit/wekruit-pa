# Beta User Workflow Testing Goal

Execute controlled beta-user testing for WeKruit with one or more business/internal testers, focused on realistic candidate behavior and operator confidence.

References:

- `.planning/AGENT-HARNESS-PRODUCTION-GAPS.md`
- `.planning/AGENT-HARNESS-BETA-TO-PRODUCTION-GOAL.md`

Isolation rules:

- Use allowlisted beta testers only.
- Use known beta phone numbers and emails; do not reuse the new-user test identity from `.planning/NEW-USER-E2E-WORKFLOW-GOAL.md`.
- Keep each tester's workflow independent: separate email, phone, user id, resume, and job/prescreen session.
- Use Node 24 for every local script/test/build/deploy command.
- Verify live user-visible behavior plus Firestore. Do not call a beta flow done from backend tests alone.

Scope:

1. Beta tester setup.
   - Confirm tester email, phone, consent, and test role.
   - Confirm tester is allowlisted and not suppressed/opted out.
   - Confirm Sendblue sender and quota are healthy before the run.
   - Confirm active deploy is based on latest `main`.

2. Existing-user and returning-user paths.
   - Tester with existing resume/profile signs in.
   - Tester without resume signs in and is correctly gated to upload.
   - Returning tester opens a job detail and lands in the correct state.
   - Profile page loads and explains current resume/profile/pre-screen state.

3. Normal onboarding.
   - Run a generic/new candidate onboarding conversation.
   - Allow natural answers, partial answers, random questions, and multi-message replies.
   - Verify onboarding stores role, YoE, visa/work auth, country, location, startup/company preference, resume state, and contact details where applicable.

4. Layoff onboarding.
   - Trigger `WeKruit_LAID_OFF` for an isolated beta tester.
   - Verify layoff onboarding uses the same candidate profile/session model as normal onboarding.
   - Verify it asks for resume when needed and does not collide with job prescreen sessions.
   - Verify questions are conversational and can handle process/trust questions like "is this legit?"

5. Job pre-screen.
   - Run one strong PASS.
   - Run one adjacent/probing PASS or near-pass.
   - Run one weak HARD_STOP only after repeated probes.
   - Run PAUSE/STOP/START.
   - Verify each work session starts, ends, archives memory, and updates candidate/job state correctly.

6. Job recommendation and matching conversation.
   - Ask for jobs conversationally.
   - Ask why a recommended job was recommended.
   - Ask whether certain job types should be lower priority.
   - Verify every job recommendation includes role/company, URL, requirements, and concise reason when available.
   - Verify Claire references prior user context without inventing memory.

7. Safety, privacy, and trust.
   - Ask privacy/export/delete-memory questions.
   - Ask "are you legit / why are you texting me / how did you get my info?"
   - Try prompt injection and private-data requests.
   - Verify safe, clear answers and no tapbacks/extra outbound on safety/privacy/suppression cases.

8. Operator/debug visibility.
   - For each beta tester, verify operator can inspect current state: user profile, resume parse state, current session owner, current question, last messages, safety blocks, memory writes, job-rec sends, and outbound delivery.
   - If dashboard is insufficient, document exact Firestore paths/commands as interim beta runbook.

9. Beta feedback capture.
   - Collect tester-visible transcript notes: confusing wording, missing links, repeated questions, too-short probing, abrupt rejection, duplicate messages, stuck UI, trust concerns.
   - Convert every valid issue into a code/doc fix or explicit backlog item with severity.

10. Evidence and closeout.
   - Record tester ids, phone/email, job ids, session ids, outbound ids, resume ids, Firestore doc paths, logs, screenshots if used, and fixes.
   - Update `.planning/AGENT-HARNESS-PRODUCTION-GAPS.md` with DONE/BLOCKED status for beta-user workflow items.
   - Keep test identities safe from unintended future outreach unless explicitly approved.

Completion criteria:

- At least one real business/internal beta tester completes the workflow without hidden manual intervention.
- Normal onboarding, layoff onboarding, job prescreen, job recommendations, privacy/trust, and stop/pause paths are verified live.
- Every flow has Firestore/session/outbound proof.
- Customer-visible transcript quality is acceptable or defects are fixed.
- Operator can debug the flow through dashboard or documented Firestore runbook.
- Evidence docs are updated.
- Any fixes are deployed with Node 24 and merged/pushed to `main`.

