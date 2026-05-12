# Milestone v1.9 — End-to-End Candidate Journey Closure

**Status:** Phases 84-90 code-complete (2026-05-12). 51/51 REQ-IDs covered.
**Deploy gate:** `ATS_HANDSHAKE_HMAC_SECRET` Firebase Secret must be set before deploying `paAtsInboundWebhook`. Other CFs deploy normally.

## Goal

Close the candidate-side loop from the WeKruit User Flow diagram:

```
User Entry → CV/Profile → Routing → Interview → Outcome
   (1A/1B)    (Phase 87)            (v1.8)       (Phase 84/85)
```

Employer side (passed-candidate inbox, scheduling) explicitly OOS — deferred to v2.0.

## Architecture

### Trigger taxonomy (extends v1.8 TriggerRouter)

| Trigger | Pattern | Handler | Outcome |
|---|---|---|---|
| `_Job` | `WeKruit_<jobId>_<userId>_Job` | `PrescreenTrigger` (v1.8 P77) | Bootstrap prescreen session |
| `_Apply` (NEW v1.9) | `WeKruit_<jobId>_<userId>_Apply` | `ApplyTrigger` (P85) | PII confirm if verified PASS, else fall back to prescreen |
| `__PA_COMPACT__` | literal | `CompactTrigger` (v1.8 P74.5) | Admin memory compaction |
| HTTP webhook (NEW v1.9) | POST `paAtsInboundWebhook` | `handleAtsInbound` (P86) | ATS applicant ingestion → invite SMS |

### Candidate journey state machine

```
Public Job Page /j/:jobId  ──┐
                              ├──→ SMS WeKruit_<jobId>_<requestedUserId>_Job
LinkedIn ATS inbound  ────┐    │      ↓
Handshake ATS inbound ────┤    │   PrescreenTrigger (P77)
Greenhouse ATS inbound ───┤    │      ↓
Lever ATS inbound ────────┤    │   PreScreenPipeline (v1.8 P76)
                           │    │      ↓
paAtsInboundWebhook (P86) ─┘    │   4-gate state machine
   → invite SMS  ───────────────┤      ↓
                                 │   Terminal (PASS/FAIL/HARD_STOP/PAUSE)
                                 │      ↓
                                 │   runPrescreenTerminalAction (P84)
                                 │      ├ PASS → Level 1 reveal → generateJobRecs
                                 │      ├ FAIL → "match other jobs?" → generateJobRecs
                                 │      ├ HARD_STOP → no action
                                 │      └ PAUSE → pausedAt stamp
                                 │      ↓ (PASS only)
                                 │   PiiConfirmPipeline (P85)
                                 │      ↓ (3 Q: legalName/email/phone)
                                 │   pa-users.contactPII + audit
                                 │      ↓
                                 └─→ FeedbackSurveyPipeline (P89)
                                        ↓ (2 Q: rating + freeform)
                                     pa-prescreen-sessions.feedback
```

## Phase summary

| Phase | Subject | REQ count | Key artifacts |
|---|---|---|---|
| 84 | PASS/FAIL → auto generateJobRecs + Level 1 reveal | 9 | `level1-template.ts`, `prescreen-terminal-action.ts` |
| 85 | PiiConfirmPipeline + Apply trigger | 9 | `pii-confirm.ts`, `triggers/apply.ts`, `pii-confirm-start.ts` |
| 86 | Generic ATS inbound (Handshake first) | 10 | `ats-adapters/`, `ats-inbound-handler.ts`, `ats-inbound-webhook.ts` |
| 87 | Public candidate job page + CV upload | 7 | `PublicJob.tsx`, `PublicJobCv.tsx`, `publicVisible` toggle |
| 88 | Sendblue multi-number pool | 6 | `sendblue/pool.ts`, `SendbluePool.tsx` |
| 89 | Feedback survey post-PASS | 5 | `feedback-survey.ts`, `PrescreenFeedback.tsx` |
| 90 | E2E + docs + audit | 5 | scenarios, this doc |

## Test coverage

| Layer | Count | Status |
|---|---|---|
| pa-orchestrator unit | 1458 | green |
| @pa/functions unit | 1139 | green |
| prescreen scenarios (v1.8 + v1.9) | 6 | green |

## Reuse mandate (per Adam directive)

Zero rebuild — every new piece extends existing infra:

- `OnboardingPipeline` (iter34 P1) reused for `PiiConfirmPipeline` + `FeedbackSurveyPipeline`
- `Question<TAnswer>` abstraction reused for new judges (LegalName/Email/Phone/Rating/Freeform)
- `KeywordSetJudge` (v1.8) untouched — PII flow uses regex judges
- `PreScreenPipeline.runTurn` (v1.8 P76) terminal-action hook is additive
- `TriggerRouter` (v1.8 P77) extended with `ApplyTrigger`
- `generateJobRecsForUser` (v1.6 P56) reused for PASS+FAIL auto-fire
- `pa-resume-parser` v2 (v1.6 P53) reused via `cv-ingest` for ATS resume binding
- `mergeUserTags` (v1.6 P54) implicit via cv-ingest
- `sendImessage` (existing) selects pool number via P88 hash-by-userId
- `pa-jobs` config (v1.8 P78) extended with `level1Reveal` + `publicVisible`

## Out of scope (deferred to v2.0)

- Employer dashboard / passed-candidate inbox
- Employer notification webhooks
- Interview scheduling
- Multi-stage Level 2/3 info reveal
- PII vault encryption beyond Firestore at-rest
- LinkedIn Recruiter API direct integration (adapter slot stub only)
- Greenhouse/Lever production adapters (stubs only)
- Multi-language prescreen beyond zh/en
- Real-time match notifications (still async daily via generateJobRecs)

## Deploy checklist

1. `firebase deploy --only firestore:rules,firestore:indexes` (new collection rules: pa-apply-trigger-idempotency, pa-pii-confirm-state, pa-jobs-external-mapping, pa-ats-invite-idempotency, pa-prescreen-pending-invites, pa-config; pa-jobs read scope widened for publicVisible).
2. Set `ATS_HANDSHAKE_HMAC_SECRET` via `firebase functions:secrets:set ATS_HANDSHAKE_HMAC_SECRET`.
3. `pnpm --filter "./apps/functions" run deploy` — ships `paAtsInboundWebhook` + updated `paSendblueWebhook` (Apply trigger).
4. `pnpm --filter dashboard-web run deploy:hosting` — ships new pages (PublicJob, PublicJobCv, AtsInbound, SendbluePool, PrescreenFeedback).
5. Seed `pa-config/sendblue-pool` with the current single number to preserve BC.
6. (Optional) Seed `pa-jobs-external-mapping/handshake_<external_job_id>` rows when first onboarding Handshake jobs.

## Open follow-ups (operational, post-ship)

- Set Adam-visible test job: `publicVisible=true` on `test-swe-screen-001` for end-to-end smoke via `/j/test-swe-screen-001`.
- Live SMS smoke via real PASS path → verify Level 1 reveal + PII collect + feedback survey close.
- libphonenumber-js integration (v2.0) for international phone formatting.
- Greenhouse adapter implementation (v2.0).
