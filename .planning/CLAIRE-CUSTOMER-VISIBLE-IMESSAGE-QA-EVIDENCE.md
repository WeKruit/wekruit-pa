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
- `npm run test --workspace=@pa/functions`
  - Result: `1718` tests passed, `315` suites passed.

Build:

- `npm run build --workspace=@pa/functions`
  - Result: success.

Deployed functions:

- `pa-orchestrator:paMessageCoalescer`
- `pa-orchestrator:onPaInbound`
- `pa-orchestrator:paCoalesceBufferSweep`

Deploy result:

- All three functions updated successfully as Node.js 24 second-generation Firebase functions.

## Remaining Matrix Status

The narrowed work completed the live job-prescreen lane that blocked this goal:

- Adjacent/fragmented candidate: `UX_DONE`
- Strong candidate PASS regression: `UX_DONE`
- PASS duplicate contact-details ending: fixed, deployed, and live verified.
- Post-PASS job recommendations: fixed and Firestore verified as `jobRecsFired:false`.
- Rain compensation sentinel in prescreen: repaired and live transcript verified clean.

The broader customer-visible matrix in `.planning/CLAIRE-CUSTOMER-VISIBLE-IMESSAGE-QA-GOAL.md` still lists other flows as future test work unless separately executed:

- Normal candidate onboarding
- Layoff onboarding
- Weak candidate hard-stop
- Pause/restart/supersede
- Privacy/safety/abuse
- Job matching conversation
- Everyday catchup and automated outbound
- Isolated rate-limit/opt-out/suppression UX
