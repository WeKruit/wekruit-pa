# Phase 56: queryMatchingJobs read pa-users.tags + filter + score - Context

**Gathered:** 2026-05-06
**Status:** Ready for planning
**Mode:** Decisions D1, D7, D8, D9, D10 locked

<domain>
## Phase Boundary

`generateJobRecs` reads exclusively from `pa-users.tags` (no legacy fragmented reads). Firestore query: `where('roleFunction', 'array-contains-any', user.targetRoleFunction)` + `orderBy firstSeenAt desc` + limit raised 50 → 500. Hard post-filter chain. Soft score weights per D9. Per-skill `skill_jaccard` = base × JD-relative weight (Qwen-7B nightly cache, written by Phase 58). Per-job reasoning shows top-2 weighted matched skills + reason. **`lastSeenAt` deprecated** — 20d `firstSeenAt` window only.

**REQ-IDs:** MATCH-01, MATCH-03..MATCH-08 (7)

**In scope:**
- Rewrite `apps/job-rec/src/tools/query-matching-jobs.ts` 1907 lines: single-source read + new query + new hard filter + new soft score + per-job reasoning
- Read user tags from `pa-users/{userId}.tags` only (no legacy fragmented reads)
- Update `apps/job-rec/src/match-weights.ts` with v1.6 weight table
- Update `apps/job-rec/src/match-explainer.ts` for top-2 reasoning
- Update `apps/job-rec/src/types.ts` for new schema
- Replace legacy `industryEnum`/`industryKey` reads with `industrySector` from migration (Phase 55)
- Wire JD-relative weight cache reader (cache populated by Phase 58, but reader handles missing-cache gracefully)
- Tests + scenario verification

**Out of scope:**
- Liveness/404 daily sweep (Phase 57)
- LLM rerank nightly batch (Phase 58 — produces the cache this phase reads)
- Dashboards (Phase 59)

</domain>

<decisions>
## Implementation Decisions

### Single-source read (MATCH-01, D8)
- `loadUserTags(db, userId)` reads `pa-users/{userId}.tags` (single doc field)
- Returns Phase 52 schema: `{ skills, targetRoleFunction, industrySector, relevantIndustry, relevantSpecialization, proposedTags, visaStatus, targetLocations, jobType, careerStage, yoeRange, prefersStartup, preferredLang, embedding, ... }`
- If tags doc missing OR empty → return `null`, caller short-circuits with empty result + log `pa.match.user_no_tags`
- NO reads from: `pa-users.statedPreferences`, `parsedCandidateResumes.industryTags`, `parsedCandidateResumes.topSkills`, `parsedCandidateResumes.embedding` (all fragmented sources DEPRECATED)
- The `matching-jobs` consumer reads `parsedCandidateResumes.embedding` is the ONE exception — embedding lives there for now (Phase 54 also writes to `tags.embedding`, prefer that)

### Query layer (MATCH-03)
- `where('roleFunction', 'array-contains-any', user.targetRoleFunction)` — D1 hard filter, push to query layer
- `where('status', '==', 'active')` — preserved
- `orderBy('firstSeenAt', 'desc')` — D10 (NOT lastSeenAt)
- `limit(500)` — raised from 50
- If `targetRoleFunction.length === 0` → fall back to no-roleFunction filter (admin/test users)
- If `targetRoleFunction.length > 10` → Firestore `array-contains-any` cap is 30; we cap to first 10 (most-relevant)

### Hard post-filter chain (MATCH-04)
In order:
1. **visa intersect** — `if (job.sponsorship === false && user.visaStatus === 'sponsor_needed')` → drop
2. **location intersect (anywhere bypass)** — if `user.targetLocations.includes('remote_anywhere')` OR `user.targetLocations.includes('remote_global')` → bypass; else compute `job.locationBuckets ∩ user.targetLocations` non-empty
3. **careerStage window** — match user.careerStage against `job.seniorityLevel` adjacency window (entry → entry/junior, junior → entry/junior/mid, etc) using `acceptableCareerStages()` Phase 52 helper
4. **jobType exact match** — `user.targetJobType.includes(job.jobType)` (exact intersect)
5. **firstSeenAt < 20d** — `Date.now() - job.firstSeenAt.toMillis() < 20 * 24 * 3600 * 1000`
6. **atsApplyUrl present + not jobright.ai** — `job.atsApplyUrl && !job.atsApplyUrl.includes('jobright.ai')`
7. **dead !== true** — `job.dead !== true`

Each filter logs `pa.match.dropped.{reason}` with count for observability.

### Soft score (MATCH-05, MATCH-06)
Weights per D9:
```ts
export const V16_SCORE_WEIGHTS = {
  llm_match: 0.40,         // Qwen-7B nightly cache (Phase 58)
  skill_jaccard: 0.20,     // base × JD-relative weight (Phase 58)
  relevant_tags: 0.15,     // overlap user.relevantTags ∩ job.relevantTags (job-side will be added by Phase 58 or manual JD parse)
  industry_sector: 0.10,   // overlap user.industrySector ∩ job.industrySector (post-Phase 55 migration)
  cv_emb_cosine: 0.10,     // user.embedding · job.embedding
  salary_fit: 0.05,        // user.minSalary vs job.salaryMin
}
```

Score function:
```ts
function scoreJob(user: UserTags, job: MatchingJob, jdRelativeWeights?: Record<string, number>, llmRerankCache?: number) {
  const llm = llmRerankCache ?? 0  // missing cache → 0 (Phase 58 fills)
  const skillJaccard = computeSkillJaccard(user.skills, job.requiredSkills, jdRelativeWeights)
  const relTags = computeOverlap(user.relevantTags, job.relevantTags ?? [])
  const indSector = computeOverlap(user.industrySector, job.industrySector ?? [])
  const cvEmb = cosineSim(user.embedding, job.embedding) ?? 0
  const salaryFit = computeSalaryFit(user.minSalary, job.salaryMin)
  
  return llm * 0.40
       + skillJaccard * 0.20
       + relTags * 0.15
       + indSector * 0.10
       + cvEmb * 0.10
       + salaryFit * 0.05
}
```

`computeSkillJaccard` = `Σ(matched skill base × JD-rel weight) / Σ(all user skill base × JD-rel weight)`. Without JD-rel cache (Phase 58 not yet running), JD-rel = 1.0 → degrades to plain weighted Jaccard.

### Per-job reasoning (MATCH-07)
For each top-N job, compose `reason` string:
- Pick top 2 skills with highest matched-weight (base × JD-rel × matched-flag)
- Format: `"Top match on Python (你 advanced) and TypeScript (你 expert), 都是核心 JD 技能"` (zh) / `"Top match on Python (advanced) and TypeScript (expert), both core JD skills"` (en)
- Update `match-explainer.ts` to consume new score breakdown shape

### lastSeenAt deprecation (MATCH-08)
- All filters use `firstSeenAt` only
- Migration: any code path reading `lastSeenAt` for freshness → switch to `firstSeenAt`
- Audit: grep for `lastSeenAt` in `apps/job-rec/`, `apps/functions/src/`, refactor or delete

### Tests + scenario verification
- Unit tests for each filter + scoring fn
- Scenario test: `tests/scenarios/eval-adam-real-cv-en.yaml` — Adam's real CV → expected SWE roles, no BDR/sales/cashier leak
- Audit existing tests under `apps/job-rec/src/__tests__/tools/query-matching-jobs.test.ts` — update for new schema

</decisions>

<code_context>
## Existing Code Insights

### Files to rewrite (substantial)
- `apps/job-rec/src/tools/query-matching-jobs.ts` (1907 lines) — main impl
- `apps/job-rec/src/types.ts` (320 lines) — schema (add UserTags type, update MatchingJob)
- `apps/job-rec/src/match-weights.ts` (261 lines) — weights table
- `apps/job-rec/src/match-explainer.ts` (800 lines) — reasoning composer

### Files to update lightly
- `apps/job-rec/src/daily-batch.ts` — uses queryMatchingJobs; signature update propagates
- `apps/job-rec/src/index.ts` — re-exports

### Files to AUDIT and possibly delete
- Legacy `TAG_TO_INDUSTRY_KEY` mapping in query-matching-jobs.ts lines 73-103 — replaced by single industrySector axis
- `mapTagToIndustryKeys`, `expandIndustryTags` helpers — likely deprecated

### Reusable
- `packages/shared-tags/src/canonical/career-stage.ts` — `acceptableCareerStages()` adjacency
- Phase 54 onboarding-mappers.ts (ROLE_FUNCTION mapping)
- Phase 55 matching-jobs-mappers.ts (legacy → canonical)
- Phase 53 pa-resume-parser v2 — produces tags.skills with proficiency + baseWeight
- `apps/functions/src/lib/llm-rerank.ts` — Qwen-7B JSON wired (iter34 G.4 + H.2)

### Cache reader
- `pa-user-rerank-cache/{userId}` — Phase 58 produces; this Phase 56 reads:
  - `{ ranked: [{ jobId, llmScore }], computedAt }`
  - Stale if `computedAt < now - 36h`, fall back to score without llm_match (use 0)
- `pa-user-skill-jdrel-cache/{userId}/{jobId}` — Phase 58 produces; this Phase 56 reads:
  - `{ jdRelativeWeights: Record<string, number> }`
  - Missing → use 1.0 default (degrades to plain Jaccard)

</code_context>

<specifics>
## Specific Ideas

- Backward compat: `queryMatchingJobs` keeps signature stable for `daily-batch.ts` consumer; just internals rewritten
- Score breakdown returned per job for dashboard/admin debugging
- Logging: emit `pa.match.score_breakdown` event with `{userId, jobId, llm, skill, rel, ind, emb, salary, total}` for top-N jobs (sample 10%)
- Test fixture: Adam's CV (`e5d97cd8-1e1d-439d-8672-3008f8aeef2e`, parsedCandidateResumes docId `rQIqQEghvZLwVkMad2lJ`) — load tags, query matching-jobs, verify SWE recommendations + no BDR leak
- Salary fit: simple linear `min(1, max(0, (job.salaryMin - user.minSalary) / 50000 + 1))` (above target = 1, below by $50K = 0)

</specifics>

<deferred>
## Deferred Ideas

- LLM rerank cache producer (Phase 58 — this phase reads + handles missing cache)
- Dashboard match-debug page (Phase 59)
- Multi-location distance weighting (REQUIREMENTS line 110, v2.0)
- Skill similarity embedding (REQUIREMENTS line 111, v2.0)

</deferred>
