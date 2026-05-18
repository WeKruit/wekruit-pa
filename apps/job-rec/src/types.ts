/**
 * Stream B — Job-rec greenfield type/schema layer.
 *
 * All RecruiterAgent tool I/O passes through these Zod schemas so the SDK
 * can validate LLM-emitted JSON args (B3) and our unit tests can assert
 * round-trip parity (B5).
 */

import { z } from "zod"

// ---------------------------------------------------------------------------
// Resume profile (output of parseResume tool)
// ---------------------------------------------------------------------------

/** Lightweight summary surfaced back to the LLM after CV parse. */
export const ResumeProfileSchema = z.object({
  name: z.string(),
  currentRole: z.string(),
  yearsExp: z.number().int().nonnegative(),
  skills: z.array(z.string()),
  education: z.string(),
  lastCompany: z.string(),
  signatureProject: z.string(),
})
export type ResumeProfile = z.infer<typeof ResumeProfileSchema>

// ---------------------------------------------------------------------------
// Job profile (saved to pa-job-profiles after onboarding probes)
// ---------------------------------------------------------------------------

export const JobSizePreferenceSchema = z.enum(["bigtech", "startup", "either"])
export type JobSizePreference = z.infer<typeof JobSizePreferenceSchema>

export const JobSponsorshipNeedSchema = z.enum(["h1b", "gc", "none", "either"])
export type JobSponsorshipNeed = z.infer<typeof JobSponsorshipNeedSchema>

export const JobIndustrySchema = z.enum([
  "tech",
  "fintech",
  "healthtech",
  "consumer",
  "b2b",
  "any",
])
export type JobIndustry = z.infer<typeof JobIndustrySchema>

/**
 * Captured during onboarding probes (one question per turn). Daily cron
 * uses this to filter `matching-jobs` and rank top 3-5 per user.
 */
export const JobProfileSchema = z.object({
  industry: JobIndustrySchema,
  sponsorship: JobSponsorshipNeedSchema,
  /** Free-text — "湾区"/"NYC"/"Seattle"/"remote"/"anywhere" — matched fuzzily against `locationRaw`. */
  location: z.string(),
  sizePreference: JobSizePreferenceSchema,
  /** Optional total-comp floor; honored only when present + a job carries `salaryMax`. */
  salaryMin: z.number().int().nonnegative().optional(),
})
export type JobProfile = z.infer<typeof JobProfileSchema>

/** Persisted Firestore doc shape — what `pa-job-profiles/{userId}` looks like. */
export const JobProfileDocSchema = z.object({
  userId: z.string(),
  profile: JobProfileSchema,
  cvParsedAt: z.string(),
  lastJobBatchSentAt: z.string().nullable(),
  status: z.enum(["onboarding", "active", "paused"]),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type JobProfileDoc = z.infer<typeof JobProfileDocSchema>

// ---------------------------------------------------------------------------
// iter34 sprint B.11 — score breakdown surfaced from rankJobs/queryMatchingJobs
// so callers (orchestrator-deps live recs, daily-batch fallback) can render a
// human-readable "为啥推" reason line. The shape mirrors `scoreJob`'s return
// (skill / embedding / sponsorship / location / salary in [0..1] + weighted
// `total`). Defined here (not in tools/query-matching-jobs.ts) to avoid a
// circular import when MatchingJobSchema embeds it as an optional field.
// ---------------------------------------------------------------------------

export const ScoreBreakdownSchema = z.object({
  /** Jaccard skill overlap (0..1). */
  skill: z.number(),
  /** CV × job embedding cosine (0..1). 0 when either vector is missing. */
  embedding: z.number(),
  /** Sponsorship match (0..1). */
  sponsorship: z.number(),
  /** Location ladder (0..1). */
  location: z.number(),
  /** Salary floor met (0..1). */
  salary: z.number(),
  /** Weighted sum: 0.35*skill + 0.30*embedding + 0.15*sponsorship + 0.15*location + 0.05*salary. */
  total: z.number(),
})
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>

export const MatchScoreSchema = z.object({
  total: z.number(),
  breakdown: ScoreBreakdownSchema,
})
export type MatchScore = z.infer<typeof MatchScoreSchema>

// ---------------------------------------------------------------------------
// matching-jobs corpus row (subset relevant to recommender)
// ---------------------------------------------------------------------------

/**
 * A subset of `matching-jobs/{id}` projected for ranking + delivery.
 * Full doc is much wider (embeddings, raw search tokens, etc.); we narrow
 * here both for type discipline and to keep the LLM payload small.
 */
export const MatchingJobSchema = z.object({
  id: z.string(),
  companyName: z.string(),
  jobTitle: z.string(),
  salaryMax: z.number().nullable(),
  salaryMin: z.number().nullable(),
  locationRaw: z.string(),
  primaryUrl: z.string(),
  /**
   * iter34 sprint A.2 — true ATS apply URL persisted on Firestore
   * `matching-jobs` docs (camelCase). When present we surface this as
   * the user-facing link; `primaryUrl` (jobright.ai mirror) is the
   * fallback when the row was scraped before the ATS resolver landed.
   * `null` from Firestore is normalized to `undefined` by
   * `projectMatchingJobRow` so consumers only branch on `undefined`.
   */
  atsApplyUrl: z.string().optional(),
  industry: z.string(),
  industryKey: z.string().optional(),
  sponsorship: z.boolean().nullable(),
  jobType: z.string().optional(),
  requiredSkills: z.array(z.string()).optional(),
  firstSeenAt: z.string().optional(),
  /**
   * Stream I (v1.5 / Phase 43.5) — optional Firestore enrichment field used
   * by the startup-vs-corp boost. When unknown, the boost is conservative
   * (no startup signal). Persisted by enrichment crawlers (Phase 39).
   */
  companyEmployeeCount: z.number().int().nonnegative().nullable().optional(),
  /**
   * iter34 sprint A.3 — H8-enriched canonical 10-tag bucket array (e.g.
   * ["tech_software"]). Populated by the H8 enrichment pipeline. When the
   * caller passes filters.targetRoleIndustryEnum, queryMatchingJobs
   * intersects this field against the role-derived bucket set and drops
   * non-overlap docs. Optional because legacy / unenriched rows may lack it.
   */
  industryEnum: z.array(z.string()).optional(),
  /**
   * @deprecated v1.6 Phase 56 (MATCH-08, D10) — `lastSeenAt` is no longer
   * a freshness signal. The jobright re-scrape pattern makes it noise; the
   * v1.6 cascade uses `firstSeenAt < 20d` exclusively, with the daily 404
   * sweep handling real death via `dead === true`. The field is retained
   * here for back-compat with the legacy `queryMatchingJobs` consumer
   * (daily-batch.ts) — once Phase 60 cuts it over to `queryMatchingJobsV16`,
   * the field can be dropped.
   *
   * iter34 followup D.9 (legacy comment) — Recency signal used by the
   * legacy recency hard filter. ISO 8601 string OR a Firestore Timestamp
   * object (with `.toDate()`). `firstSeenAt` was clustering at 30-50d when
   * this comment was written; the v1.6 redesign moves to `firstSeenAt < 20d`.
   */
  lastSeenAt: z.union([z.string(), z.any()]).optional(),
  /**
   * iter34 followup D.13 — Liveness signal used by the liveness hard
   * filter. Set to `true` by an out-of-band liveness sweep (G.4 worker)
   * when an HTTP HEAD against `atsApplyUrl` returns 404 / 410 / 500 / etc.
   * The query-layer filter (`applyLivenessFilter`) drops docs with
   * `dead === true`; `dead === false` and `dead === undefined` are kept
   * (back-compat: legacy rows have never been checked yet).
   *
   * Why not synchronous in the query path: HEAD-checking N URLs adds
   * unbounded latency to the read path. The sweep runs async and writes
   * the result into the doc; the query just reads the cached signal.
   */
  dead: z.boolean().optional(),
  /**
   * iter34 followup D.13 — ISO timestamp of the most-recent liveness
   * sweep that wrote `dead`. Optional; present when the sweep has run
   * against this row at least once.
   */
  deadCheckedAt: z.string().optional(),
  /**
   * iter34 followup D.13 — Short tag describing why the row was marked
   * dead (e.g. "404", "410", "500", "timeout", "dns"). Optional;
   * informational for log/dashboard, not consumed by the query filter.
   */
  deadReason: z.string().optional(),
  /**
   * iter34 sprint B.11 — score components attached by `rankJobs` so callers
   * can render a "为啥推" reason line (see `formatJobMatchReason`). Not
   * persisted to Firestore; only present on jobs returned through the
   * ranking pipeline. Optional + back-compat for callers that bypass
   * scoring (legacy paths, raw projection consumers).
   */
  matchScore: MatchScoreSchema.optional(),
  /**
   * v1.6 Phase 56 (MATCH-02) — canonical roleFunction array (17-token vocab
   * from jobright `utm_campaign`). Hard filter axis at query layer:
   * `where('roleFunction', 'array-contains-any', user.targetRoleFunction)`.
   * Optional in Zod for back-compat with un-migrated rows; queryMatchingJobsV16
   * does NOT filter when the field is missing (graceful for legacy).
   */
  roleFunction: z.array(z.string()).optional(),
  /**
   * v1.6 Phase 56 — canonical industrySector array (42-token vocab). Soft
   * score axis (overlap with user.industrySector). Distinct from legacy
   * `industryEnum` (10-tag); v1.6 migration (Phase 55) backfills both.
   */
  industrySector: z.array(z.string()).optional(),
  /**
   * v1.6 Phase 56 — open-vocab relevantTags (max 12 per job, sandbox).
   * Soft score axis (overlap with user.relevantTags). Populated by
   * Phase 55 migration / Phase 58 nightly enrichment.
   */
  relevantTags: z.array(z.string()).optional(),
  /**
   * v1.6 Phase 56 — locationBuckets canonical 130+ vocab. When present,
   * hard filter intersects with user.targetLocations. Falls back to
   * locationRaw substring when missing.
   */
  locationBuckets: z.array(z.string()).optional(),
  /**
   * v1.6 Phase 56 — canonical careerStage seniority (13-token vocab).
   * Hard filter axis (acceptableCareerStages window). Optional;
   * legacy rows fall back to title-regex inference.
   */
  seniorityLevel: z.string().optional(),
})
export type MatchingJob = z.infer<typeof MatchingJobSchema>

// ---------------------------------------------------------------------------
// Tool input/output envelopes
// ---------------------------------------------------------------------------

export const ParseResumeInputSchema = z.object({
  mediaUrl: z.string().url().or(z.string().min(1)),
  userId: z.string().min(1),
})
export type ParseResumeInput = z.infer<typeof ParseResumeInputSchema>

export const ParseResumeOutputSchema = z.object({
  profile: ResumeProfileSchema,
  /**
   * Non-null after the parse pipeline finishes; null when the shim only
   * recorded a stub doc and the offline parser hasn't enriched yet.
   */
  parsedDocId: z.string().nullable(),
})
export type ParseResumeOutput = z.infer<typeof ParseResumeOutputSchema>

export const QueryMatchingJobsFiltersSchema = z.object({
  industry: JobIndustrySchema.optional(),
  location: z.string().optional(),
  sponsorship: JobSponsorshipNeedSchema.optional(),
  sizePreference: JobSizePreferenceSchema.optional(),
  salaryMin: z.number().int().nonnegative().optional(),
  /** Optional skills weighting — skills bumped via in-memory rank. */
  userSkills: z.array(z.string()).optional(),
  /**
   * Stream H6 — canonical 10-tag industry list (e.g. ["tech_software",
   * "ai_ml"]). When non-empty, queryMatchingJobs expands these tags into
   * the corpus' `industryKey` token-set via {@link mapTagToIndustryKeys}
   * and filters with `where industryKey in [...]` (Firestore in-clause,
   * cap 10). Preferred over the 6-enum `industry` field for daily-batch:
   * the 6-enum collapse loses signal (tech_software + ai_ml + fintech_finance
   * → "tech" matches only ~191/40374 active rows).
   * Tool-path callers (recruiter-agent) typically don't set this; they
   * pass `industry` and we keep the legacy compound-where path.
   */
  industryTags: z.array(z.string()).optional(),
  /**
   * iter34 sprint A.3 — canonical role tokens from
   * `pa-users.statedPreferences.targetRole` (e.g. ["swe"], ["pm", "em"]).
   * Currently informational/forward-compat — actual role-vs-job filtering
   * goes through {@link targetRoleIndustryEnum} below, which the caller
   * (job-rec daily-batch) computes via
   * `roleToIndustryBuckets(targetRole)`. We keep the raw token list
   * here so future iterations can do title-pattern / skill matching by
   * role without re-derivation.
   */
  targetRole: z.array(z.string()).optional(),
  /**
   * iter34 sprint A.3 — expanded `industryEnum` buckets that the user's
   * targetRole(s) plausibly work in (e.g. swe → ["tech_software", "ai_ml",
   * "fintech_finance", "tech_hardware"]). When set + non-empty,
   * queryMatchingJobs post-filters the candidate pool to keep only docs
   * whose `industryEnum` intersects this set.
   *
   * Why post-filter (not query-layer): Firestore allows only ONE
   * array-contains-any per query. The H8 path already uses it for
   * industryTags expansion (the user's intent buckets). We can't stack
   * a second array-contains-any for role-derived buckets, so the role
   * intersection runs in-memory after fetch. ~50 docs ≪ 1ms.
   *
   * undefined / empty → no filter (backward-compatible).
   */
  targetRoleIndustryEnum: z.array(z.string()).optional(),
  /**
   * iter34 sprint B.10 — CV embedding (1536-d float[]) used by scoreJob's
   * cosine similarity component (weight 0.30). Caller-injected from the
   * user's parsed-resume embedding. When undefined / null / empty,
   * scoreJob's embedding component contributes 0 (and the other 4 weights
   * are NOT redistributed — total naturally lower for users without a CV
   * embedding).
   *
   * Why a filter field (not a top-level arg): symmetric with `targetRole`
   * / `targetRoleIndustryEnum` (also caller-injected per-user signals).
   */
  cvEmbedding: z.array(z.number()).optional(),
})
export type QueryMatchingJobsFilters = z.infer<typeof QueryMatchingJobsFiltersSchema>

export const QueryMatchingJobsInputSchema = z.object({
  filters: QueryMatchingJobsFiltersSchema,
  limit: z.number().int().positive().max(20).default(5),
})
export type QueryMatchingJobsInput = z.infer<typeof QueryMatchingJobsInputSchema>

export const QueryMatchingJobsOutputSchema = z.object({
  jobs: z.array(MatchingJobSchema),
})
export type QueryMatchingJobsOutput = z.infer<typeof QueryMatchingJobsOutputSchema>

export const SaveJobProfileInputSchema = z.object({
  userId: z.string().min(1),
  profile: JobProfileSchema,
})
export type SaveJobProfileInput = z.infer<typeof SaveJobProfileInputSchema>

export const SaveJobProfileOutputSchema = z.object({
  ok: z.boolean(),
})
export type SaveJobProfileOutput = z.infer<typeof SaveJobProfileOutputSchema>

export const SendImessageInputSchema = z.object({
  userId: z.string().min(1),
  content: z.string().min(1).max(2000),
})
export type SendImessageInput = z.infer<typeof SendImessageInputSchema>

export const SendImessageOutputSchema = z.object({
  ok: z.boolean(),
  messageHandle: z.string().optional(),
  runtimeEventId: z.string().optional(),
})
export type SendImessageOutput = z.infer<typeof SendImessageOutputSchema>

/** Firestore collection name for the new pa-job-profiles store (greenfield). */
export const JOB_PROFILES_COLLECTION = "pa-job-profiles"

/** Feature flag key consulted before paJobRecDaily delivers to a user. */
export const JOB_REC_FLAG_KEY = "paJobRecEnabled"

// ---------------------------------------------------------------------------
// v1.6 Phase 56 — score breakdown for the new match cascade (MATCH-05).
//
// Five soft components per D9 weights table. `total` is the weighted sum;
// hard-filter outcomes are surfaced separately via `HardFilterCounters`.
// Per-skill JD-relative weights (Phase 58 cache) and matched-skill list
// (used by `composeReason` MATCH-07) are returned alongside the breakdown
// so the reasoning composer doesn't have to re-derive them.
// ---------------------------------------------------------------------------

export const V16ScoreBreakdownSchema = z.object({
  /** Qwen-7B nightly LLM rerank score (Phase 58 cache, 0..1). 0 when missing. */
  llmMatch: z.number(),
  /** Per-skill weighted Jaccard: Σ matched (base × jd-rel) / Σ all (base × jd-rel). */
  skillJaccard: z.number(),
  /** user.relevantTags ∩ job.relevantTags overlap ratio. */
  relevantTags: z.number(),
  /** user.industrySector ∩ job.industrySector overlap ratio. */
  industrySector: z.number(),
  /** user.embedding · job.embedding cosine (0..1). 0 when either missing. */
  cvEmbCosine: z.number(),
  /** Salary fit: 1.0 when job.salaryMin >= user.minSalary; degrades linearly. */
  salaryFit: z.number(),
  /** Phase B4 — Jaccard(user.targetCompanyTags, company.tags) × 0.15. */
  tagOverlap: z.number(),
  /** Phase B4 — +0.15 when companyPositiveList hits this job. */
  positiveHit: z.number(),
  /** Phase B4 — +0.20 fresh full_time / -0.10 intern/new_grad/contract. */
  urgencyBoost: z.number(),
  /** Weighted total per V16_SCORE_WEIGHTS + B4 additive boosts. */
  total: z.number(),
})
export type V16ScoreBreakdown = z.infer<typeof V16ScoreBreakdownSchema>

/**
 * Per-skill match contribution surfaced for the reasoning composer
 * (MATCH-07). The composer picks the top-2 matched skills by `weight`.
 */
export type MatchedSkillContribution = {
  /** Original (canonical) skill name from `tags.skills[].name`. */
  name: string
  /** Skill proficiency token from `tags.skills[].proficiency`. */
  proficiency: string
  /** base × jd-rel weight (1.0 default when jd-rel cache missing). */
  weight: number
}

/**
 * v1.6 hard-filter counters surfaced for observability + dashboards.
 * Each field counts how many jobs were dropped by that specific gate.
 */
export type V16HardFilterCounters = {
  visa: number
  location: number
  careerStage: number
  jobType: number
  freshness: number
  atsApplyUrl: number
  dead: number
  /** Phase B4 — dropped because job.companyName ∈ user.companyNegativeList. */
  negativeListDrop: number
}

/**
 * v1.6 query result shape returned by `queryMatchingJobsV16`. Kept distinct
 * from the legacy `QueryMatchingJobsOutputSchema` so the new cascade can
 * surface richer diagnostics (hard-filter counters, stale-cache flags) to
 * the dashboard without breaking the recruiter-agent tool contract.
 */
export type V16QueryResult = {
  /** Top-N scored jobs (limit honored). Each job carries v16 breakdown + reason. */
  jobs: Array<MatchingJob & {
    v16Score: V16ScoreBreakdown
    matchedSkills: MatchedSkillContribution[]
    reason: string
  }>
  /** Total survivors after hard-filter (pre-rank). */
  total: number
  /** Total dropped by hard-filter chain. */
  dropped: number
  /** Per-gate hard-filter drop counters. */
  hardFilter: V16HardFilterCounters
  /** True when user has no `pa-users.tags` doc / empty tags. */
  noUserTags?: boolean
  /** True when the LLM rerank cache was stale (>36h) — llmMatch defaults to 0. */
  llmCacheStale?: boolean
  /**
   * Phase 70 — surfaced when caller is the admin match-debug CF; opaque
   * snapshot of the user's tags doc so the dashboard can render the canonical
   * profile alongside the ranked output. Omitted in the recruiter-tool path.
   */
  userTags?: Record<string, unknown>
}
