# New User End-To-End Workflow Goal

Execute a clean new-user end-to-end test for WeKruit from first public touch through profile creation, resume parsing, iMessage screening, and persisted state.

References:

- `.planning/AGENT-HARNESS-PRODUCTION-GAPS.md`
- `.planning/AGENT-HARNESS-BETA-TO-PRODUCTION-GOAL.md`

Isolation rules:

- Use a brand-new test email, phone number, and browser/profile. Do not reuse Adam's `indolencorlol@gmail.com`, `+14243201960`, or the canonical existing `pa-users/U7AwKT8nLDRa35DkuBxq`.
- Use Node 24 for every local script/test/build/deploy command.
- Verify against the deployed `main` flow first. If code changes are needed, deploy directly and merge/push to `main`.
- Do not mark complete from unit tests alone. Completion requires visible website/iMessage behavior plus Firestore proof.

Scope:

1. Public candidate entry.
   - Open `https://candidate.wekruit.com/`.
   - Verify the home page shows a coherent candidate product experience and open job list.
   - Verify job cards use the same visual pattern as job detail pages.
   - Verify public job cards link to `/j/:jobId`.
   - Verify public/collaborated badge behavior matches data, not hardcoded assumptions.

2. Public job detail.
   - Open at least one WeKruit-collaborated public job detail.
   - Open at least one non-collaborated public job detail if data exists.
   - Verify layout, badge, requirements, role details, resume card, and pre-screen card are consistent.
   - Verify unauthenticated users are prompted to sign in before iMessage/pre-screen unlock.

3. Authentication.
   - Test Google login from job detail and return to the same job.
   - Test LinkedIn login from job detail and return to the same job.
   - Verify `pa-users/{uid}` identity is canonical and not duplicated.
   - Verify email/LinkedIn/phone handles link to the same user record.

4. Resume gate and website submission.
   - With no existing resume, verify the user cannot proceed to iMessage/pre-screen.
   - Upload a valid PDF resume.
   - Upload a valid DOCX resume if available.
   - Verify invalid file type and oversized file show clear UI states.
   - Verify uploading shows progress, parse/enrich status, success/failure copy, and next action.

5. Resume parsing and enrichment.
   - Verify `parsedCandidateResumes` is written.
   - Verify phone/email are parsed when present.
   - Verify resume summary, skills, experience, education, and canonical tags are written through the same candidate evidence/tag path used by iMessage.
   - Verify resume state attaches to the correct `pa-users/{uid}` and does not create duplicate users.

6. Pre-screen unlock.
   - After resume parse/enrichment is ready, verify the job detail page unlocks the iMessage/pre-screen action.
   - Trigger the iMessage flow from the website.
   - Verify Sendblue outbound is created for the intended phone and sender.
   - Verify the iMessage opener references the right company/job.

7. Live iMessage pre-screen.
   - Complete one strong PASS path.
   - Complete one adjacent/probing path if feasible with the same new user or a second isolated new user.
   - Verify Claire probes naturally, does not hard-stop too early, and terminal copy includes job URL when relevant.

8. Post-screen state.
   - Verify `pa-prescreen-sessions`, turns, memory event, `pa-users.workSession`, candidate-job state, employer-visible profile when PASS, and outbound delivery state.
   - Verify dashboard/operator view or documented Firestore view can explain the state without guessing.

9. Evidence and cleanup.
   - Record exact user id, email, phone, job ids, session ids, outbound ids, resume doc ids, and screenshots/log links if used.
   - Update `.planning/AGENT-HARNESS-PRODUCTION-GAPS.md` with DONE/BLOCKED for new-user workflow items.
   - If test data should not remain contactable, mark it as test-only or suppress future outreach.

Completion criteria:

- New user can start on website, authenticate, upload resume, parse/enrich profile, unlock iMessage, complete at least one live pre-screen, and persist the correct state.
- No duplicate user records are created.
- Resume parsing and tags use the canonical `pa-users` candidate evidence path.
- All visible UI states are understandable to a real candidate.
- Evidence docs are updated.
- Any fixes are deployed with Node 24 and merged/pushed to `main`.

