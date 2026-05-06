# Phase 70: Match-debug admin UI - Context

REQ-IDs: MATCHDEBUG-01..04 (4)

**Goal:** New admin page `/admin/match-debug`. Admin enters userId → live V16 query result with full ScoreBreakdown per job + drop-counter visualization + per-job inspector + score weight tuning sandbox.

**In scope:**
- New page `apps/dashboard-web/src/pages/MatchDebug.tsx`
- Backend CF `paAdminMatchDebug` (admin-only) — wraps queryMatchingJobsV16 + returns full breakdown
- Per-job inspector: shows all 7 hard-filter gates' decisions + soft score breakdown + JD-rel weights
- Score weight slider sandbox — adjust weights live, preview top-5 reranking; save to `pa-match-weight-overrides/{userId}` for testing
- Side-by-side V16 vs legacy diff (until legacy fully deleted)
- Tests + hosting deploy

**Pattern:** Follow Phase 59 `CanonicalTags.tsx` admin-only auth + Firestore client + httpsCallable.
