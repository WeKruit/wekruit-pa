---
gsd_state_version: 1.0
milestone: v1.9
milestone_name: End-to-End Candidate Journey Closure
status: code_complete_pending_deploy
last_updated: "2026-05-12T12:00:00.000Z"
last_activity: 2026-05-12
progress:
  total_phases: 7
  completed_phases: 7
  total_plans: 7
  completed_plans: 7
---

## Current Position

Phase: **v1.9 code-complete (84-90) — all 51 REQ-IDs covered. Tests green: orchestrator 1458/1458, functions 1139/1139, prescreen scenarios 6/6. Deploy gated on `ATS_HANDSHAKE_HMAC_SECRET` set + Adam approval.**
Plan: —
Status: Awaiting deploy approval + Firebase secret provisioning.
Last activity: 2026-05-12 — Phase 90 audit + docs commit.

### Deploy checklist (pending)
1. `firebase functions:secrets:set ATS_HANDSHAKE_HMAC_SECRET`
2. `firebase deploy --only firestore:rules,firestore:indexes --project wekruit-5f89b`
3. `pnpm --filter "./apps/functions" run deploy` (ships `paAtsInboundWebhook` + Apply trigger)
4. `pnpm --filter dashboard-web run deploy:hosting`
5. Seed `pa-config/sendblue-pool` w/ current single number (BC preservation)

### Phase ship log

| Phase | Commit | REQ count |
|---|---|---|
| 84 | `3b2f949` feat(p84): PASS/FAIL terminal → auto job recs + Level 1 | 9 |
| 85 | (P85 commit) PiiConfirmPipeline + Apply trigger | 9 |
| 86 | (P86 commit) Generic ATS inbound | 10 |
| 87 | (P87 commit) Public job page + CV upload | 7 |
| 88 | (P88 commit) Sendblue multi-number pool | 6 |
| 89 | (P89 commit) Feedback survey | 5 |
| 90 | (this commit) docs + audit | 5 |

## Accumulated Context

### Prior milestones shipped
- **v1.6** (52-62): Unified Canonical Tags + Match Quality v1. 59/59 REQ.
- **v1.7** (63-73): Match Depth + Senior Scrapers + Stage 2.5 deletion. 43 REQ.
- **v1.8** (74-83): Conversational Pre-Screen + Memory Compaction. Engine + dashboard + drift detector + shadow sweep + 100 fixture corpus + real LLM verified.

### Reuse inventory (v1.9 must reuse, not rebuild)
- `Question<TAnswer>` / `OnboardingPipeline` (iter34 P1)
- `PreScreenPipeline.runTurn` + `FirestorePreScreenStore` (v1.8 P76)
- `KeywordSetJudge` LLM scoring (v1.8 P75)
- `pa-resume-parser` v2 + LLM chain (v1.6 P53)
- `mergeUserTags` writer + `pa-users.tags` single source (v1.6 P54)
- `generateJobRecs` cascade (v1.6 P56)
- `TriggerRouter` + `PrescreenTrigger` + `CompactTrigger` (v1.8 P77)
- `sendImessage` transport
- `pa-jobs` config + `/admin/job-prescreen` editor (v1.8 P78)
- voice-mode professional prefix (v1.8 P74)
- `cv-ingest` HTTP endpoint

### v1.9 trigger taxonomy
- `WeKruit_<jobId>_<userId>_Job` — prescreen start (existing)
- `WeKruit_<jobId>_<userId>_Apply` — skip prescreen, go straight to PII collect (NEW)
- `paAtsInboundWebhook` — generic ATS adapter HTTP endpoint (NEW, Handshake first)

## Out of Scope (deferred to v2.0)
- Employer dashboard / passed-candidate inbox
- Employer notification webhooks
- Interview scheduling
- Multi-stage Level 2/3 info reveal
- PII vault encryption beyond Firestore at-rest
- LinkedIn Recruiter API direct integration (adapter slot only)
