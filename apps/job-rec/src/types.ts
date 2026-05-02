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
  industry: z.string(),
  industryKey: z.string().optional(),
  sponsorship: z.boolean().nullable(),
  jobType: z.string().optional(),
  requiredSkills: z.array(z.string()).optional(),
  firstSeenAt: z.string().optional(),
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
})
export type SendImessageOutput = z.infer<typeof SendImessageOutputSchema>

/** Firestore collection name for the new pa-job-profiles store (greenfield). */
export const JOB_PROFILES_COLLECTION = "pa-job-profiles"

/** Feature flag key consulted before paJobRecDaily delivers to a user. */
export const JOB_REC_FLAG_KEY = "paJobRecEnabled"
