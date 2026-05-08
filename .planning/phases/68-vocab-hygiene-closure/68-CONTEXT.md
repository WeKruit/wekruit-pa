# Phase 68: Vocab hygiene closure - Context

REQ-IDs: HYGIENE-01..04 (4)

**Status:** Shipped 2026-05-06 (`a7bf6c5`). Verified: [.planning/v1.7-MILESTONE-AUDIT.md](../../v1.7-MILESTONE-AUDIT.md).

**Goal:** Delete legacy `apps/job-rec/src/tools/query-matching-jobs.ts`. Tighten seniorityLevel + jobType regex on matching-jobs corpus. Backfill remaining ~38 parsedCandidateResumes canonical fields.

**In scope:**
1. Delete `apps/job-rec/src/tools/query-matching-jobs.ts` (V16 sole path post-Phase 60). Update `apps/job-rec/src/index.ts` exports.
2. Audit `apps/functions/src/orchestrator-deps.ts` + any other callers — verify only V16 imported.
3. Tighten `apps/functions/scripts/backfill-seniority-level.mjs` regex: `Entry Level`, `New Grad, Entry Level`, `Entry, Mid Level` etc → canonical `entry_level` / `new_graduate`. Re-run.
4. New script `apps/functions/scripts/backfill-canonical-industries-on-cv.mjs` — for parsedCandidateResumes missing `industries` (canonical), translate legacy `industryTags` via mapper. DRY-RUN + --apply.
5. Tests + smoke V16 flow post-deletion.
