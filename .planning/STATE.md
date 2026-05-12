---
gsd_state_version: 1.0
milestone: v1.9
milestone_name: End-to-End Candidate Journey Closure
status: in_progress
last_updated: "2026-05-12T00:00:00.000Z"
last_activity: 2026-05-12
progress:
  total_phases: 0
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
---

## Current Position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-05-12 — Milestone v1.9 started via /gsd:new-milestone

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
