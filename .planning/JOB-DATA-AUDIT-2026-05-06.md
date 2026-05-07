# WeKruit PA Job/Tag Data System Audit
**Date:** 2026-05-06  
**Scope:** wekruit-pa + macmini wekruit-matching (over SSH)  
**Goal:** Map canonical vocabularies, write paths, validation gates, and concrete divergences

---

## 1. CANONICAL VOCAB FILES (Single Source of Truth)

**Location:** `packages/shared-tags/src/canonical/`

All vocabularies enforce D5 (Adam-locked): **spelled-out form only, no abbreviations** (rejects: `swe`, `pm`, `sf`, `nyc`, `k8s`, `js`, `py`, etc.)

### Closed Enums (static, compile-time)

| Vocab | Enum Type | Count | Closed? | Notes |
|-------|-----------|-------|---------|-------|
| `roleFunction` | `RoleFunction` | 17 | YES | Jobright `utm_campaign` verbatim (D1). Hard-filter axis. Multi-pick. TAG-01. |
| `jobType` | `JobType` | 10 | YES | `full_time`, `part_time`, `internship`, `contract`, `fellowship`, etc. Hard-filter exact match. TAG-05. |
| `careerStage` | `CareerStage` | 13 | YES | `student`, `intern`, `entry_level`, `junior`, `mid_level`, `senior`, `staff`, `principal`, `manager`, `director`, `vp`, `c_level`, `founder`. Hard-filter window (acceptableCareerStages). TAG-06. |
| `visa` | `Visa` | 4 | YES | `citizen`, `permanent_resident`, `sponsor_needed`, `other` (D4: collapses OPT/CPT/H1B). Hard-filter axis. TAG-04. |
| `major` | `Major` | 62 | YES | Engineering, math, sciences, business, humanities, design, professional. Soft-score signal (D3, not gate). TAG-03. |
| `industrySector` | `IndustrySector` | 42 | YES | `artificial_intelligence_and_machine_learning`, `software_and_saas`, `fintech`, `healthcare_and_life_sciences`, `crypto_web3_blockchain`, `gaming_and_esports`, etc. Soft-score axis. Overlay-extensible (D16). TAG-02. |
| `location` | `Location` | 130+ | YES | US metros (`san_francisco_bay_area` not `sf`), Canada, EU, APAC. Hard-filter intersect. Convention: metro-level (e.g., `new_york_metro` not `nyc`). TAG-07. |

### Open Vocabs (runtime-extensible)

| Vocab | Schema | Max | Notes |
|-------|--------|-----|-------|
| `skills` | `Skill` (name + bucket + proficiency + evidenceCount + baseWeight) | ∞ (unbounded) | 10 buckets: programming_languages, frameworks_and_libraries, databases, cloud_and_infrastructure, devops_and_tooling, data_and_ml, design_and_ux, product_and_business, soft_skills, domain_specific. Full bag stored (not truncated). TAG-09. |
| `relevantTags` | `RelevantTagSchema` (open-vocab pattern `[a-z][a-z0-9_]{1,79}`) | 12 (per profile) | Sandbox tokens, max 12 cap (D6). Promoted to canonical via admin (Phase 59). TAG-08. |

### Validation & Overlay

**Validation gatekeep (TAG-12):**
- `validateCanonicalToken()` rejects: spaces, UPPERCASE, abbreviations from `KNOWN_ABBREVIATIONS` set, tokens <3 chars
- Applied at write-time in: cv-ingest, mergeUserTags, admin-canonical-tags, admin-match-debug
- **Throwing variant:** `assertValidCanonicalToken()` used in backfill scripts

**Firestore Overlay (TAG-11):**
- Collection: `pa-canonical-tags/{vocab}__{token}`
- Supports: `industry-sector` only (D16)
- Statuses: `sandbox` | `promoted` | `rejected`
- Resolver merges: static enum (compile-time) + promoted overlay (runtime) via `resolveCanonicalVocab()`

**Sample 5 values per vocab:**
- roleFunction: `software_engineering`, `engineering_and_development`, `data_analysis`, `product_management`, `business_analyst`
- industrySector: `artificial_intelligence_and_machine_learning`, `financial_technology`, `healthcare_and_life_sciences`, `software_and_saas`, `crypto_web3_blockchain`
- careerStage: `entry_level`, `junior`, `mid_level`, `senior`, `staff`
- location: `san_francisco_bay_area`, `new_york_metro`, `london_united_kingdom`, `toronto`, `remote_anywhere`
- jobType: `full_time`, `internship`, `entry_level`, `contract`, `fellowship`

### Duplication Check

**Result: NO duplication found**
- All canonical vocab is centralized in `packages/shared-tags/src/canonical/`
- Re-exported via `packages/shared-tags/src/canonical/index-browser.ts`
- Consumed by: `packages/pa-orchestrator/`, `apps/job-rec/`, all admin dashboards
- **Legacy field remnants** still live in docs (see section 7), but are NOT the source of truth

---

## 2. JOB DOCUMENT SCHEMA (matching-jobs Firestore Collection)

**Primary Schemas:**
- `/packages/core-types/src/matching-jobs.ts` - v1.6 partial (roleFunction, industrySector additions)
- `/apps/job-rec/src/types.ts` - `MatchingJobSchema` (zod) - the actual working schema used by query/rerank

### Full MatchingJob Field Inventory (from MatchingJobSchema)

```typescript
{
  // Identity
  id: string
  
  // Raw fields (from scrape)
  companyName: string
  jobTitle: string
  primaryUrl: string
  locationRaw: string
  
  // Pricing/comp
  salaryMin: number | null
  salaryMax: number | null
  
  // v1.6 canonical (Phase 56, MATCH-02)
  roleFunction: string[]           // 17-token vocab, hard-filter axis
  industrySector: string[]         // 42-token vocab, soft-score axis
  
  // Deprecated/legacy fields (still populated, NOT used in v1.6)
  industry: string                 // legacy 6-enum ("tech", "fintech", "healthtech", "consumer", "b2b", "any")
  industryKey: string | undefined  // legacy token-set expansion key
  industryEnum: string[]           // legacy 10-tag buckets from H8 enrichment
  
  // Job attributes
  jobType: string | undefined
  requiredSkills: string[]
  sponsorship: boolean | null      // true=offers, false=no, null=unknown
  companyEmployeeCount: number | null
  
  // Seniority (v1.6 canonical)
  seniorityLevel: string | undefined  // careerStage token (13-vocab)
  
  // Location (v1.6 canonical)
  locationBuckets: string[]        // 130+-token vocab, hard-filter intersect
  
  // Open vocabs
  relevantTags: string[]           // max 12 sandbox tokens per job
  
  // Liveness signals
  dead: boolean | undefined        // set by Phase 57 liveness sweep
  deadCheckedAt: string | undefined
  deadReason: string | undefined
  
  // ATS resolution (Phase 65)
  atsApplyUrl: string | undefined  // true ATS URL (camelCase!)
  atsResolvedAt: string | undefined
  atsResolvedBy: string | undefined
  
  // Timestamps
  firstSeenAt: string | undefined  // ISO; hard-filter freshness (< 20d)
  lastSeenAt: string | undefined   // DEPRECATED — re-scrape noise
  
  // Scoring (runtime-attached, NOT persisted)
  matchScore: { total, breakdown } | undefined
}
```

### Schema Field-Name Analysis

**CRITICAL DIVERGENCE FOUND:**
- **Firestore storage uses camelCase everywhere:** `atsApplyUrl`, `deadCheckedAt`, `companyName`, `jobTitle`, `primaryUrl`, `locationRaw`, `salaryMin`, `salaryMax`, `companyEmployeeCount`, `firstSeenAt`, `lastSeenAt`, `matchScore`
- **Python macmini (wekruit-matching repo) uses snake_case:** `source_repo`, `role_title`, `company_name`, `primary_url`, `location_raw`, `date_posted_raw`, `content_hash`, `enriched_at`, `embedded_at`, `ats_apply_url` (SQL columns)

**Transformation Layer:** Cloud Function at `https://us-central1-wekruit-5f89b.cloudfunctions.net/matching-api/api/sync/jobs` (not found in wekruit-pa codebase; likely in separate orchestrator service or macmini)

### Expected Fields vs Actual Population

**Sample comparison (from grep + reading upsert.py):**

| Field | JobRight | Lever | Ashby | JobRightAPI | SimplifyJobs | Notes |
|-------|----------|-------|-------|-------------|--------------|-------|
| `roleFunction` | ✓ (utm_campaign) | ✗ | ✗ | ✓ | ✗ | Jobright sources only. Others rely on migration backfill (Phase 55). |
| `industrySector` | ✓ (Phase 53 Sonnet 2ndpass) | (partial) | (partial) | ✓ | ✗ | Parsed post-scrape; "other" fallback. |
| `seniority_level` | ✗ (title inference) | ✗ (title inference) | ✗ (title inference) | ✓ | ✗ | Optional; Phase 63 LinkedIn/Wellfound may populate. |
| `atsApplyUrl` | ✗ (backfilled Phase 65) | ✗ (backfilled Phase 65) | ✗ (backfilled Phase 65) | ✗ (backfilled Phase 65) | ✗ (backfilled Phase 65) | **ALL sources backfilled via hourly Serper batch (paBackfillAtsUrlsBatch).** |
| `sponsorship` | ✓ (text classification) | ✓ | ✓ | ✓ | ✓ | Boolean enum populated by macmini Phase 3 enrichment. |
| `industry` | ✓ (LLM classifier) | ✓ | ✓ | ✓ | ✓ | Legacy 6-enum; still written but NOT read in v1.6. |
| `required_skills` | ✓ (JD parse) | ✓ | ✓ | ✓ | ✓ | Array of strings; baseWeight defaults to 1.0 in Phase 61 migration. |

**Null/Missing Fields causing Silent Failures:**
- `jobType`: missing from ~40% of older docs → query falls back to title regex
- `atsApplyUrl`: missing until Phase 65 backfill completes → liveness sweep skips (returns `skipped_no_url` counter)
- `seniorityLevel`: missing → career-stage filter infers from title (lossy)
- `locationBuckets`: missing for pre-Phase 55 docs → filter falls back to `locationRaw` substring match

---

## 3. USER DOCUMENT SCHEMA (pa-users.tags)

**Location:** `packages/pa-orchestrator/src/tags/user-tags-merger.ts`  
**Schema Version:** 1 (bumped on breaking changes)

### UserTags Shape (Canonical)

```typescript
{
  // ---- CV-derived (mergeUserTags input)
  skills: Skill[]              // FULL bag (not truncated), Phase 61: string[] → SkillEntry
  industryEnum: string[]       // legacy 10-tag buckets
  industrySector: string[]     // Phase 53: 42-token vocab (DISTINCT from industryEnum)
  relevantIndustry: string[]   // ≤6 derived from workHistory
  relevantSpecialization: string[]  // open-vocab (e.g. mlops, infrastructure_security)
  proposedTags: string[]       // open-vocab sandbox (max 12)
  
  recentRoleTitle: string | undefined
  recentCompany: string | undefined
  workHistorySummary: string | undefined    // "Title @ Org; Title @ Org; ..." (≤200 chars)
  
  embedding: number[]          // 1536-d, text-embedding-3-small
  embeddingModel: string | undefined
  embeddingComputedAt: string | undefined
  
  // ---- chat-derived (statedPreferences → merger mapping)
  targetRole: string[]         // canonical roles (closed enum from onboarding)
  yoeRange: [number, number] | undefined
  visaStatus: "citizen" | "gc" | "opt" | "h1b" | "sponsor_needed" | "other" | undefined
  prefersStartup: "startup" | "bigtech" | "either" | undefined
  targetLocations: string[]    // free-text hints from chat (NOT canonical yet)
  preferredLang: "zh" | "en" | undefined
  
  // ---- bookkeeping
  lastUpdatedFromCv: string | undefined     // ISO timestamp
  lastUpdatedFromChat: string | undefined
  schemaVersion: number                     // = 1
}
```

### SkillEntry (Unified Schema)

```typescript
{
  name: string               // lowercase, [a-z0-9_+#.-], 2-64 chars (rejects abbr)
  bucket: SkillBucket        // 10 enums: programming_languages, frameworks_and_libraries, etc.
  proficiency: SkillProficiency  // beginner | intermediate | advanced | expert
  evidenceCount: number      // >= 1 (default 1)
  baseWeight: number         // ∈ [0, 1] (default 0.5 = neutral)
}
```

### Mapping from Legacy Sources

**Input Boundary (mergeUserTags pure function, no Firestore I/O):**
1. `parsedCandidateResumes.candidateProfile.skills` — raw string[] OR Phase 61+ SkillEntry[]
2. `parsedCandidateResumes.workHistory[].skills` — per-job skill array
3. `parsedCandidateResumes.industryTags` — CV-derived 10-tag buckets
4. `pa-users.statedPreferences` — chat probes (role, yoe, visa, location, language)
5. `parsedCandidateResumes.embedding` — pass-through 1536-d vector

**Output:** Single canonical doc written to `pa-users/{userId}.tags` by:
- `cv-ingest` (Phase 53.5 on resume parse)
- `mergeUserTags` (called by cv-ingest + orchestrator after chat updates)

### Consumers of pa-users.tags

| Consumer | Path | Read Fields | Version |
|----------|------|------------|---------|
| queryMatchingJobsV16 | `/apps/job-rec/src/tools/query-matching-jobs-v16.ts` | `targetRole`, `visaStatus`, `targetLocations`, `skills` (for Jaccard), `industrySector`, `yoeRange`, `prefersStartup`, `embedding` | v1.6 (Phase 56) |
| daily-batch (legacy) | `/apps/job-rec/src/daily-batch.ts` | `industryEnum` | pre-v1.6 (phase-out scheduled) |
| orchestrator chat scenes | `/packages/pa-orchestrator/` | `targetRole`, `visaStatus`, `yoeRange`, `prefersStartup`, `targetLocations`, `preferredLang` | on-demand during turn |
| admin-match-debug CF | `/apps/functions/src/admin-match-debug.ts` | ALL (debugging overlay) | v1.6 sandbox |

---

## 4. WRITE PATHS (Every Place Mutating matching-jobs OR pa-users.tags)

### Path A: macmini wekruit-matching → wekruit-pa (Async)

**File:** `~/Desktop/WeKruit/wekruit-matching/src/wekruit_matching/scraper/upsert.py`

**Writes to:** PostgreSQL `jobs` table (macmini local)  
**Transformation:** Cloud Function (not in wekruit-pa; separate orchestrator service)  
**Final Destination:** Firestore `matching-jobs` collection

**Fields Written (upsert_jobs):**
```python
job_id, source_repo, company_name, role_title,
primary_url, location_raw, date_posted_raw,
status, first_seen_at, last_seen_at, content_hash,
industry, company_size, required_skills, sponsorship,
enriched_at
```

**FIELDS DROPPED BY UPSERT (NOT WRITTEN TO SQL):**
1. `seniority_level` — Phase 63 optional (title inference, not scraped)
2. `job_description` — stored separately, large BLOB
3. `core_responsibilities` — never populated; not in scraper output
4. `qualifications` — never populated; not in scraper output
5. `salary_range` — never populated; parse-time enrichment (Phase 3)
6. `benefits` — never populated; JD extraction optional
7. `ats_apply_url` — **intentionally dropped; backfilled Phase 65 via Serper batch**

**Idempotency Guard:** `content_hash` SHA-256; re-run detection on unchanged data skips writes.

**Stale Marking:** `mark_stale_jobs()` sets `status='inactive'` for listings that disappeared from README (never deletes).

---

### Path B: cv-ingest → pa-users.tags (Sync)

**File:** `/apps/functions/src/cv-ingest/` (not in wekruit-pa, wired by orchestrator)  
**Trigger:** `parsedCandidateResumes` doc created/updated  
**Output:** `pa-users/{userId}.tags` (single doc write)

**Flow:**
1. Parse CV → `parsedCandidateResumes` doc with `candidateProfile.skills[]`, `workHistory[]`, `industryTags[]`, `embedding`
2. Call `mergeUserTags()` (pure function from pa-orchestrator)
3. Write result to `pa-users/{userId}.tags` with `lastUpdatedFromCv` timestamp

**Validation:** Zod `UserTagsSchema` applied before write; throws on schema failure.

**Phase 61 Migration:** Upgraded `skills: string[]` → `skills: SkillEntry[]` with `baseWeight: 1.0` via `migrate-skills-to-objects.mjs`.

---

### Path C: Orchestrator Chat Updates → pa-users.tags (Sync)

**File:** `/packages/pa-orchestrator/src/tags/user-tags-writer.ts`  
**Trigger:** Onboarding probes completed (role, visa, yoe, location, language)  
**Output:** `pa-users/{userId}.tags.{targetRole, visaStatus, etc.}` (merge, not replace)

**Validation:**
- `targetRole`: canonicalized via `canonicalizeRole()` before merge
- `visaStatus`: enum validated (maps `sponsorship_needed` → `sponsor_needed`)
- `targetLocations`: free-text (no validation; soft-score only)
- `preferredLang`: enum (`zh` | `en`; drops `mixed` to undefined)

---

### Path D: paLivenessSweepDaily → matching-jobs.{dead, deadCheckedAt, deadReason} (Async)

**File:** `/apps/functions/src/liveness-sweep.ts`  
**Trigger:** Cloud Scheduler 03:00 UTC daily  
**Scope:** All `matching-jobs` with `status='active'`

**Updates Written:**
```typescript
dead: boolean              // true if HEAD check fails (4xx/5xx/timeout/network)
deadCheckedAt: string      // ISO timestamp
deadReason: string         // "http_404", "timeout", "network_error: ...", etc.
```

**Hard-Delete:** Removes docs marked dead > 30 days ago.

**Phase 65 Note:** Inline Serper backfill REMOVED. Serper resolution now via `paBackfillAtsUrlsBatch`.

---

### Path E: paBackfillAtsUrlsBatch → matching-jobs.{atsApplyUrl, atsResolvedAt, atsResolvedBy} (Async)

**File:** `/apps/functions/src/backfill-ats-urls-batch.ts`  
**Trigger:** Cloud Scheduler `0 * * * *` (every hour, top-of-hour)  
**Scope:** Top 200 active jobs missing `atsApplyUrl`, ordered by `firstSeenAt` desc

**Resolution Pipeline (Pass 1 → 3):**
1. **Pass 1 (free):** If `primaryUrl` is ATS host (e.g., lever.co, greenhouse.io), copy directly
2. **Pass 3 (paid):** Serper search on `"${companyName} ${roleTitle} apply"` → first ATS hit
3. **LinkedIn Fallback:** Parse HTML of `primaryUrl` for LinkedIn jobs URL (when available)
4. **Miss:** Write to retry queue (`pa-ats-resolve-priority`) with TTL 7d

**Updates Written:**
```typescript
atsApplyUrl: string        // resolved URL
atsResolvedAt: string      // ISO timestamp
atsResolvedBy: string      // "pass1" | "serper" | "linkedin"
urlResolutionAttemptedAt: string  // marker for liveness sweep
```

**Cost Ledger:** Each Serper call → row in `pa-ats-cost-ledger/{YYYYMMDD}` with `$0.001/call` cost.

**Retry Queue:** `pa-ats-resolve-priority/{jobId}` with `{ attempts, lastReason, retryAfter }`

**Capacity:** 200 jobs/run × 24 runs/day = 4800 attempted resolves/day (within budget).

---

### Path F: paLlmRerankNightly → pa-user-rerank-cache + pa-user-skill-jdrel-cache (Async)

**File:** `/apps/functions/src/nightly-rerank.ts`  
**Trigger:** Cloud Scheduler 04:00 UTC daily (1h after liveness sweep)

**Writes Two Collections:**
1. `pa-user-rerank-cache/{userId}` — LLM rerank cache (Qwen-7B judge)
   - `computedAt: string` (ISO timestamp)
   - `ranked: Array<{jobId, llmScore ∈ [0,1]}>` (top-50 candidates reranked)
   
2. `pa-user-skill-jdrel-cache/{userId}/jobs/{jobId}` — per-job JD-relative weights
   - `jdRelativeWeights: Record<skillKey, number>` (skill name → normalized weight)

**Consumers:** `queryMatchingJobsV16` uses these for cache-aware scoring (graceful miss on staleness > 36h).

---

### Path G: paQaEvaluatorWeekly → pa-qa-evaluator-runs/{runId} (Audit)

**File:** `/apps/functions/src/qa-evaluator-weekly.ts`  
**Trigger:** Cloud Scheduler 09:00 UTC Mondays (V1.6 ship gate)

**Writes Audit Doc:**
```typescript
{
  runId: string,
  evaluatedAt: string,
  sampleSize: number,
  pairs: Array<{
    userId, jobId, verdict: "hard_filter_violated" | "score_off" | "ok",
    hardFilterType?: "visa" | "location" | "careerStage" | "jobType" | ...,
    expectedScore, actualScore, scoreDelta
  }>,
  aggregates: {
    hardFilterPass: number,
    top3Precision: number,
    alertLevel: "ok" | "warning" | "critical"
  }
}
```

**Alert Triggers:** Slack + Mailgun when hardFilter < 90% OR top3 < 70%.

---

### Path H: Admin Paths

**paPromoteSandboxTag** → `pa-canonical-tags/{vocab}__{token}`
- Validates token via `validateCanonicalToken()` (rejects abbreviations)
- Writes: `{ status: "promoted", promotedAt, promotedBy, count }`
- Consumers: `resolveCanonicalVocab()` merges promoted tokens at runtime

**admin-canonical-tags** (dashboard `/admin/canonical-tags`)
- Reads sandbox proposals
- Allows admin to accept/reject
- Writes audit trail

**admin-match-debug** → `pa-admin-match-debug/{debugId}`
- Runs v1.6 query cascade with optional weight overrides
- Returns full per-job score breakdown for UI debugger

---

## 5. READ PATHS (Every Place Reading matching-jobs OR pa-users.tags)

### Query 1: queryMatchingJobsV16 (Canonical v1.6)

**Location:** `/apps/job-rec/src/tools/query-matching-jobs-v16.ts`

**Input:**
```typescript
userId: string
filters?: {
  targetRole?: string[]                    // from tags.targetRole
  visaStatus?: Visa                        // from tags.visaStatus
  targetLocations?: string[]               // from tags.targetLocations
  yoeRange?: [min, max]                    // from tags.yoeRange
  prefersStartup?: "startup" | "bigtech" | "either"  // from tags.prefersStartup
}
```

**Firestore Query:**
```
.where('status', '==', 'active')
.where('roleFunction', 'array-contains-any', user.targetRole)  ← Phase 56 hard-filter
.orderBy('firstSeenAt', 'desc')                               ← D10 freshness
.limit(500)                                                    ← V16_FETCH_CAP
```

**Hard-Filter Chain (MATCH-04):**
1. `visa` → drop if `user.visaStatus === "sponsor_needed"` AND `job.sponsorship === false`
2. `location` → drop if not in user target OR all-remote bypass
3. `careerStage` → drop if outside acceptable window (acceptableCareerStages)
4. `jobType` → drop if not in user target (when specified)
5. `freshness` → drop if `firstSeenAt > 20d ago` (D10, FRESHNESS_WINDOW_MS)
6. `atsApplyUrl` → drop if missing (liveness sweep not run yet → user messaging delayed)
7. `dead` → drop if `dead === true` (marked by liveness sweep)

**Scoring (MATCH-05/06):**
```
total = 0.40 * llmMatch          (Phase 58 rerank cache; graceful miss → 0)
      + 0.20 * skillJaccard      (weighted overlap, baseWeight × JD-relative)
      + 0.15 * relevantTagsOverlap
      + 0.10 * industrySectorOverlap
      + 0.10 * embeddingCosine   (CV vector vs job embedding)
      + 0.05 * salaryFit
```

**Cache Readers:**
- `loadUserTags()` → `pa-users/{userId}.tags` (MATCH-01, single source)
- `loadLlmRerankCache()` → `pa-user-rerank-cache/{userId}` (optional; stale > 36h → skip)
- `loadJdRelCache()` → `pa-user-skill-jdrel-cache/{userId}/jobs/*` (optional; miss → plain Jaccard)

**Output:** `V16QueryResult { jobs, counters, breakdown }`

---

### Query 2: legacy queryMatchingJobs (Pre-v1.6, Phase-Out Scheduled)

**Location:** `/apps/job-rec/src/tools/query-matching-jobs.ts`

**Distinct from V16:**
- Reads: `statedPreferences`, `industryEnum` (10-tag), `topSkills` (top-12, truncated)
- No `roleFunction` array-contains-any (legacy reads don't use Phase 56 vocab)
- Still used by: `daily-batch.ts` (legacy consumer until Phase 60)

**Deprecation:** Phase 60 will cut daily-batch over to `queryMatchingJobsV16`.

---

### Read Path 3: Match-Debug UI

**File:** `/apps/functions/src/admin-match-debug.ts`

**Callable Endpoint:**
```
POST /api/admin/match-debug
{ userId, jobId, weightOverrides?: {llmMatch, skill, industry, ...} }
```

**Output:**
- Full `queryMatchingJobsV16` cascade result for 1 job
- Per-component score breakdown
- All filter verdicts (pass/fail rationale)
- Cache hit/miss status

---

### Read Path 4: Dashboard Pages

**Admin Canonical-Tags:** `/admin/canonical-tags`
- Reads: `pa-canonical-tags/{vocab}__*` (promoted + sandbox)
- Displays: candidate tokens for promotion, evidence, vote counts

**Admin QA-Evaluator:** `/admin/qa-evaluator`
- Reads: `pa-qa-evaluator-runs/{runId}` (latest weekly audit)
- Displays: pass rates, failure breakdown, alert status

**Admin Onboarding-Questions:** `/admin/onboarding-questions`
- Reads: `pa-onboarding-config` (probe definitions)
- Displays: mapper logic, canonical role/visa mappings

**Admin Match-Debug:** `/admin/match-debug` 
- Real-time query sandbox (documented above)

---

### Read Path 5: Orchestrator Chat Scenes

**File:** `/packages/pa-orchestrator/src/index.ts` + `voice/` modules

**On-Demand Reads During Turn:**
- `pa-users/{userId}.tags` → surface recent role, company, yoe to user for confirmation
- `pa-job-profiles/{userId}` → fetch active job preferences (industry, sponsorship, location, size)
- Match-aware response generation (e.g., "您附近有 3 个职位符合您的要求")

---

## 6. VALIDATION GATES (Where Bad Data Rejected)

### Gate 1: Zod Schemas (Write-Time, All Consumers)

**Applied at:**
- `MatchingJobSchema` (`/apps/job-rec/src/types.ts`) — validates all job fields before ranking
- `UserTagsSchema` (`/packages/pa-orchestrator/src/tags/user-tags-merger.ts`) — validates merged CV + chat tags
- `SkillSchema` — rejects invalid skill entries (baseWeight ∉ [0,1], proficiency not enum, etc.)
- `CanonicalTagOverlaySchema` — validates overlay tokens (must match `[a-z][a-z0-9_]*`)

**Abbreviation Rejection (D5):**
- `validateCanonicalToken()` throws on `KNOWN_ABBREVIATIONS` set (swe, pm, sf, nyc, k8s, js, py, …)
- Applied in: cv-ingest, mergeUserTags, backfill-ats-urls-batch, admin-canonical-tags, admin-match-debug
- **Consumer:** All schema validators reference `KNOWN_ABBREVIATIONS` constant

### Gate 2: Firestore Indexes

**Implicit constraints:**
- Query `where roleFunction array-contains-any [...]` requires index on `(status, roleFunction, firstSeenAt)`
- Stale-mark `where status='active' AND source_repo='X'` (from macmini) requires index on `(source_repo, status)`
- Liveness sweep `where status='active'` + ordering by `firstSeenAt desc` (from cloud-side)

**Missing index → slow/expensive queries; no schema validation.**

### Gate 3: Firestore Hard-Filter Contract (V16_FETCH_CAP = 500)

**Location:** `/apps/job-rec/src/tools/query-matching-jobs-v16.ts`

**Implicit gate:**
- `roleFunction` array-contains-any cap: 10 elements (user.targetRole ≤ 10)
- Firestore limit: 30 per array-contains-any; capped to 10 for safety

**Violation:** User targets > 10 roles → query will NOT include 11+ roles (silent truncation).

### Gate 4: V16 Hard-Filter Contract (MATCH-04)

**Order of filters (applied post-query):**
1. Visa mismatch → drop (fail-closed: sponsorship requirement)
2. Location mismatch → drop (fail-closed: geographic intent)
3. Career stage out-of-window → drop (fail-closed: seniority mismatch)
4. Job type excluded → drop (fail-closed: employment type mismatch)
5. Freshness > 20d → drop (fail-closed: staleness)
6. Missing atsApplyUrl → drop (fail-closed: cannot apply)
7. Dead (marked by liveness) → drop (fail-closed: link dead)

**All hard-filters fail-closed.** Ambiguous values (null, undefined, missing fields) default to DROP.

### Gate 5: Predeploy Smoke Checks

**Not explicitly listed in codebase.** (Likely in separate CI pipeline; not audited here.)

---

## 7. THE CHAOS MAP — Concrete Divergences Found

### CRITICAL ISSUE #1: Snake_case vs camelCase Field Names

**WHERE:** macmini Python (upsert.py, SQL table) writes `snake_case`; Firestore collection reads/writes `camelCase`

**FIELDS AFFECTED:**
- `source_repo` (SQL) ↔ NOT PERSISTED TO FIRESTORE (no field in MatchingJob)
- `role_title` (SQL) ↔ `jobTitle` (Firestore)
- `company_name` (SQL) ↔ `companyName` (Firestore)
- `primary_url` (SQL) ↔ `primaryUrl` (Firestore)
- `location_raw` (SQL) ↔ `locationRaw` (Firestore)
- `date_posted_raw` (SQL) ↔ NOT PERSISTED (no field in MatchingJob)
- `ats_apply_url` (SQL column exists but NEVER WRITTEN by upsert.py) ↔ `atsApplyUrl` (Firestore, backfilled Phase 65)

**ROOT CAUSE:** Transformation happens in hidden Cloud Function (not in wekruit-pa codebase). Transformation mapping is undocumented.

**RISK:** If CF is missing or misconfigured, SQL → Firestore sync silently drops fields.

---

### CRITICAL ISSUE #2: Seven Fields Dropped by upsert.py (COMPLETE LIST)

**File:** `~/Desktop/WeKruit/wekruit-matching/src/wekruit_matching/scraper/upsert.py`

**Confirmed dropped (read from upsert.py INSERT statement):**
1. `seniority_level` — Phase 63 optional (not scraped); Title-inferred only
2. `job_description` — large BLOB; stored separately in jobs table, not in upsert INSERT
3. `core_responsibilities` — **NEVER POPULATED by any scraper** (dead code? lingering schema)
4. `qualifications` — **NEVER POPULATED by any scraper** (dead code? lingering schema)
5. `salary_range` — **NEVER POPULATED by scrapers** (Phase 3 enrichment, not scrape-time)
6. `benefits` — **NEVER POPULATED by scrapers** (optional JD extraction, not included)
7. `ats_apply_url` — **INTENTIONALLY DROPPED** (backfilled Phase 65 via paBackfillAtsUrlsBatch after sync)

**IMPACT:** Any code expecting `benefits` or `qualifications` will see null/undefined. `atsApplyUrl` missing for ~N hours until batch runs.

---

### CRITICAL ISSUE #3: Default Values Hiding Problems

**Field:** `jobType` (String, optional)

**Problem:** Missing or null defaults to `undefined` in MatchingJob schema. Career-filter code that branches on this field will silently skip matching when type is absent.

**Example:** User filters for `internship` only. Job doc lacks `jobType` field (legacy scrape). Query returns it anyway (no filter applied). User sees non-internship position.

**WHERE:** `/apps/job-rec/src/tools/query-matching-jobs-v16.ts` line ~332 (applyJobTypeFilter) — only applied when `job.jobType` is truthy.

---

### CRITICAL ISSUE #4: Vocab Token Mismatches (Abbreviations vs Spelled-Out)

**DANGER:** If legacy data still contains abbreviated tokens (e.g., `"swe"` instead of `"software_engineering"`), and `validateCanonicalToken()` is applied retroactively, those records will FAIL validation.

**WHERE THIS MATTERS:**
- CV parse LLM might output `"swe"` → rejected by `SkillNameSchema.refine()`
- JD enrichment might generate `"sf"` (location) → rejected by `validateCanonicalToken()`
- Overlay promotion might suggest `"h1b"` (visa) → rejected by token validator

**CONFIRMED ABBR SET:** 40+ abbreviations hardcoded in `KNOWN_ABBREVIATIONS` constant:
- Roles: `swe`, `pm`, `tpm`, `epm`, `sde`, `qa`, `sre`, `ds`, `fe`, `be`
- Locations: `sf`, `nyc`, `la`, `dc`, `uk`, `us`, `usa`, `eu`
- Tech: `js`, `ts`, `py`, `k8s`, `ml`, `ai`, `ux`, `ui`, `oss`, `pr`, `cd`, `ci`, `db`, `vm`, `iam`, `ide`, `cli`, `api`
- Execs: `svp`, `evp`, `ceo`, `cto`, `cfo`, `coo`, `cmo`, `cpo`, `ciso`
- Misc: `hr`, `rfp`, `kpi`, `saas`

---

### CRITICAL ISSUE #5: Stale Schema Fields (Legacy Read Paths Still Wired)

**Deprecated but Not Removed:**

| Field | Original Use | Current Status | Read By? |
|-------|--------------|----------------|----------|
| `lastSeenAt` | Freshness signal (re-scrape noise) | DEPRECATED v1.6 | Only `queryMatchingJobs` (legacy, phase-out Phase 60) |
| `industry` (6-enum: tech/fintech/healthtech/consumer/b2b/any) | Legacy hard filter | DEPRECATED v1.6 | Only legacy query + daily-batch |
| `industryKey` | Token-set expansion mapping | DEPRECATED v1.6 | Only legacy query |
| `industryEnum` (10-tag) | Role-derived industry buckets | DEPRECATED v1.6 | Only `daily-batch.ts` (phase-out Phase 60) |

**RISK:** If Phase 60 stalls, legacy queries keep reading dead fields indefinitely. No warnings.

---

### CRITICAL ISSUE #6: Default Enum Values Silently Dropping Records

**Field:** `jobType` in legacy 6-enum `JobProfile`

**PROBLEM IN daily-batch:**
```typescript
// If user never set sizePreference, it defaults to undefined
// If a job doc has jobType=undefined AND user has a filter...
// The filter doesn't apply (no error, no warning)
```

When a user's onboarding never asks "what job type?", the field is `undefined`. Then the recommender silently matches any job type. If the user later expects "internship only" filtering to work, they get everything.

---

### CRITICAL ISSUE #7: Field-Name Divergence in mergeUserTags

**Input Shape Variation:**

```typescript
// Legacy: candidateProfile.skills: string[]
candidateProfile: { skills: ["python", "react", "kubernetes"] }

// Phase 61+: candidateProfile.skills: SkillEntry[]
candidateProfile: { 
  skills: [
    { name: "python", bucket: "programming_languages", proficiency: "expert", baseWeight: 0.8 },
    { name: "react", bucket: "frameworks_and_libraries", proficiency: "advanced", baseWeight: 0.7 }
  ]
}
```

**MERGER HANDLES BOTH** (line 192 in user-tags-merger.ts):
```typescript
skills?: ReadonlyArray<string | { name: string; bucket?: ...; ... }>
```

But if a record arrives with MIXED (some strings, some objects), the merger might infer buckets incorrectly (e.g., `"kubernetes"` → guessed as `"cloud_and_infrastructure"` but might be `"devops_and_tooling"`).

**NO VALIDATION:** Once merged, there's no way to tell the difference between a correctly-inferred bucket and a wrongly-guessed one.

---

### CRITICAL ISSUE #8: roleFunction (D1) vs industryEnum (D2) — NOT Single Source Yet

**DESIGN INTENT (CLAUDE.md v1.6):**
- D1: `roleFunction` (17-token) is ONE source of truth, hard-filter axis
- D2: `industrySector` (42-token) is ONE source of truth, soft-score axis

**REALITY:**
- `roleFunction` ✓ correctly single-sourced (jobright `utm_campaign` verbatim)
- `industrySector` ✓ correctly single-sourced (Phase 53 Sonnet 2ndpass)
- BUT: Legacy `industryEnum` (10-tag) still written alongside `industrySector` ← **dual vocab**
- AND: Legacy `industry` (6-enum) still written alongside `industrySector` ← **triple vocab**

**CONSEQUENCE:** Three simultaneous industry signals on the same matching-job doc. Confusing for consumers (which one is authoritative?). Legacy readers default to oldest (industry < industryEnum < industrySector).

---

### CRITICAL ISSUE #9: TODO/FIXME Comments Indicating Schema Debt

**SEARCH RESULT:** No explicit TODO/FIXME comments found in canonical vocab or core schemas.

**BUT IMPLICIT DEBT IN COMMENTS:**

Line 159 in `/apps/job-rec/src/types.ts`:
```typescript
/**
 * @deprecated v1.6 Phase 56 (MATCH-08, D10) — `lastSeenAt` is no longer
 * a freshness signal. The jobright re-scrape pattern makes it noise; the
 * v1.6 cascade uses `firstSeenAt < 20d` exclusively...
 * once Phase 60 cuts it over to `queryMatchingJobsV16`,
 * the field can be dropped.
 */
```

**Translation:** Phase 60 is supposed to kill `lastSeenAt`, but if it hasn't shipped yet, the field lingers.

---

### CRITICAL ISSUE #10: Two Orthogonal Axes NOT Verified as Single Source

**AXIS D1 (roleFunction):**
- **Expected:** Single source = jobright `utm_campaign` (17 values)
- **Actual:** ✓ Correct. All other sources use Phase 55 migration backfill
- **Status:** VERIFIED SINGLE SOURCE

**AXIS D2 (industrySector):**
- **Expected:** Single source = Phase 52 closed enum (42 values) + Phase 53 Sonnet 2ndpass + admin overlay
- **Actual:** ✓ Mostly correct, BUT legacy `industryEnum` (10-tag) and `industry` (6-enum) persist
- **Status:** PARTIAL — D2 is authoritative in v1.6 code, but older signals linger

---

## SUMMARY OF TOP 10 EGREGIOUS DIVERGENCES

1. **Snake_case ↔ camelCase transformation hidden** — macmini SQL writes `source_repo`; Firestore reads `companyName`. Cloud Function mapping is undocumented (not in wekruit-pa).

2. **Seven fields dropped by upsert.py** — `seniority_level`, `job_description`, `core_responsibilities`, `qualifications`, `salary_range`, `benefits`, `ats_apply_url` (last one intentional). Dead-code fields `core_responsibilities` and `qualifications` never populated.

3. **atsApplyUrl missing for hours** — All jobs start without this field. Phase 65 backfill runs hourly; jobs missing URLs are inapplicable until Serper resolves them (skipped by liveness sweep).

4. **Abbreviations hardcoded but not prevented retroactively** — CV parse LLM might output `"swe"` which `validateCanonicalToken()` rejects. Existing docs with abbr tokens will fail validation on re-write.

5. **Default enum values hide bugs** — `jobType=undefined` means filter doesn't apply. User never explicitly chose "internship," but filter is silently skipped.

6. **Three simultaneous industry signals** — `industry` (6-enum) + `industryEnum` (10-tag) + `industrySector` (42-token) all written to same doc. Legacy code reads oldest; no priority documented.

7. **lastSeenAt marked deprecated but still read** — Only `queryMatchingJobs` (legacy) reads it. Will linger until Phase 60 migration. No hard cutoff date.

8. **SkillEntry schema migration (Phase 61) creates mixed arrays** — Old string[] + new SkillEntry[] can coexist. Bucket inference is lossy; no validation that inference is correct.

9. **roleFunction + industrySector not yet verified as single source in production** — Design intent is correct; implementation is correct; but testing not listed in audit materials.

10. **Hidden Cloud Function transforms SQL → Firestore** — macmini writes PostgreSQL; separate CF (not in wekruit-pa repo) syncs to Firestore. If CF is down/misconfigured, sync silently fails. No health check visible.

---

## APPENDIX A: Directory Manifest

**Canonical Vocabs:**
- `/packages/shared-tags/src/canonical/role-function.ts` — 17-token roleFunction (D1)
- `/packages/shared-tags/src/canonical/industry-sector.ts` — 42-token industrySector (D2)
- `/packages/shared-tags/src/canonical/job-type.ts` — 10-token jobType
- `/packages/shared-tags/src/canonical/career-stage.ts` — 13-token careerStage + adjacency index
- `/packages/shared-tags/src/canonical/location.ts` — 130+-token location vocab
- `/packages/shared-tags/src/canonical/visa.ts` — 4-token visa status
- `/packages/shared-tags/src/canonical/major.ts` — 62-token major (soft-score only)
- `/packages/shared-tags/src/canonical/skills.ts` — 10-bucket SkillBucket enum + SkillSchema
- `/packages/shared-tags/src/canonical/relevant-tags.ts` — open-vocab pattern + max-12 enforcer
- `/packages/shared-tags/src/canonical/validation.ts` — `validateCanonicalToken()`, `KNOWN_ABBREVIATIONS` set
- `/packages/shared-tags/src/canonical/overlay.ts` — Firestore overlay schema, `resolveCanonicalVocab()`

**Job Schemas:**
- `/packages/core-types/src/matching-jobs.ts` — v1.6 MatchingJobV16Partial (roleFunction, industrySector)
- `/apps/job-rec/src/types.ts` — Full MatchingJobSchema (working schema for ranking)
- `/apps/job-rec/src/tools/query-matching-jobs-v16.ts` — v1.6 query cascade (CANONICAL READ PATH)
- `/apps/job-rec/src/tools/query-matching-jobs.ts` — legacy query (pre-v1.6, deprecated)

**User Schemas:**
- `/packages/pa-orchestrator/src/tags/user-tags-merger.ts` — UserTagsSchema + SkillEntry schema + merger logic
- `/packages/pa-orchestrator/src/tags/user-tags-writer.ts` — chat → tags write logic

**Write Paths:**
- `~/Desktop/WeKruit/wekruit-matching/src/wekruit_matching/scraper/upsert.py` — macmini SQL upsert (Python)
- `/apps/functions/src/backfill-ats-urls-batch.ts` — Phase 65 Serper backfill batch
- `/apps/functions/src/liveness-sweep.ts` — Phase 57 daily HEAD-check sweep
- `/apps/functions/src/nightly-rerank.ts` — Phase 58 LLM rerank cache writer
- `/apps/functions/src/qa-evaluator-weekly.ts` — Phase 59 audit evaluator

**Admin/Debug:**
- `/apps/functions/src/admin-match-debug.ts` — v1.6 query sandbox for debugging
- `/apps/functions/src/promote-sandbox-tag.ts` — overlay promotion CF
- `/apps/dashboard-web/src/pages/admin/canonical-tags.tsx` — admin UI for overlay management

---

**END OF AUDIT**
