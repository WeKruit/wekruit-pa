# Phase 60: Dev triggers + scenarios + fixtures + daily-batch V16 cutover - Context

**Gathered:** 2026-05-06
**Status:** Ready for planning
**Mode:** Decisions D14 locked

<domain>
## Phase Boundary

Dev triggers + scenarios + 5-persona fixtures for QA. Plus daily-batch.ts cutover from legacy queryMatchingJobs to v16.

**REQ-IDs:** DEV-01, DEV-02, DEV-03, DEV-04 (4)

**In scope:**
- `__PA_FIND_MATCH__` iMessage trigger forces `generateJobRecs` execution (mirror `__PA_RESET__` D14)
- Scenario runner `tests/scenarios/runner.mjs` gains `--user-id <uid>` flag
- `dump-outbound-tail.mjs` extended with `--include-rerank-cache`
- 5-persona fixture set under `tests/fixtures/v1.6-personas/` (SWE / PM / Designer / ML / Data Analyst)
- daily-batch.ts cutover: replace legacy queryMatchingJobs call with queryMatchingJobsV16
- Tests + scenario verification

**Out of scope:**
- QA evaluator weekly run (Phase 61)
- Documentation (Phase 62)

</domain>

<decisions>
## Implementation Decisions

### __PA_FIND_MATCH__ trigger (DEV-01, D14)
- Detect token in inbound message body in sendblue webhook (mirror __PA_RESET__ pattern)
- On detect: force-call `generateJobRecs` for the user, bypass coalesce, return immediate match recommendation
- Dev-only — only fires for users in `PA_ADMIN_USER_IDS` env or test number list
- Logs `pa.dev_trigger.find_match` for telemetry

### Scenario runner --user-id (DEV-02)
- `tests/scenarios/runner.mjs` adds `--user-id <uid>` arg
- When provided: scenario uses real user's `pa-users.tags` instead of synthetic
- Useful for "Adam" and other real users to validate match flow

### dump-outbound-tail.mjs --include-rerank-cache (DEV-03)
- New flag adds `pa-user-rerank-cache/{userId}` and `pa-user-skill-jdrel-cache/{userId}/jobs/{jobId}` reads to output
- Useful for debugging match path post-Phase 58

### 5-persona fixtures (DEV-04)
- `tests/fixtures/v1.6-personas/swe.json` — SWE (Adam profile)
- `tests/fixtures/v1.6-personas/pm.json` — Product Manager
- `tests/fixtures/v1.6-personas/designer.json` — Designer
- `tests/fixtures/v1.6-personas/ml.json` — ML Engineer
- `tests/fixtures/v1.6-personas/data_analyst.json` — Data Analyst
- Each fixture: `{ userTags: { ...Phase 52 schema }, expectedRoleFunction: [...], expectedIndustrySector: [...], notExpectedRoles: [...] }`
- Used by scenario runner + future QA evaluator (Phase 61)

### daily-batch.ts cutover
- Replace legacy `queryMatchingJobs` import with `queryMatchingJobsV16`
- Update result handling for new ScoreBreakdown shape
- Verify behavior on existing scenarios
- Keep legacy queryMatchingJobs file as deprecated (can delete in v1.7)

### Tests
- Unit test for trigger detection
- Unit tests for scenario runner --user-id (mock Firestore)
- Unit tests for dump-outbound-tail --include-rerank-cache
- Fixture validation tests (each fixture conforms to schema)
- Smoke test for daily-batch with V16 query

</decisions>

<code_context>
## Existing Code Insights

### Files to extend
- `apps/functions/src/sendblue/webhook.ts` — inbound message handler (find __PA_RESET__ pattern + add __PA_FIND_MATCH__)
- `tests/scenarios/runner.mjs` — scenario runner main
- `tests/scenarios/dump-outbound-tail.mjs` — debug helper
- `apps/job-rec/src/daily-batch.ts` — Phase 56 cutover target (currently uses legacy queryMatchingJobs)

### Existing __PA_RESET__ pattern
- Search webhook.ts for `__PA_RESET__` to find detection logic
- Mirror that exact pattern (token detect + force action)

### Existing scenario fixtures
- `tests/scenarios/playbooks-iter30/` — iter30 playbooks (model)
- `tests/scenarios/eval-adam-real-cv-en.yaml` — Adam scenario
- `tests/fixtures/` — may not exist yet

</code_context>

<specifics>
## Specific Ideas

- 5-persona fixtures use real-ish names: e.g., "SWE_Adam", "PM_Cathy", "Designer_Diego", "ML_Maya", "DA_David"
- Scenario runner --user-id reads pa-users.tags directly via firebase-admin
- daily-batch cutover: a/b verify by running both paths on 5 users, compare top 5, log differences
- __PA_FIND_MATCH__ also useful for production (Adam can iMessage himself "__PA_FIND_MATCH__" to force-trigger)

</specifics>

<deferred>
## Deferred Ideas

- Match-debug live-tester UI (v1.7)
- Persona variant generator (v1.7 — random user gen for stress test)

</deferred>
