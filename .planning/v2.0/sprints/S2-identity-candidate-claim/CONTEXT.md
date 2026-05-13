# S2 Context

**Sprint:** S2 - Identity + Candidate Claim
**Branch:** `codex/v2-S2-identity-candidate-claim`
**Worktree:** `.claude/worktrees/v2-S2-identity-candidate-claim`
**Base:** `origin/main` at `7afe2e774b8bb167aa59657e7ba77de49a6f9b8c`
**Date:** 2026-05-13

## Starting State

S0 and S1 are landed on `main`. S1 deploy evidence was committed directly to
`main` as `7afe2e7 docs(v2): record S1 deploy evidence`.

S1 verification on the landed branch:

- PR #24 checks passed: CodeQL, analysis, v1.5 QA, and `typecheck + unit tests`.
- S1 deployed `hosting:pa-dashboard,firestore:rules,firestore:indexes` to
  `wekruit-5f89b`.
- Post-deploy smoke passed for admin `/admin`, admin `/j/*` redirect,
  candidate job route, invalid `paPublicCvIngest`, and unauthenticated
  marketplace collection denial.

Root checkout note: `/Users/adam/Desktop/WeKruit/wekruit-pa` still has unrelated
local `package.json` and `package-lock.json` edits. They are outside this S2
worktree and are not part of this sprint.

## Product Invariant Advanced

S2 makes one real person resolve to one global candidate profile across email,
PDF resume extraction, phone, browser `wkr_uid`, Sendblue, and ATS. It advances
the v2.0 lock that candidate profile is the durable asset and jobs are demand
events.

S2 must not turn the candidate identity problem into an employer ATS account
model. Employer-provided email is only a hint; PDF-extracted email is the
primary identity signal for resume intake. Candidate claim is email magic-link
first, not Gmail-only OAuth.

## Current Repo Orientation

Candidate site:

- `apps/pa-landing/src/main.tsx` currently exposes `/`, `/legal`, `/j/:jobId`,
  and `/j/:jobId/cv`.
- `apps/pa-landing/src/lib/firebase.ts` initializes Firestore only; candidate
  auth and functions clients do not exist yet.
- `apps/pa-landing/src/pages/PublicJob.tsx` stores browser identity in
  localStorage as `wkr_uid`, uploads resumes to `VITE_CV_INGEST_URL`, and
  sends `WeKruit_<jobId>_<requestedUserId>_Job` to iMessage.

Resume and ATS intake:

- `apps/functions/src/public-cv-ingest.ts` accepts `tempUserId | userId` and
  passes that value directly into `ingestCv`.
- `apps/functions/src/cv-ingest/cv-ingest.ts` parses email/phone, writes
  `parsedCandidateResumes`, writes `pa-users/{userId}.tags`, and writes
  `pa-users/{userId}.phoneE164` when parsed phone exists. It does not yet
  resolve a canonical candidate by extracted email before writing.
- `apps/functions/src/ats-inbound-handler.ts` find-or-creates `pa-users` by
  raw `emailLower` on the ATS applicant payload.

Phone and Sendblue:

- `apps/functions/src/sendblue/webhook.ts` resolves inbound users by
  `pa-users.phoneE164`.
- `apps/functions/src/sendblue/triggers/prescreen.ts` reconciles public job
  page `wkr_uid` with phone-resolved real `pa-users` rows through
  pending-invite attribution.
- `apps/functions/src/prescreen-session-start.ts` writes public page
  attribution to the resolved real user.

S1 marketplace foundation:

- `packages/core-types/src/marketplace.ts` defines `CandidateHandle`,
  lifecycle reducers, and `createCandidateHandleId`.
- `packages/pa-persistence/src/marketplace.ts` writes lifecycle/job events and
  append-only feedback/correction events.
- `apps/dashboard-web/src/pages/CandidateMarketplace.tsx` shows linked handles,
  resume artifacts, job states, matches, invites, employer snapshots, feedback,
  and corrections for operators.
- Firestore rules keep S1 marketplace collections operator-read and
  server-write only. S2 must add candidate self-read only after candidate auth
  mapping is deterministic.

## Required S2 Capability

Candidate claim:

- `/login` requests and completes an email magic link on the candidate domain.
- A signed-in candidate is linked to a canonical `candidateId`.
- `/me` shows the candidate's global profile summary.
- `/me/profile` shows resume/profile data, handles, and identity state.

Identity resolution:

- Add normalized email and hashed email handle lookup.
- Link browser uid, email, phone, ATS applicant id, and Sendblue/imessage
  handles to one `pa-users/{candidateId}` row.
- Resolve public CV uploads by PDF-extracted email before writing profile
  artifacts.
- Keep employer-provided email as a validation hint and record mismatch in a
  conflict queue.
- Write deterministic merge/audit events for every handle link, candidate
  claim, and conflict.

Admin visibility:

- Candidate marketplace inspector shows linked handles and merge history.
- Admin conflict queue shows PDF email vs employer-provided email mismatch and
  duplicate-candidate suspicion.

## Non-Goals

- No live outbound to real candidates.
- No destructive merge or production data deletion.
- No broad employer candidate browsing.
- No scheduling, notes, employer messaging, or passed-profile scope expansion.
- No Gmail-only candidate OAuth.
- No rework of v1.6 tag/match decisions.
- No match-score gate before first interview.
- No moving candidate routes to the admin hosting site.
