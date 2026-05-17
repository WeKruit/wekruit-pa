# Claire Customer-Visible iMessage QA Evidence

Date: 2026-05-17

Scope: Rain Software Engineer - Fullstack job prescreen via real iMessage on the approved test sender.

## Canonical Identity

- Candidate: `pa-users/U7AwKT8nLDRa35DkuBxq`
- Candidate email: `indolencorlol@gmail.com`
- Candidate phone on session: `+14243201960`
- Claire sender used by Messages: `+13054507715`
- Job: `rain-software-engineer-fullstack-8849f6ef`
- Trigger token: `WeKruit_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_Job`

## Flow 1 - Adjacent And Fragmented Candidate

Status: `UX_DONE`

Live session:

- Firestore doc: `pa-prescreen-sessions/ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260517T051658897Z`
- Visible start: 2026-05-17 01:16 ET
- Visible terminal: 2026-05-17 01:34 ET

Visible transcript summary:

1. Claire asked for recent software engineering work.
2. Candidate started weak: no production fullstack ownership, mostly product ops, dashboards, SQL reports, scripts.
3. Claire did not reject immediately. It probed for nearest owned project, context, personal work, and outcome.
4. Candidate sent fragmented OFO Delivery evidence across multiple messages.
5. Claire coalesced the fragmented messages and probed different angles: data/services touched, ownership boundary, React/Node/SQL depth, TypeScript bug, location, sponsorship.
6. Claire passed the candidate after 8 turns.

Firestore proof:

- `terminal`: `PASS`
- `terminalReason`: `ratio=0.860 threshold=0.65`
- `score`: `3.44`
- `scoreMax`: `4`
- `currentQId`: `null`
- `workSession.status`: `ended`
- `workSession.boundary`: `terminal`
- `workSession.endedAt`: `2026-05-17T05:34:14.610Z`
- `terminalActionResult.level1Sent`: `true`
- `terminalActionResult.jobRecsFired`: `false`
- Turn count: `8`

Verdict:

- The conversation was meaningfully better than the earlier abrupt hard-stop behavior.
- The agent probed before terminal and did not fire unrelated job recommendations after PASS.
- A visible defect remained: after PASS, Claire also sent `We already have your contact details on file - the employer will reach out directly.` This duplicated the Level 1 PASS handoff and made the ending noisy.

Fix applied after this run:

- `apps/functions/src/pii-confirm-start.ts`
  - Existing PII after PASS now silently skips instead of sending a second PASS contact-details message.
  - Existing PII after FAIL/HARD_STOP still sends the better-fit retention copy.
- `apps/functions/src/__tests__/pii-confirm-start.test.ts`
  - Updated the skip-existing test to assert only the FAIL/HARD_STOP retention copy.

## Flow 2 - Strong Candidate Post-Deploy Regression Check

Status: `UX_DONE`

Live session:

- Firestore doc: `pa-prescreen-sessions/ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260517T054928694Z`
- Visible start: 2026-05-17 01:49 ET
- Visible terminal: 2026-05-17 01:56 ET

Visible transcript summary:

1. Claire asked: `Hi - Claire from Rain. Quick screen for Software Engineer - Fullstack. What recent work best matches this software engineering role?`
2. Candidate answered with a strong OFO Delivery fullstack-adjacent dashboard: React-style screens, Node/Express endpoint, SQL views over orders/dispatch/pricing exception tables, stuck-delivery filters, and 2 hours/day to 20 minutes triage reduction.
3. Claire advanced to technical depth instead of repeating role-fit.
4. Candidate answered JavaScript/React and SQL strength.
5. Claire probed TypeScript/API-response typing and bug-prevention depth.
6. Candidate answered with typed `OrderRow`, `ExceptionBucket`, query params, and a null-status SQL bug fixed by `normalizeStatus`.
7. Claire advanced through location and sponsorship.
8. Claire passed and sent only:
   - `Thanks for your answers - I have enough for the role-fit screen. Sending the next step now.`
   - `Congrats - you've passed the initial screen for Software Engineer - Fullstack...`

Regression check:

- The duplicate existing-PII PASS message did not appear after waiting for the terminal flow.
- No post-PASS job recommendations fired.
- No compensation/salary sentinel appeared in the visible transcript.

Firestore proof:

- `terminal`: `PASS`
- `terminalReason`: `ratio=0.910 threshold=0.65`
- `score`: `3.64`
- `scoreMax`: `4`
- `currentQId`: `null`
- `workSession.status`: `ended`
- `workSession.boundary`: `terminal`
- `workSession.endedAt`: `2026-05-17T05:55:56.705Z`
- `terminalActionResult.level1Sent`: `true`
- `terminalActionResult.jobRecsFired`: `false`
- `terminalActionResult.jobRecsCount`: `0`
- Turn count: `5`

Turns:

1. `role_fit` -> `advance` to `technical_depth`, `s=0.86`, `c=0.78`.
2. `technical_depth` -> `clarify`, `s=0.55`, `c=0.62`.
3. `technical_depth` -> `advance` to `location_alignment`, `s=0.78`, `c=0.74`.
4. `location_alignment` -> `advance` to `sponsorship_status`, `s=1`, `c=0.95`.
5. `sponsorship_status` -> terminal `PASS`, `s=1`, `c=0.98`.

Verdict:

- Customer-visible transcript is coherent for a strong candidate.
- The PASS ending is no longer noisy.
- The Firestore session state matches the visible conversation.

## Flow 3 - Weak Candidate Hard Stop

Status: `UX_DONE`

Pre-fix live session:

- Firestore doc: `pa-prescreen-sessions/ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260517T061008006Z`
- Visible start: 2026-05-17 02:10 ET
- Visible terminal: 2026-05-17 02:22 ET

Pre-fix visible defects:

1. Claire sent a love tapback after the candidate wrote: `I have not done software engineering work... I did not write code for a production system.`
2. Claire correctly probed across five weak turns before `HARD_STOP`, but then immediately sent `Other roles that may fit:` with engineering jobs based on stale global tags.

Pre-fix Firestore proof:

- `terminal`: `HARD_STOP`
- `terminalReason`: `MUST_HAVE failed at qId=role_fit s=0.05 c=0.90`
- `score`: `0`
- `scoreMax`: `4`
- `workSession.status`: `ended`
- `workSession.boundary`: `terminal`
- `terminalActionResult.level1Sent`: `false`
- `terminalActionResult.jobRecsFired`: `true`
- Turn count: `5`

Fixes applied after this run:

- `apps/functions/src/coalesce/paMessageCoalescer.ts`
  - Expanded the love-tapback hard filter to include explicit no-code/no-experience wording such as `did not`, `have not`, `not done`, `without`, `no experience`, and support-only phrasing.
- `apps/functions/src/prescreen-terminal-action.ts`
  - Split `FAIL` and `HARD_STOP`.
  - `FAIL` still starts the better-fit recommendation chain.
  - `HARD_STOP` now preserves/contact-captures the candidate but does not send an immediate job recommendation list from stale global tags.

Post-fix live session:

- Firestore doc: `pa-prescreen-sessions/ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260517T062814683Z`
- Visible start: 2026-05-17 02:28 ET
- Visible terminal: 2026-05-17 02:35 ET

Visible transcript summary:

1. Claire asked for recent software engineering work.
2. Candidate answered explicitly weak: no software engineering work, no code, support tickets, spreadsheets, and escalations.
3. No love tapback was sent.
4. Claire did not reject immediately. It probed for the closest tech project, exact support tools, systems/logs/DB exposure, hardest failure mode, repro changes, shipped artifact, and measurable outcome.
5. Candidate repeatedly clarified that the work was documented repro/support ops, not software shipping.
6. Claire ended with:
   - `Thanks, that helps. I do not want to force-fit you into this exact role, so I will pause this screen here and use what you shared to look for better-aligned roles.`
   - `We already have your contact details on file - I’ll text you when a stronger fit comes through.`
7. No `Other roles that may fit:` list appeared after the hard stop.

Firestore proof:

- `terminal`: `HARD_STOP`
- `terminalReason`: `MUST_HAVE failed at qId=role_fit s=0.05 c=0.90`
- `score`: `0`
- `scoreMax`: `4`
- `currentQId`: `null`
- `workSession.status`: `ended`
- `workSession.boundary`: `terminal`
- `workSession.endedAt`: `2026-05-17T06:35:40.524Z`
- `terminalActionResult.level1Sent`: `false`
- `terminalActionResult.jobRecsFired`: `false`
- `terminalActionResult.jobRecsCount`: `0`
- Turn count: `5`
- Latest memory event evidence tags on `pa-users/U7AwKT8nLDRa35DkuBxq`: `["job_prescreen"]`
- Latest memory event `scored`: `[]`

Verdict:

- The hard-stop flow now gives the candidate multiple chances to explain adjacent experience, then stops without over-matching stale engineering roles.
- The visible transcript is coherent for a weak/no-code candidate.
- The session, turn, terminal-action, and memory-event state match the visible conversation.

## Data Repair

Problem:

- Rain jobs had seeded open-ended salary sentinels like `$50000-999000/yr`, causing visible compensation noise and a meaningless compensation prescreen question.

Fixes:

- `apps/functions/scripts/seed-rain-xyz.ts` suppresses open-ended salary sentinels.
- `apps/functions/scripts/backfill-rain-unified-job-flow.ts` suppresses open-ended salary sentinels.
- `packages/pa-job-tag-enricher/src/job-opportunity.ts` formats salary labels compactly and adds job-specific location/salary context only when real data exists.
- `apps/functions/scripts/repair-rain-compensation-sentinel.ts` repairs existing Rain Firestore docs and matching docs.

Applied repair:

- Repaired Rain jobs: `26`
- Final verification: `rainJobs=26`, `badCount=0`
- Verified fullstack job has no `salaryMin`, `salaryMax`, `salaryRange`, or Level 1 salary reveal.
- Verified fullstack prescreen questions are `role_fit`, `technical_depth`, `location_alignment`, `sponsorship_status`.

## Node 24 Verification And Deploy

Node used:

- `/Users/adam/.nvm/versions/node/v24.3.0/bin/node`

Tests:

- `node --import ./apps/functions/node_modules/tsx/dist/esm/index.mjs --test apps/functions/src/__tests__/pii-confirm-start.test.ts`
  - Result: `2` tests passed.
- `node --import ./apps/functions/node_modules/tsx/dist/esm/index.mjs --test apps/functions/src/coalesce/__tests__/paMessageCoalescer.test.ts apps/functions/src/prescreen-terminal-action.test.ts`
  - Result: `54` tests passed, `24` suites passed.
- `npm run test --workspace=@pa/functions`
  - Result: `1719` tests passed, `315` suites passed.

Build:

- `npm run build --workspace=@pa/functions`
  - Result: success.

Deployed functions:

- `pa-orchestrator:paMessageCoalescer`
- `pa-orchestrator:onPaInbound`
- `pa-orchestrator:paCoalesceBufferSweep`

Deploy result:

- All three functions updated successfully as Node.js 24 second-generation Firebase functions.

## Flow 4 - Job-Fit Explanation Copy

Status: `UX_DONE`

Live thread:

- Candidate: `pa-users/U7AwKT8nLDRa35DkuBxq`
- Session: `ses_62990f32ce66925df13ae2accc126a22`
- Messages thread: `+1 (305) 450-7715`
- Visible passing prompt sent: 2026-05-17 04:26 ET

Pre-fix live defects:

1. `Final copy check v5` returned one assistant bubble, but the first line was still rationale-only:
   - `Best current match: strongest evidence is end-to-end troubleshooting...`
2. Firestore confirmed the raw model chunk also lacked a concrete role/company, so this was not only a Sendblue/iMessage rendering issue.
3. The user-visible answer therefore did not clearly tell the candidate which role was the best current match.

Fixes applied after this run:

- `packages/pa-orchestrator/src/index.ts`
  - Detects explicit job-fit explanation requests.
  - Loads recent visible best-match context from the current session first, then the user-level message history.
  - Uses that role/company as the first-line anchor when the model returns rationale-only text.
- `packages/pa-orchestrator/src/index.test.ts`
  - Adds regression coverage for preserving the concrete best-match role from recent visible context.

Post-fix live transcript:

- User:
  - `Final copy check v6: please answer in one message: 1) best current match for me, 2) whether Rain fullstack still makes sense after my support-only prescreen, 3) whether internships/co-ops should be lower priority.`
- Claire:
  - `Best current match: Software Engineer 1 – Full-Stack at affirm, because strongest evidence is end-to-end troubleshooting of customer-impact issues plus web/frontend-adjacent exposure (React/TypeScript), which is a closer fit for product full-stack work than support-only execution.`
  - `Rain fullstack: After your support-only prescreen, it still makes sense only as a weak/adjacent fit, since your evidence is centered on reproducing and manually validating fixes via support tools (repro steps, screenshots, order IDs) rather than building production full-stack features with APIs/DB/logs.`
  - `Internship/co-op priority: No, internships/co-ops should not be lower priority; keep them in the mix, but prioritize roles that explicitly expect real ownership of web/frontend surfaces or full-stack product features rather than primarily support-to-engineering ticketing.`

Firestore proof:

- `pa-inbound-events/inb_0d0c5ef46cb6dcaa2b087b2244fad8e6038deab0`
  - `createdAt`: `2026-05-17T08:26:39.577Z`
  - `sessionId`: `ses_62990f32ce66925df13ae2accc126a22`
- `pa-messages/msg_02edd8a910fa07c0006a097bc44eb88197876389c14d09b1bb`
  - `createdAt`: `2026-05-17T08:26:46.035Z`
  - `body`: exact passing Claire reply above.
- `pa-outbound/2fc37cc4-c403-4074-971a-48ea2b3fd1a6`
  - `createdAt`: `2026-05-17T08:26:48.251Z`
  - `status`: `sent`

Verification:

- Targeted Node 24 tests:
  - `node --import ./apps/functions/node_modules/tsx/dist/esm/index.mjs --test packages/pa-orchestrator/src/index.test.ts packages/pa-orchestrator/src/output-normalizer.test.ts`
  - Result: `78` tests passed.
- Full Firebase predeploy suite:
  - Result: `1719` tests passed, `315` suites passed.
- Deployed functions:
  - `pa-orchestrator:onPaInbound`
  - `pa-orchestrator:paMessageCoalescer`
  - `pa-orchestrator:paCoalesceBufferSweep`

Verdict:

- The candidate-visible answer now names the role/company first, answers all three user questions in one bubble, and avoids the previous malformed `currentfor`/rationale-only first line.

## Remaining Matrix Status

The narrowed work completed the live job-prescreen lane that blocked this goal:

- Adjacent/fragmented candidate: `UX_DONE`
- Strong candidate PASS regression: `UX_DONE`
- Weak candidate hard-stop: `UX_DONE`
- PASS duplicate contact-details ending: fixed, deployed, and live verified.
- Post-PASS job recommendations: fixed and Firestore verified as `jobRecsFired:false`.
- Post-HARD_STOP immediate job recommendations: fixed and Firestore verified as `jobRecsFired:false`.
- Love tapback on explicit no-code weak answer: fixed and live verified absent.
- Rain compensation sentinel in prescreen: repaired and live transcript verified clean.
- Job-fit explanation after prescreen: fixed, deployed, and live verified against Messages + Firestore.

The broader customer-visible matrix in `.planning/CLAIRE-CUSTOMER-VISIBLE-IMESSAGE-QA-GOAL.md` still lists other flows as future test work unless separately executed:

- Normal candidate onboarding
- Layoff onboarding
- Pause/restart/supersede
- Privacy/safety/abuse
- Job matching conversation
- Everyday catchup and automated outbound
- Isolated rate-limit/opt-out/suppression UX
