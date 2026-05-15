# Goal Prompt: Unified Claire Candidate Product

Use this file as the detailed reference for the next `/goal`.

Short command:

```text
/goal Execute .planning/V2-CLAIRE-UNIFIED-CANDIDATE-PRODUCT-GOAL.md. Build Claire as one unified candidate product across candidate.wekruit.com, job prescreen, layoff.wekruit.com, external supply, matching, tagging, scoring, dashboard visibility, and controlled outbound. Multiple front doors, one pa-users profile/evidence/tagging/scoring system. Use Node 24, verify with Firestore + dashboard + live/live-equivalent flows, deploy and merge to main.
```

## Core Product Principle

WeKruit has multiple front doors, not multiple candidate products.

- `candidate.wekruit.com` = regular candidate entry.
- `candidate.wekruit.com/j/:jobId` = job-specific candidate entry.
- iMessage/SMS `WeKruit_<jobId>_<userId>_Job` = job prescreen trigger.
- `layoff.wekruit.com` = layoff-specific entry.
- iMessage/SMS `WeKruit_LAID_OFF` = layoff source-aware onboarding trigger.
- iMessage/SMS `START`, `hi`, or another normal candidate reply with no active
  job/layoff trigger = regular Claire candidate onboarding. If a recent ATS
  pending invite exists, that same `START` reply must virtualize into the
  matching job prescreen; otherwise it must stay in general onboarding.
- external supply/admin uploads = operator-side candidate acquisition.

Underlying truth must be shared:

- One Firebase project: `wekruit-5f89b`.
- One candidate collection: `pa-users`.
- One Sendblue number pool: `pa-config/sendblue-pool`.
- One Claire SMS/onboarding state machine where possible.
- One evidence/tagging/scoring system for matching, outbound, and dashboard.

If implementation starts adding a parallel candidate collection, parallel auth flow, parallel Claire state machine, or separate layoff functions deployment, stop and redesign.

## Repos And Deployment Boundaries

| Surface | Repo | Frontend | Hosting target | Functions |
| --- | --- | --- | --- | --- |
| `candidate.wekruit.com` | `WeKruit/wekruit-pa` | `apps/pa-landing` | `hosting:pa-landing` | `wekruit-pa/apps/functions`, codebase `pa-orchestrator` |
| `layoff.wekruit.com` | `WeKruit/wekruit-layoff` | repo root Vite SPA | `hosting:open` | no separate functions; consumes PA callables |
| Admin | `WeKruit/wekruit-pa` | `apps/dashboard-web` | admin hosting target | `wekruit-pa/apps/functions`, codebase `pa-orchestrator` |

Deploys:

- Candidate site: `firebase deploy --only hosting:pa-landing --project wekruit-5f89b`
- Layoff site: from `wekruit-layoff`, `firebase deploy --only hosting:open --project wekruit-5f89b`
- Functions for both: from `wekruit-pa`, deploy PA `pa-orchestrator` functions only.

Use Node 24 for all local commands and deploys.

## Existing Layoff Contract

The layoff product is `candidate.wekruit.com` with a source flag and layoff context.

Required pa-users fields:

- `source: "WeKruit_Laid_Off"`
- `lastLaidOffAt: serverTimestamp()`
- `layoffContext.lastCompany`
- `layoffContext.jobTitle`
- `layoffContext.location`
- `layoffContext.email`
- `layoffContext.linkedin`
- optional `layoffContext.resumeFileName`
- shared `phoneE164`, `displayName`, `senderNumber`, `senderGroupId`

Dedup:

- `layoff_phone_index/p_{hash}` points to `{ candidateId, lastLaidOffAt }`.
- Do not skip this write.
- Do not create or revive `layoff_candidates`.

Current layoff callables live in:

- `wekruit-pa/apps/functions/src/openLayoff.ts`

Current layoff frontend consumes them from:

- `wekruit-layoff/src/lib/api.ts`

## Open PR To Reconcile First

Before implementing new layoff backend work, inspect and reconcile:

- PR: https://github.com/WeKruit/wekruit-pa/pull/73
- Title: `feat(open-layoff): WeKruit Open layoff product backend`
- Branch: `feat/wekruit-open-integration` -> `main`
- Files changed:
  - `apps/functions/src/index.ts`
  - `apps/functions/src/openLayoff.ts`
  - `config/firebase/firestore.indexes.json`

PR #73 claims to add the five layoff callables under the existing PA `pa-orchestrator` codebase:

- `openRegisterLayoffCandidate`
- `openInitiateSmsPrescreen`
- `openSubmitChatTurn`
- `openListLayoffCandidates`
- `openRegisterEmployer`

It also claims to add Firestore indexes:

- `pa-users(source, lastLaidOffAt desc)`
- `pa-users(source, layoffContext.function, lastLaidOffAt desc)`

Required handling:

- Do not reimplement these callables blindly.
- Diff PR #73 against current `main`.
- Decide whether to merge, cherry-pick, or rewrite into the unified architecture.
- Preserve the single-source-of-truth design from the PR: layoff candidates are `pa-users` with `source: "WeKruit_Laid_Off"`.
- Verify the callables with tests and Firestore smoke evidence before treating the PR as complete.
- If PR #73 is merged, continue from the merged `main`.
- If PR #73 is superseded by this goal, explicitly close or replace it with a clear reason.

## First Files To Read

Read these before code changes:

1. `wekruit-pa/apps/functions/src/openLayoff.ts`
2. `wekruit-pa/apps/functions/src/sendblue/pool.ts`
3. `wekruit-pa/apps/functions/src/sendblue/allowlist.ts`
4. `wekruit-pa/packages/pa-broker/src/outbound-queue.ts`
5. `wekruit-pa/packages/pa-orchestrator/src/onboarding.ts`
6. `wekruit-pa/apps/functions/src/sendblue/triggers/prescreen.ts`
7. `wekruit-pa/apps/functions/src/prescreen-session-start.ts`
8. `wekruit-pa/apps/functions/src/prescreen-turn-handler.ts`
9. `wekruit-pa/apps/functions/src/prescreen-terminal-action.ts`
10. `wekruit-pa/apps/functions/src/prescreen-outcome-service.ts`
11. `wekruit-pa/apps/functions/src/identity/claim-api.ts`
12. `wekruit-layoff/src/pages/Signup.tsx`
13. `wekruit-layoff/src/pages/Marketplace.tsx`
14. `wekruit-layoff/src/pages/Login.tsx`

If you cannot draw the flow from frontend signup/login -> `pa-users` -> outbound queue -> Sendblue -> Claire -> evidence/tags/dashboard, do not write code yet.

## Non-Negotiables

- Single source of truth for candidates: `pa-users`.
- No `layoff_candidates`.
- No separate layoff functions deploy.
- No forked Claire for layoff.
- No hardcoded WeKruit collaborated badges.
- No hardcoded prescreen pass flags.
- No dashboard-only claims without Firestore verification.
- Do not overwrite stronger resume/profile facts with weak chat evidence.
- If code changes are made, deploy and merge to `main`.

## Required Work

### 1. Current-State Audit

Map current writers/readers and classify as working, fragmented, missing, or wrong:

- `pa-users.tags`
- `pa-users.globalTags`
- `pa-users.conversationDerivedPreferences`
- `pa-users.lastPrescreenMemoryUpdate`
- `pa-candidate-job-states`
- `pa-candidate-job-matches`
- `pa-prescreen-sessions`
- `pa-prescreen-memory-events`
- `pa-employer-visible-profiles`
- `pa-resume-artifacts`
- `pa-outbound`, outbound invites, suppression/cooldown
- `source: "WeKruit_Laid_Off"`
- `layoffContext`
- `lastLaidOffAt`
- `layoff_phone_index`
- external-supply identity/evaluation records
- dashboard pages that expose candidate, job, prescreen, passed, employer-visible, and layoff data

Deliver a table with exact file paths, Firestore collections, and gaps.

Include PR #73 in this audit:

- Whether its callables exist on current `main`.
- Whether deployed functions match source.
- Whether indexes are already deployed and represented in `config/firebase/firestore.indexes.json`.
- Whether the PR duplicates, conflicts with, or complements existing candidate/onboarding/prescreen code.

### 2. Unified Candidate Evidence And Tagging

Create or centralize one weak-merge service for candidate evidence.

Evidence source types:

- `job_prescreen`
- `general_onboarding`
- `layoff_onboarding`
- `resume_parse`
- `external_supply`
- `manual_admin`

The service must:

- Preserve stronger existing facts.
- Store reusable facts globally on `pa-users`.
- Store job-specific facts under `jobId`.
- Store layoff-specific facts under `layoffContext`.
- Track provenance: source type, source doc/session id, confidence, timestamp.
- Derive indexable tags for matching/scoring/dashboard.
- Avoid treating `relevantTags` as the only place important evidence lives.

Reconcile `pa-users.tags` and `pa-users.globalTags` so matching, scoring, outbound, and dashboard have one documented read path.

### 3. Candidate, Job, And Evidence Scoring

Improve scoring with explainability:

- Candidate profile completeness: resume, contact, LinkedIn, location, visa, role interests, skills, availability, evidence freshness.
- Job match score: hard filters plus soft evidence overlap.
- Prescreen score: job-specific role fit from session turns.
- Evidence confidence: source quality and recency.
- Job context quality: public status, WeKruit collaboration status, prescreen config quality, outbound eligibility.

Every score must expose reasons, not only numbers.

### 4. Job/Company Candidate Dashboard

For each company/job candidate list, show candidates from external upload, matching, direct candidate flow, layoff source, and outbound with:

- candidate id and profile link
- source and source record link
- match score and reason
- prescreen state from `pa-candidate-job-states`
- clear flags: `Prescreen passed`, `Employer visible`, `Not passed`, `Active screen`, `Paused`, `No screen`
- prescreen session link
- employer-visible profile link when available
- latest evidence/tag/profile delta
- contact/readiness status where allowed

The pass flag must come from `pa-candidate-job-states` and/or `pa-employer-visible-profiles`, not inferred from UI or hardcoded copy.

### 5. WeKruit Collaboration And Controlled Outbound

Represent WeKruit collaboration as real job data.

Define a field contract for job collaboration status, then use it in:

- candidate job page badge
- admin job/company candidate views
- matching/scoring
- outbound decisions
- employer-visible/pass workflow

Outbound decisioning must consider:

- collaboration status
- public job visibility
- match score and reason
- candidate consent/contact readiness
- cooldown/suppression
- source segment
- whether prescreen is required
- whether a passed/employer-visible snapshot already exists

For collaborated jobs, strong matches can trigger controlled outbound. For non-collab jobs, do not imply WeKruit is operating the employer process.

### 6. Source-Aware Claire Onboarding

Do not fork Claire.

Move source-aware opener behavior into `packages/pa-orchestrator/src/onboarding.ts`, especially `send_first_mes`.

Expected model:

- `openLayoff.ts` should register/update `pa-users`, set `source: "WeKruit_Laid_Off"`, and enqueue a start signal.
- The onboarding state machine reads `pa-users.source`.
- Claire emits a layoff-aware opener from the same state machine.
- Candidate and layoff onboarding continue through unified evidence/tag merge.

Goal: Adam can tune opener variants in one place without touching Cloud Function registration code.

### 7. Layoff Front Door Completion

Finish layoff integration without creating a parallel product:

- `WeKruit_LAID_OFF` trigger starts or resumes source-aware layoff onboarding.
- Signup duplicate phone flow continues to use `layoff_phone_index`.
- Candidate auth from layoff `/login` links/adopts the existing `pa-users` row instead of creating a new candidate.
- Extend `paCandidateClaimProfile` or adjacent identity claim code to claim by phone/layoff context when safe.
- Resume upload from layoff signup must call the shared CV ingest flow, not only save `resumeFileName`.
- Marketplace verified employer listing reads live `pa-users` with `source: "WeKruit_Laid_Off"`.
- Layoff candidates remain filterable by source and do not leak into unrelated job candidate views unless matched/selected.

### 8. Employer Verification For Layoff Marketplace

Replace the demo verified button:

- Create callable such as `paEmployerClaimVerification` under `wekruit-pa/apps/functions/src/identity/`.
- Email magic-link/Firebase Auth sign-in should claim employer verification.
- Write `layoff_employers/{id}.verificationStatus = "verified"`.
- Client uses Auth + claim result to set verified state.
- Verified employers can call `openListLayoffCandidates`.

### 9. General Candidate Onboarding Reuse

General candidate onboarding from `candidate.wekruit.com` should use the same architecture:

- session/turn archive
- candidate evidence weak merge
- canonical tags
- profile completeness
- matching/recommendation readiness

It should collect:

- target roles
- location/country preference
- work authorization/visa
- compensation expectations
- timeline/availability
- resume/profile gaps
- LinkedIn/resume status
- preferences and constraints

It must not steal replies from an active job prescreen or layoff onboarding session.

### 10. Session Routing And Boundaries

Every work session must have:

- kind: `job_prescreen`, `general_onboarding`, `layoff_onboarding`, or future explicit kind
- entry point
- userId
- optional jobId
- startedAt
- endedAt
- status
- boundary
- linked turns
- linked evidence/profile updates

Routing priority:

1. Active job prescreen owns replies.
2. Active explicit layoff onboarding owns layoff replies.
3. Active general onboarding owns general replies.
4. New trigger can supersede the old incompatible active session.

End boundaries:

- `terminal`
- `timeout`
- `superseded`
- `user_exit`

Ended sessions must not catch future replies.

### 11. Claire Persona Upgrade

Make Claire more live and human without becoming casual, fake, or sloppy.

Add controlled micro-acknowledgments:

- “That’s helpful context.”
- “Got it — the dashboard piece matters here.”
- “Interesting, the closest overlap sounds like the tooling work.”
- “That is a useful signal. Let me understand the scope a bit more.”

Rules:

- Probe for context, personal role, systems touched, measurable outcome, and gaps before conclusion.
- Weak answers trigger probing, not immediate rejection.
- Hard stop is graceful and keeps the candidate in the global pool.
- Layoff tone acknowledges the situation first, with no forced optimism.
- Emoji is allowed only with very low probability, max one, after genuinely strong positive evidence.
- Never use emoji in rejection, hard stop, layoff distress, visa/sponsorship, consent, privacy, or compliance-sensitive messages.
- Avoid slang, exaggerated praise, and robotic repeated phrasing.

### 12. Verification

Required verification:

- Node 24 targeted tests.
- Firestore audit of candidate evidence/tag writes.
- One job prescreen live or live-equivalent Sendblue flow using
  `WeKruit_<jobId>_<userId>_Job`.
- One `WeKruit_LAID_OFF` live or live-equivalent Sendblue flow.
- One normal/random candidate live or live-equivalent Sendblue flow using
  `START` or `hi`, proving it stays in regular onboarding when no pending invite
  exists.
- One `START` live or live-equivalent Sendblue flow with a recent ATS pending
  invite, proving it virtualizes into the right job prescreen instead of
  regular onboarding.
- Stress cases for at least four candidate characteristics: strong fit,
  adjacent fit, weak/evasive fit, and multi-message fragmented replies. The
  transcript/reply quality must be read by the tester; do not rely only on
  test green.
- One layoff signup duplicate-phone path check.
- One layoff auth claim/adoption check.
- One layoff resume ingest check.
- One dashboard job/company candidate view showing match, source, prescreen state, pass flag, session link, employer-visible link.
- One verified employer marketplace listing check for layoff candidates.
- Deploy changed functions/sites.
- Confirm deployed functions runtime is Node 24.
- Merge to `main`.

Final report must include exact:

- repo and branch
- commit hash pushed to main
- deploy targets
- function names and runtimes
- candidate ids
- job ids
- session ids
- state doc ids
- profile/evidence/tag fields updated
- dashboard routes checked
- tests run and results
