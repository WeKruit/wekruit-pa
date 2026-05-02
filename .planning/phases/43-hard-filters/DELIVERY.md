# Phase 43 — Hard Filters using statedPreferences (v1.5 Stream-C / D4+D5)

**Status**: D1+D2+D3+D4+D5 SHIPPED.
**Spawned**: 2026-05-02 (P10 → P8 → P7-C)
**Owner**: P7-C (this delivery)
**Branch**: main (commit below)
**Depends on**: Phase 44 (`User.statedPreferences` map shipped in commit `b1b0468`).

---

## Scope shipped

| ID | Deliverable | Status |
|----|-------------|--------|
| D1 | `applyHardFilters(profile, jobs)` in `apps/job-rec/src/tools/query-matching-jobs.ts` — 4 rules: YoE / research / visa / location | DONE |
| D2 | 0-survival fallback ladder (`applyHardFiltersWithFallback`) — 4 tiers: full → drop location → drop location+research → prev-7-day jobs | DONE |
| D3 | College-student smart fallback (`inferCollegeStudent` + `isStillInSchool`) — handles users who haven't done Phase 44 onboarding probe v2 yet | DONE |
| D4 | 8 brief-spec tests + 13 helper smoke tests in `apps/job-rec/src/__tests__/tools/query-matching-jobs.test.ts` | DONE (21 new tests; 161 total tests pass) |
| D5 | Wire-in to `daily-batch.ts` — `paHardFiltersEnabled` flag-gate + `DailyPushContext.fallbackMode` plumbing + Variant D opener in `formatDailyPushBody` | DONE |

---

## Schema reality adaptation

The brief refers to `job.seniority_level`, `job.role_title`, `job.qualifications`. The actual `MatchingJobSchema` (Stream B shape) carries `jobTitle`, `requiredSkills`, `locationRaw`, `sponsorship` — no `seniority_level` or free-text `qualifications` field. Mapping used:

| Brief field | Actual signal used | Notes |
|-------------|--------------------|-------|
| `seniority_level ∈ {senior, staff, …}` | `SENIOR_TITLE_REGEX.test(jobTitle)` | Bilingual zh/en regex; covers `senior/sr./staff/principal/director/vp/lead/tech lead/architect` + `资深/高级/主管/总监/首席/架构师`. |
| Research keyword bank in `role_title` ∪ `qualifications` | `RESEARCH_KEYWORDS_REGEX.test(jobTitle ∪ requiredSkills)` | en: `research(er)/scientist/phd/postdoc/applied scientist/research engineer`; zh: `研究/科研/博士/科学家`. |
| No-sponsorship bank in `qualifications` | `NO_SPONSORSHIP_KEYWORDS_REGEX.test(jobTitle ∪ requiredSkills)` AND corpus `sponsorship === false` boolean | en: `us citizen only/no sponsorship/must have green card/gc only/need US citizenship`; zh: `公民/绿卡/不提供 签证 sponsorship 赞助`. |
| Location | `locationRaw` + Phase 39 H7 `LOCATION_NEIGHBORS` ladder | Reuses existing primitive — no new neighbor table. |

This is **proper-fix-vs-workaround**: rather than pollute `MatchingJobSchema` with un-populated fields the corpus doesn't actually carry today, we route to the closest-fit existing fields and document the mapping.

---

## Files modified

```
apps/job-rec/src/tools/query-matching-jobs.ts                (+~310 lines: types, keyword banks, parsers, applyHardFilters, fallback orchestrator, flag key)
apps/job-rec/src/daily-batch.ts                              (+~120 lines: imports, hard-filter call site in runDailyJobRecBatch, loadHardFilterProfile, fetchPrevious7DayJobs, DailyPushContext.fallbackMode field, Variant D branch in formatDailyPushBody)
apps/job-rec/src/__tests__/tools/query-matching-jobs.test.ts (+~290 lines: 21 new tests — 8 D4-spec + 13 helper smoke)
.planning/phases/43-hard-filters/DELIVERY.md                 (this file)
```

Net: ~720 lines added. Zero existing logic deleted. ZERO regression — full test suite (161 tests) green.

---

## Constraints met

| Constraint | Status |
|-----------|--------|
| ZERO new LLM calls | YES — pure regex + set ops. |
| Behind flag `paHardFiltersEnabled` (default OFF) | YES — `getFlag(... HARD_FILTERS_FLAG_KEY ..., false)` in `daily-batch.ts:run`. |
| Bilingual zh/en | YES — every keyword regex carries both, tested in `RESEARCH_KEYWORDS_REGEX/NO_SPONSORSHIP/SENIOR_TITLE_REGEX` smoke tests. |
| Latency < 50ms over 100 jobs | YES — measured ~0.5ms for `applyHardFilters` over 100 synthetic jobs (regex compiled once at module load; per-job is ~5 ops). The prev-7-day fetch is an extra Firestore read (~30-50ms) but only fires on the rare 0-survival tier. |
| ZERO regression on existing daily-batch path | YES — `paHardFiltersEnabled === false` (default) → `hardFilteredJobs := queryRes.jobs` no-op, downstream byte-identical. All 7 existing daily-batch tests pass unchanged. All 12 H13 tests pass unchanged. Phase 42 explainer regression test passes unchanged. |
| Coordinate with H13 (commit `bc8863c`) Variant A/B/C | YES — Variant D is a NEW prepended branch; the original A/B/C router runs untouched when `ctx.fallbackMode !== true`. |

---

## Test count

```
161 tests pass · 0 fail · 0 skipped (was: 140 pre-Phase-43)
+21 new tests (8 D4-spec + 13 helper smoke)
```

Brief D4 8-test checklist:

- [x] College student + senior job → dropped
- [x] YoE 5y + senior job → kept
- [x] Researcher pref + research job → kept
- [x] Researcher pref + non-research job → dropped (only when explicit prefs say research-only)
- [x] sponsorship_needed + "no sponsorship" job → dropped (text marker AND `sponsorship === false`)
- [x] sponsorship_needed + sponsor-friendly job → kept
- [x] 0-survival fallback → returns previous-7-day jobs
- [x] 0-survival → flag passed back to daily-batch indicating fallback mode

---

## Rollout plan

Default OFF. Ramp via the `pa-feature-flags/paHardFiltersEnabled` flag doc.

```bash
# Step 1 — verify flag doc exists (create if not)
gcloud firestore documents describe \
  "projects/wekruit-pa/databases/(default)/documents/pa-feature-flags/paHardFiltersEnabled" \
  || gcloud firestore documents create \
     --collection-id=pa-feature-flags \
     --document-id=paHardFiltersEnabled \
     --json-data='{"enabled":false,"rollout":0,"updatedAt":"'$(date -u +%FT%TZ)'"}'

# Step 2 — 1% canary (24h soak; monitor `[job-rec-daily] hard_filter_applied` log)
gcloud firestore documents update \
  "projects/wekruit-pa/databases/(default)/documents/pa-feature-flags/paHardFiltersEnabled" \
  --update-mask=rollout \
  --json-data='{"rollout":1}'

# Step 3 — 10% (24h soak; check delivered counts vs prior baseline)
# rollout=10

# Step 4 — 50% (24h)
# rollout=50

# Step 5 — 100% on
# {"enabled":true, "rollout":100}
```

### Monitor metrics (Cloud Logging)

- `[job-rec-daily] hard_filter_applied { before, after, relaxLevel }` — non-zero `before-after` proves filter is firing
- `[job-rec-daily] hard_filter_fallback_prev7d` — fallback rate; should be < 5% on warm corpus
- `delivered` count vs prior 7-day baseline — should stay within ±5% (filters trade off some breadth for fit; large drop = corpus too narrow for current population)
- User-reported "irrelevant job" rate (manual triage queue) — should drop noticeably for college-student / sponsorship cohorts

### Rollback

Set `rollout: 0` (or `enabled: false`). 30s cache → next-batch invocation reads new value. Behavior reverts to pre-43 byte-identical.

---

## Tech debt logged

1. **`MatchingJobSchema.qualifications` field absent** — the corpus doesn't carry free-text `qualifications` today; visa-block uses `jobTitle ∪ requiredSkills` as a proxy. If/when crawlers populate `qualifications` (or normalize a `seniority_level` enum), `applyHardFilters` should grow regex match against those richer fields. Owner: enrichment crawler / Stream H/F. Tracked: this DELIVERY.md.

2. **prev-7-day cross-day repeat suppression** — when fallback triggers on consecutive days, the same prev-7-day rows can be re-pushed. Day-level idempotency via `${userId}-${todayYmd}-batch` keeps the message itself unique, but content can repeat. Future work: track per-user `lastFallbackJobIds` to dedupe across days. Owner: Stream-C follow-up.

3. **`fetchPrevious7DayJobs` ignores `industryTags`** — the param is reserved (`void industryTags`) but the prev-7-day query is intentionally wide (recall over precision in fallback). Possible future tightening if monitoring shows fallback content is too off-topic. Owner: Stream-C follow-up.

4. **College-student inference is heuristic, not statedPreferences-backed** — `inferCollegeStudent` reads CV experiences[]. Once Phase 44 onboarding probe v2 ramps to 100% and `yoeRange` is populated for >95% of users, the CV-fallback branch can be deprecated. Owner: post-Phase-44-100% cleanup.

---

## Audit trail

- P10 brief: in this thread (Adam directive: don't ask, ship)
- Methodology: P7-protocol three-step (方案 → 实施 → 审查)
- Self-review: see commit body
- Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
