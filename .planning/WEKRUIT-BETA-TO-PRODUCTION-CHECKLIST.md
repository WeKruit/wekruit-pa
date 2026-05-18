# WeKruit Beta To Production Checklist

This checklist tracks the unified goal in `.planning/WEKRUIT-BETA-TO-PRODUCTION-UNIFIED-GOAL.md`.

Status values:

- `UNVERIFIED`: not checked in this goal run.
- `STATIC_OK`: code path exists, but no current live proof yet.
- `LIVE_OK`: customer-visible or operator-visible flow was exercised successfully.
- `BLOCKED`: verified failure with root cause or next debug target.
- `FIXED_PENDING_DEPLOY`: code changed, local verification passed, deploy pending.
- `DEPLOYED_PENDING_LIVE`: deployed, live rerun pending.
- `PARTIAL_OK`: one or more current checks passed, but the full requirement is not yet proven.

## Checklist

| ID | Area | Requirement | Status | Evidence / Next Action |
| --- | --- | --- | --- | --- |
| WEB-01 | Candidate web | Candidate home lists public/open jobs from canonical data | UNVERIFIED | Inspect `apps/pa-landing`, then live browser check `candidate.wekruit.com`. |
| WEB-02 | Candidate web | Job detail shares home visual/product pattern | UNVERIFIED | Browser visual check and source audit. |
| WEB-03 | Candidate web | Job detail has clear start-screen path | UNVERIFIED | Browser check with logged-out/logged-in states. |
| WEB-04 | Candidate web | Google login returns to intended job page | UNVERIFIED | Live browser auth check if possible; inspect callback routing. |
| WEB-05 | Candidate web | LinkedIn login returns to intended job page | UNVERIFIED | Live browser auth check if possible; inspect callback routing. |
| WEB-06 | Candidate web | Logged-in user resolves to correct `pa-users/{uid}` | UNVERIFIED | Firestore proof for test user after login. |
| WEB-07 | Candidate web | Missing parsed resume blocks iMessage unlock | UNVERIFIED | Browser + Firestore resume-state check. |
| WEB-08 | Candidate web | Resume upload shows uploading/parsing/enriching/ready/error | DEPLOYED_PENDING_LIVE | Fixed public upload mismatch: backend now accepts PDF or DOCX, extracts DOCX text, and candidate UI has clearer format/read errors. Node 24 targeted tests pass. Hosting deployed; `paPublicCvIngest` confirmed `nodejs24`/`ACTIVE` at `2026-05-18T02:51:22Z`. Live upload still pending. |
| WEB-09 | Candidate web | Resume upload rejects invalid/oversized files clearly | DEPLOYED_PENDING_LIVE | Backend now returns `unsupported_resume_format` for non-PDF/DOCX and `docx_parse_failed` for unreadable DOCX; UI maps both to candidate-facing wording. `paPublicCvIngest` confirmed `nodejs24`/`ACTIVE`. Invalid-file browser test still pending. |
| WEB-10 | Candidate web | Resume parse writes `parsedCandidateResumes` | STATIC_OK | Source path confirmed through `paPublicCvIngest` -> `ingestCv`; live Firestore proof after `adam.ylol@wekruit.com` upload still pending. |
| WEB-11 | Candidate web | Resume enrichment writes canonical `pa-users` evidence/tags | STATIC_OK | Source path confirmed through `ingestCv` `runUserTagsMerge` and candidate-upload artifact writes; live Firestore proof still pending. |
| WEB-12 | Candidate web | Profile page does not hang forever | UNVERIFIED | Browser check and source audit. |
| SMS-01 | iMessage | Normal onboarding works conversationally | UNVERIFIED | Live iMessage test. |
| SMS-02 | iMessage | Layoff onboarding works conversationally | UNVERIFIED | Live iMessage test. |
| SMS-03 | iMessage | Generic onboarding process questions handled | UNVERIFIED | Live iMessage test, e.g. legitimacy question. |
| SMS-04 | iMessage | Strong prescreen PASS | UNVERIFIED | Live iMessage + Firestore proof. |
| SMS-05 | iMessage | Adjacent/probing prescreen PASS | UNVERIFIED | Live iMessage + Firestore proof. |
| SMS-06 | iMessage | Weak prescreen hard-stops only after repeated probing | UNVERIFIED | Live iMessage + Firestore proof. |
| SMS-07 | iMessage | PAUSE/STOP/START behavior | UNVERIFIED | Live iMessage + Firestore proof. |
| SMS-08 | iMessage | Privacy/export/delete-memory questions | UNVERIFIED | Live iMessage + Firestore proof. |
| SMS-09 | iMessage | Job rec request and post-terminal recs include URL + requirements | UNVERIFIED | Static helper audit, live iMessage proof. |
| ADMIN-01 | Job-scoped admin | PASS writes `pa-candidate-job-states/{uid}__{jobId}` | STATIC_OK | Source audit: `prescreen-outcome-service.ts` calls `applyPassedCandidateSnapshot` on PASS; live PASS proof still pending. |
| ADMIN-02 | Job-scoped admin | PASS state transitions to `employer_visible` | STATIC_OK | Source audit found employer-visible snapshot path; Firestore proof after live PASS still pending. |
| ADMIN-03 | Job-scoped admin | PASS writes `pa-employer-visible-profiles/{jobId}__{uid}` | STATIC_OK | Source audit found employer-visible profile write/read path; live PASS proof still pending. |
| ADMIN-04 | Job-scoped admin | State points to latest `prescreenSessionId` | STATIC_OK | Source audit confirms session-aware passed-candidate surface; live session-id proof still pending. |
| ADMIN-05 | Job-scoped admin | `/admin/passed-candidates?jobId=<jobId>` shows candidate | STATIC_OK | Dashboard route/source present; browser/admin proof with live passed candidate still pending. |
| ADMIN-06 | Job-scoped admin | Admin view includes identity/job/status/reason/transcript/evidence/resume/timestamp | STATIC_OK | Source audit shows route renders candidate/job/status/reason/transcript/resume fields; live visual proof still pending. |
| ADMIN-07 | Job-scoped admin | Non-passed candidates are not employer-visible | UNVERIFIED | Source audit and Firestore query check. |
| JOB-01 | Job data | Public/admin jobs share canonical data path | UNVERIFIED | Source audit job creation/seeding/candidate reads. |
| JOB-02 | Job data | Public visibility is data-driven | STATIC_OK | Candidate home/job detail read `pa-jobs` with `publicVisible === true`; Firestore sample still pending. |
| JOB-03 | Job data | WeKruit-collaborated badge is data-driven | STATIC_OK | Candidate home/job detail render badge from `wekruitCollaborationStatus === "collaborated"`; Firestore collab/non-collab sample still pending. |
| JOB-04 | Job data | Collab/non-collab jobs share schema/rendering | UNVERIFIED | Source audit and browser sample. |
| JOB-05 | Job data | Job creation/seeding/import converge into `pa-jobs` shape | UNVERIFIED | Source audit. |
| JOB-06 | Job data | Dashboard exposes public/collab/passed-candidate status clearly | UNVERIFIED | Source audit/browser check. |
| RUNTIME-01 | Runtime | Node 24 relevant tests pass | PARTIAL_OK | Node 24 targeted functions tests passed: `tsx --test src/public-cv-ingest.test.ts src/identity/candidate-resume-gate.test.ts src/identity/claim-api.test.ts` = 18/18; `apps/functions run build` passed; `apps/pa-landing run build` passed. Full runtime matrix still pending. |
| RUNTIME-02 | Runtime | Artillery stress passes | UNVERIFIED | Run or mark blocked with environment reason. |
| RUNTIME-03 | Runtime | Prescreen Firestore stress passes all scenarios | UNVERIFIED | Run script and record doc IDs. |
| RUNTIME-04 | Runtime | Safety/guardian checks pass | UNVERIFIED | Run source/test/live checks. |
| RUNTIME-05 | Runtime | No duplicate sends, stuck buffers/sessions, missing terminals, linkless recs | PARTIAL_OK | Proactive scheduled direct-send bypass retired and deployed: `paProactiveSweep` now hands structured events to runtime, historical `proactive_send` rows are idempotency-only, and broker rejects `runtimeSource="pa_proactive_turn"`. Node 24 typecheck/tests passed for broker/orchestrator/functions. Deployed `paProactiveSweep`, `paSendblueOutbox`, and `paSendblueOutboxRetrySweep` are ACTIVE/nodejs24; Firestore canary `canary-runtime-gate-1779108262765` proved deployed outbox blocks retired source without sending. Full duplicate/stuck/session/link-rec stress remains pending. |
