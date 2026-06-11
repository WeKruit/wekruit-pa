/**
 * iter34 H.1 — Unified user tag schema + merger.
 *
 * Adam directive (2026-05-05): chat has tags, resume has tags — too many
 * places — the candidate signal currently lives in 4+ disjoint places:
 *   1. `pa-users.statedPreferences` (chat-derived: role / yoe / visa / loc)
 *   2. `parsedCandidateResumes.industryTags` (CV-derived industry buckets)
 *   3. `parsedCandidateResumes.topSkills` (CV-derived ranked skills)
 *   4. `parsedCandidateResumes.candidateProfile.skills` + `workHistory[].skills`
 *      (CV-derived raw skill bag + per-job skills)
 *   5. `parsedCandidateResumes.embedding` (CV-derived 1536d vec)
 *
 * This module folds them into ONE canonical projection at
 * `pa-users/{userId}.tags`. Pure function, no Firestore I/O — caller is
 * responsible for reading the inputs + writing the output.
 *
 * Boundary: this module is INPUT-ONLY w.r.t. its parameters. It MUST NOT
 * mutate `cv` or `statedPreferences`. Downstream H.3 will wire cv-ingest
 * to call mergeUserTags + write `pa-users.tags`; H.4 will wire
 * generateJobRecs to read `pa-users.tags` instead of joining the 4 sources
 * inline. This worker (H.1) only defines schema + merger — no call-site
 * wiring.
 *
 * Spec choices (from Adam):
 *   - `skills` is FULL (not truncated). topSkills lives elsewhere for
 *     rendering; tags stores the entire deduplicated lowercased bag from
 *     candidateProfile.skills + workHistory[].skills.
 *   - `industryEnum` priority: cv.industryTags (filtered ≠ "other") →
 *     roleToIndustryBuckets(targetRole) → tech-token sniff on skills →
 *     ["other"].
 *   - `embedding` is pass-through (cost-prohibitive to recompute here).
 *   - chat fields are pass-through from statedPreferences (with the
 *     boolean→enum mapping for prefersStartup + sponsorship_needed→
 *     sponsor_needed token rename).
 */

import { z } from "zod"
import {
  SkillSchema,
  type Skill,
  type SkillBucket,
  type RoleFunction,
  type CareerStage,
  ROLE_FUNCTION_VOCAB,
  CAREER_STAGE_VOCAB,
  CAREER_STAGE_INDEX,
  JOB_TYPE_VOCAB,
  INDUSTRY_SECTOR_VOCAB,
  COMPANY_SIZE_VOCAB,
  COMPANY_STAGE_VOCAB,
  type CompanySize,
  PreferenceHardnessSchema,
} from "@wekruit/shared-tags"
import { roleToIndustryBuckets, type IndustryEnumBucket } from "../voice/role-to-industry.js"
import type { CanonicalRole } from "../onboarding.js"
import type { StatedPreferences } from "@pa/core-types"
import { mapAnswerToRoleFunction } from "./onboarding-mappers.js"

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Canonical industry enum (mirrors `IndustryEnumBucket` from
 * voice/role-to-industry — kept as a re-export so consumers don't need
 * to import from two places).
 */
export type IndustryTag = IndustryEnumBucket

/**
 * Visa-status token in the unified tag schema. Note this is INTENTIONALLY
 * different from `VisaStatusSchema` in @pa/core-types:
 *   - "sponsorship_needed" (StatedPreferences) → "sponsor_needed" (tags)
 *   - "unknown" (StatedPreferences) → "other" (tags)
 * The rename is so the tag schema reads cleanly without coupling to the
 * onboarding-probe-v2 wire format.
 */
export type TagsVisaStatus =
  | "citizen"
  | "permanent_resident"
  | "gc"
  | "opt"
  | "h1b"
  | "sponsor_needed"
  | "other"

/**
 * Canonical employer-flavor preference. Boolean prefersStartup (true/false/
 * null) maps to startup/bigtech/either respectively.
 */
export type StartupPreference = "startup" | "bigtech" | "either"

/**
 * Preferred reply language. Mirrors StatedPreferences.preferredLang
 * EXCEPT we drop "mixed" — generators key on this for hard zh/en lock,
 * and "mixed" is actually a runtime adapter signal, not a tag-level
 * preference. Mixed-register users get `undefined` here (caller can fall
 * back to runtime detection).
 */
export type TagsPreferredLang = "zh" | "en"

/**
 * Schema version. Bump on breaking changes (rename / drop fields). Reads
 * default to 1 when the field is absent so legacy `pa-users.tags` rows
 * (if any pre-iter34 lands) don't false-positive as "unparseable".
 *
 * v2 (2026-05-28) — additive `preferenceHardness` blob (SOFT-vs-HARD
 * preference model). PURELY ADDITIVE: every v1 doc still parses (the field
 * is optional), and a doc carrying no `preferenceHardness` is byte-identical
 * to v1 behaviour because the matcher's `resolveHardness` reader falls back
 * to `DEFAULT_HARDNESS` (which encodes current ranking). Bumped so backfills
 * / dashboards can tell hardness-aware docs apart from legacy ones.
 */
export const USER_TAGS_SCHEMA_VERSION = 2 as const

export const UserTagsSchema = z.object({
  // ---- CV-derived ------------------------------------------------------
  /**
   * ALL skills from CV — Phase 52 canonical SkillEntry shape (name + bucket
   * + proficiency + evidenceCount + baseWeight). NOT truncated. Adam spec:
   * "full skills list". topSkills (top-12 ranked) lives separately on
   * parsedCandidateResumes; this is the unranked bag for embedding /
   * cross-rerank consumers.
   *
   * Phase 61 fix: was `z.array(z.string())` — but Phase 56 V16
   * `computeWeightedSkillJaccard` reads `skills[].name` and `skills[].baseWeight`,
   * so `string[]` made baseWeight undefined → score=0 for everyone. The
   * migration script `migrate-skills-to-objects.mjs` upgrades existing
   * pa-users.tags string[] to SkillEntry[] with `baseWeight: 1.0`.
   */
  skills: z.array(SkillSchema),
  /**
   * 1..N canonical industry-bucket tokens. Always non-empty (defaults to
   * ["other"] when no signal). Drives industry filter in job-rec.
   */
  industryEnum: z.array(z.string()),
  /**
   * Phase 53 — Phase 52 canonical industry-sector tokens (42-token vocab,
   * `INDUSTRY_SECTOR_VOCAB`). Distinct from `industryEnum` (legacy 10-tag).
   * Populated parse-time by pa-resume-parser v2 + post-parse Sonnet
   * second-pass when the LLM falls through to ["other"] (D15).
   *
   * Workstream W3 (pre-launch matching hardening): tightened from
   * `z.array(z.string())` to the canonical enum so writers (parser v2,
   * conversation-extractor) commit to the 42-token vocab. The runtime
   * `dedupedStrings` normalization in `mergeUserTags` only lower-cases/
   * trims; it does not promote unknown tokens, so any new non-canonical
   * value would be a writer bug — the enum surfaces it at the type layer.
   */
  industrySector: z.array(z.enum(INDUSTRY_SECTOR_VOCAB)).optional(),
  /**
   * Phase 53 — derived industries from work-history (≤6). Same canonical
   * 42-token vocab as `industrySector`. Used by Phase 56 match query as
   * the soft-score axis (alongside `industrySector`).
   */
  relevantIndustry: z.array(z.string()).optional(),
  /**
   * Phase 53 — sub-domain expertise tokens (e.g. `frontend_development`,
   * `mlops`, `infrastructure_security`). Open vocab.
   */
  relevantSpecialization: z.array(z.string()).optional(),
  /**
   * Phase 53 — sandbox open-vocab tags (max 12). Pattern `[a-z][a-z0-9_]{1,79}`.
   * Promoted to canonical via admin dashboard (Phase 59).
   */
  proposedTags: z.array(z.string()).optional(),
  /**
   * Workstream W3 (pre-launch matching hardening) — open-vocab relevant-tags
   * bag (max 12). Promoted from a shadow field that V16 was already reading
   * via cast.
   *
   * Drives V16 `relevantTags` soft score (0.15 weight) via
   * `computeOverlap(user.relevantTags, job.relevantTags)`. V16 falls back
   * to `relevantSpecialization ?? proposedTags` when this is empty
   * (`apps/job-rec/src/tools/query-matching-jobs-v16.ts:835`). Written by
   * `conversation-extractor.ts:169` from LLM tag patch. Pattern enforced
   * separately by `RelevantTagSchema` in `@wekruit/shared-tags`; here we
   * keep the type bag as `string[]` to mirror existing open-vocab fields.
   */
  relevantTags: z.array(z.string()).max(12).optional(),
  /** Most recent role title (workHistory[0].title or experiences[0].title). */
  recentRoleTitle: z.string().optional(),
  /** Most recent company. */
  recentCompany: z.string().optional(),
  /**
   * 1-line summary of the candidate's last 3 roles. Format:
   * `"${title} @ ${company}; ${title} @ ${company}; ${title} @ ${company}"`.
   * Soft-capped at 200 chars (truncated mid-segment with `…` if longer).
   */
  workHistorySummary: z.string().optional(),
  /** 1536d OpenAI embedding (text-embedding-3-small or compat). */
  embedding: z.array(z.number()).optional(),
  embeddingModel: z.string().optional(),
  embeddingComputedAt: z.string().optional(),

  // ---- chat-derived (statedPreferences echo) --------------------------
  /** Canonical role tokens (closed enum from onboarding canon-role). */
  targetRole: z.array(z.string()).optional(),
  /**
   * Workstream W3 (pre-launch matching hardening) — Phase 52 canonical
   * role-function tokens (17 enum from jobright `utm_campaign`). Promoted
   * from a shadow field that V16 was already reading via cast.
   *
   * Drives V16 hard-filter role gate at query layer
   * (`where('roleFunction', 'array-contains-any', targetRoleFunction)` in
   * `apps/job-rec/src/tools/query-matching-jobs-v16.ts`). When empty, V16
   * reports `needsOnboarding=true` and falls back to a non-role-gated
   * query. Written by `onboarding.ts:741` (deterministic mapper from
   * CanonicalRole) and `conversation-extractor.ts:162` (LLM tag patch).
   */
  targetRoleFunction: z.array(z.enum(ROLE_FUNCTION_VOCAB)).optional(),
  /** [min, max] years-of-experience tuple. */
  yoeRange: z.tuple([z.number(), z.number()]).optional(),
  /**
   * Workstream W3 (pre-launch matching hardening) — Phase 52 canonical
   * career-stage token (13 enum). Promoted from a shadow field that V16
   * was already reading via cast.
   *
   * Drives V16 hard-filter seniority window via
   * `acceptableCareerStages(careerStage)` (one tier above + below the
   * user stage). Written by `conversation-extractor.ts:165` from LLM tag
   * patch. Differs from `yoeRange` — yoeRange is the raw [min,max] tuple
   * collected during onboarding, careerStage is the canonical seniority
   * token applied at match time.
   */
  careerStage: z.enum(CAREER_STAGE_VOCAB).optional(),
  /**
   * Explicit candidate-authored seniority RANGE `[lo, hi]` (canonical 13-token
   * vocab). DRIVES the V16 hard-filter seniority window when present (Adam-locked
   * 2026-05-31: "careerStageRange DRIVES matching, not display-only"). Overrides
   * the ±1 `acceptableCareerStages(careerStage)` window — the candidate is saying
   * "I'm open to anything from lo to hi". Written by the /me seniority editor
   * (multi-select) and by conversation extraction ("entry to senior is fine").
   * When ABSENT, the matcher falls back to the scalar `careerStage` window and the
   * projector derives a display range from `careerStage` + bufferSteps. Endpoint
   * order is not significant (`careerStageRangeWindow` normalizes it).
   */
  careerStageRange: z.tuple([z.enum(CAREER_STAGE_VOCAB), z.enum(CAREER_STAGE_VOCAB)]).optional(),
  /**
   * Canonical D4 4-enum (`citizen` / `permanent_resident` / `sponsor_needed` /
   * `other`) is what new writes commit to. Legacy `gc` / `opt` / `h1b` tokens
   * remain accepted so pre-existing `pa-users.tags` rows (and the
   * `opt`/`h1b`-specific match-reason readers) keep validating; the merger
   * normalizes a `gc` statedPreference to `permanent_resident` on the next
   * merge.
   */
  visaStatus: z
    .enum(["citizen", "permanent_resident", "gc", "opt", "h1b", "sponsor_needed", "other"])
    .optional(),
  prefersStartup: z.enum(["startup", "bigtech", "either"]).optional(),
  /** Free-text location hints from chat. */
  targetLocations: z.array(z.string()).optional(),
  /** Country/region targets from chat, e.g. ["usa"], ["china"], ["anywhere"]. */
  targetCountry: z.array(z.string()).optional(),
  preferredLang: z.enum(["zh", "en"]).optional(),
  /** Minimum acceptable salary collected from Level 1 follow-up; read by V16 salary fit. */
  minSalary: z.number().int().nonnegative().optional(),
  /**
   * Company-SIZE preference (headcount/maturity) collected from Level 1 follow-up.
   * MULTI-PICK / OR (2026-05-30): a candidate may want "an early-stage startup OR
   * big tech" → `["early_startup", "enterprise"]`. Accepts a single canonical token
   * OR an array of them (back-compat with the older scalar writes); the projector
   * lifts a scalar to a 1-elem array on the /me surface. Vocab is the shared
   * `COMPANY_SIZE_VOCAB` (no inline duplication). The LLM extractor emits the
   * canonical token(s); no regex. `open` is the "no preference" token (normalized
   * to the `no_preference` sentinel at projection). ORTHOGONAL to `companyStage`
   * (funding stage) — do not conflate.
   */
  companySize: z
    .union([z.enum(COMPANY_SIZE_VOCAB), z.array(z.enum(COMPANY_SIZE_VOCAB))])
    .optional(),
  /**
   * Company-STAGE preference (funding stage: pre_seed…ipo_public) — ORTHOGONAL to
   * `companySize` (headcount/maturity). Adam 2026-05-31: "company stage and company
   * size are different." Shared `COMPANY_STAGE_VOCAB`. Multi-pick OR (scalar OR
   * array — same back-compat shape as companySize). Captured no-regex (LLM picks the
   * COMPANY_STAGE_VOCAB enum). Projected to globalTags.companyStage[] for the /me
   * surface. Matching weight is informational only (Adam-locked weight 0) —
   * capture+display axis.
   */
  companyStage: z
    .union([z.enum(COMPANY_STAGE_VOCAB), z.array(z.enum(COMPANY_STAGE_VOCAB))])
    .optional(),
  /**
   * Workstream W3 (pre-launch matching hardening) — Phase 52 canonical
   * job-type tokens (10 enum). Promoted from a shadow field that V16 was
   * already reading via cast.
   *
   * Drives V16 hard-filter `jobType` exact-match gate (drop job when
   * `job.jobType` is not in the user's `targetJobType` set). Written by
   * `conversation-extractor.ts:166` from LLM tag patch. The legacy plural
   * `targetJobTypes` is intentionally NOT promoted to the schema — V16
   * still falls back to `tagsExt.targetJobTypes` for back-compat with
   * stale Firestore docs written pre-Phase-54, but new writes use this
   * singular form.
   */
  targetJobType: z.array(z.enum(JOB_TYPE_VOCAB)).optional(),
  /**
   * Candidate-rejected job-type tokens (canonical 10-token `JOB_TYPE_VOCAB`,
   * same vocab as the positive `targetJobType` axis). SINGLE canonical
   * SUBTRACT field for job type — mirrors `negativeRoleFunction` /
   * `negativeIndustrySector`. Written by the conversation extractor /
   * match-feedback extractor ("I am not looking for an internship" →
   * ["internship"]) and by the thin `set_matching_preferences` reducer
   * (avoidJobTypes). V16 does NOT read this field — `targetJobType` is an
   * EXACT-match hard filter — so the sole writer (`applyPartialUserTags`)
   * applies the subtraction at the write boundary instead: incoming tokens are
   * removed from the stored `targetJobType` (an emptied set persists []).
   */
  negativeJobType: z.array(z.enum(JOB_TYPE_VOCAB)).max(10).optional(),

  // ---- Phase B1 — company preference signals --------------------------
  /**
   * Phase B1 — open-vocab company-tag tokens user wants to match against.
   * Drives V16 `tagOverlap * 0.15` soft score (B4). Capped at 30 to keep
   * Jaccard sets bounded.
   */
  targetCompanyTags: z.array(z.string()).max(30).optional(),
  /**
   * Phase B1 — actively job-searching flag. Set by onboarding question
   * (B2) AND by NL detector on laid-off / actively-searching utterances
   * (B3). Drives V16 urgencyBoost (+0.20 for fresh full-time, -0.10 for
   * intern/new-grad/contract).
   */
  urgentlySeeking: z.boolean().optional(),
  /**
   * Phase B1 — hard-filter negative list. Lowercased normalized company
   * names (see `normalizeCompanyName`). Cap 30; jobs whose company name
   * matches are dropped in V16 hard filter.
   */
  companyNegativeList: z.array(z.string()).max(30).optional(),
  /**
   * Candidate-rejected role-function tokens (canonical 17-token
   * `ROLE_FUNCTION_VOCAB`, same vocab as the positive `targetRoleFunction`
   * axis). V16 hard-drops jobs whose `matching-jobs.roleFunction` intersects
   * this list. SINGLE canonical SUBTRACT field for role function — mirrors
   * `negativeIndustrySector`. Written by BOTH the live conversation extractor
   * ("avoid pure SWE, product only" → ["software_engineering"]) and the
   * agentic match-connector (`negativeRoleFunctions`). The legacy
   * `roleFunctionNegativeList` name is still READ by V16 for back-compat with
   * docs written before the 2026-05-28 rename, but all WRITERS now target this
   * canonical field (no second source of truth).
   */
  negativeRoleFunction: z.array(z.enum(ROLE_FUNCTION_VOCAB)).max(30).optional(),
  /**
   * lock #5 (negative axis) — candidate-rejected industry-sector tokens
   * (canonical 42-token `INDUSTRY_SECTOR_VOCAB`, same vocab as the positive
   * `industrySector` axis). Written by the conversation extractor when a user
   * asks to AVOID/exclude an industry ("avoid adtech and crypto"). V16
   * hard-drops jobs whose `matching-jobs.industrySector` intersects this list
   * — gated behind `PA_NEGATIVE_INDUSTRY_FILTER` (default OFF). This is the
   * SUBTRACT axis; do NOT confuse with the positive `industrySector` (soft
   * overlap, never subtracted) or open `relevantTags` `avoid_*` strings.
   */
  negativeIndustrySector: z.array(z.enum(INDUSTRY_SECTOR_VOCAB)).max(30).optional(),
  /**
   * Phase B1 — soft-boost positive list. Lowercased normalized company
   * names. Cap 30; +0.15 soft score when V16 scores a matching job.
   */
  companyPositiveList: z.array(z.string()).max(30).optional(),

  // ---- DERIVED EMPLOYER-HISTORY signals (2026-06-10) -------------------
  // These are DERIVED-HISTORY quality signals (where the candidate HAS
  // worked), NOT preferences. Do NOT confuse with the preference axes
  // `companyStage` / `companySize` above (what the candidate WANTS) — the
  // semantics are orthogonal and the preference fields are untouched.
  // Written at the merge-experience seam (cv-ingest runUserTagsMerge +
  // coresignal-experiences-mirror) by joining the merged employer timeline
  // against `pa-companies/{id}` enrichment docs + one ownership/prestige
  // LLM extraction. All optional; absent fields are never clobbered
  // (empty derivations write NOTHING).
  //
  // CONSUMPTION: pitch composer + agent context ONLY. V16 matching does
  // NOT read these fields — wiring them into scoring/weights is a separate
  // Adam-gated decision (do not add them to query-matching-jobs without it).
  /**
   * Funding stages of companies in the candidate's employment HISTORY
   * (canonical `COMPANY_STAGE_VOCAB` values from `pa-companies.companyStage`).
   * Derived, multi-value. Distinct from the `companyStage` PREFERENCE field.
   */
  employerStages: z.array(z.enum(COMPANY_STAGE_VOCAB)).optional(),
  /**
   * Open-vocab company-tag tokens (union of `pa-companies.companyTags` for
   * employers in the candidate's history — e.g. `big_tech`, `mag_7`,
   * `yc_alumni`, `unicorn`). Cap 30 to keep overlap sets bounded. Derived;
   * distinct from the `targetCompanyTags` PREFERENCE field.
   */
  employerTags: z.array(z.string()).max(30).optional(),
  /**
   * True when any employer in the candidate's history carries a
   * `big_tech` / `mag_7` company tag. Derived-history boolean.
   */
  hasBigTechBackground: z.boolean().optional(),
  /**
   * Coarse growth-tier classification of the candidate's employer mix
   * (see `deriveEmployerGrowthTier` in apps/functions
   * external-supply/employer-signals.ts). Derived-history.
   */
  employerGrowthTier: z.enum(["early_stage", "growth", "mature", "unknown"]).optional(),
  /**
   * True when the candidate held a founder / co-founder / owner role in
   * their history (LLM-extracted from merged experiences — no regex
   * text→enum; see employer-signals.ts). Derived-history; distinct from
   * `careerStage = "founder"` which is a seniority TARGET token.
   */
  founderRole: z.boolean().optional(),
  /**
   * Ownership scope EXPLICITLY present in the candidate's experience text
   * (LLM-extracted, no inference): people managed / revenue owned / users
   * served. All sub-fields optional.
   */
  scopeOfOwnership: z
    .object({
      teamSize: z.number().int().positive().optional(),
      revenue: z.string().max(60).optional(),
      users: z.number().int().nonnegative().optional(),
    })
    .optional(),
  /**
   * Honors / awards / selective-program strings EXPLICITLY present in the
   * candidate's experience text (e.g. "Top 0.1% of 390K", "YC W23",
   * "Forbes 30u30"). ≤10 entries, each ≤60 chars. LLM-extracted, never
   * inferred. Derived-history.
   */
  selectivitySignals: z.array(z.string().max(60)).max(10).optional(),

  // ---- SOFT-vs-HARD preference model (2026-05-28) ---------------------
  /**
   * Per-axis hardness annotations (`hard` = dealbreaker → drop; `soft` =
   * buffer → penalize-but-keep). Annotates EXISTING matching axes (salary,
   * industrySector, companyStage, companySize, location, jobType,
   * careerStage, roleFunction) — NOT a parallel taxonomy. Optional: when
   * absent (or an individual axis is unset) the V16 matcher's
   * `resolveHardness` reader falls back to `DEFAULT_HARDNESS`, which encodes
   * current ranking, so a doc with no `preferenceHardness` is byte-identical
   * to today. Read by V16 only behind `paPreferenceHardnessEnabled` (default
   * OFF). Shape: `PreferenceHardnessSchema` in `@wekruit/shared-tags`.
   */
  preferenceHardness: PreferenceHardnessSchema.optional(),

  // ---- bookkeeping -----------------------------------------------------
  lastUpdatedFromCv: z.string().optional(),
  lastUpdatedFromChat: z.string().optional(),
  schemaVersion: z.number().int().nonnegative(),
})

/**
 * Canonical user-tags shape. Inferred from `UserTagsSchema` for runtime/
 * compile-time parity. Field-level docs: see schema above.
 */
export type UserTags = z.infer<typeof UserTagsSchema>

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

export interface UserTagsCvInput {
  candidateProfile?: {
    /**
     * Phase 61 — accepts either raw strings (legacy CV / parser v1) or
     * Phase 52 SkillEntry-shaped objects (canonical post-Phase 52). The
     * merger upgrades strings to SkillEntry via `inferSkillBucket` +
     * neutral defaults (`baseWeight: 1.0`). Mixed arrays tolerated.
     */
    skills?: ReadonlyArray<string | { name: string; bucket?: string; proficiency?: string; evidenceCount?: number; baseWeight?: number }>
    name?: string | null
  }
  /**
   * v2 parser shape: { title, company, skills?, ... }. Pre-v2 docs may
   * not populate this (legacy CV with only `experiences[]`); we tolerate
   * both.
   */
  workHistory?: Array<{
    title?: string
    role?: string
    company?: string
    skills?: ReadonlyArray<string | { name: string; bucket?: string; proficiency?: string; evidenceCount?: number; baseWeight?: number }>
    bullets?: string[]
  }>
  /**
   * Legacy v1 shape — { company, title, ... }. When workHistory is
   * empty, we fall back to experiences[0] for recentRoleTitle /
   * recentCompany / workHistorySummary.
   */
  experiences?: Array<{
    title?: string
    company?: string
    description?: string
  }>
  /** Existing CV-derived industry buckets (canonical 10-tag enum). */
  industryTags?: string[]
  /**
   * Parser v2 `totalYearsExperience` — total professional YoE inferred from
   * the résumé. Used (alongside onboarding `statedPreferences.yoeRange`) to
   * reconcile `careerStage` so a recent intern / teaching-assistant gig can't
   * drag a multi-year career down to `intern`/`student`. Pass-through from
   * `parsedResumeData.totalYearsExperience`.
   */
  totalYearsExperience?: number
  /** 1536d embedding pass-through. */
  embedding?: number[]
  embeddingModel?: string
  embeddingComputedAt?: string

  // ---- Phase 53 (PARSE-03..PARSE-05) — canonical Phase 52 vocab ----
  /**
   * Phase 52 canonical 42-token industry sectors. Distinct from
   * `industryTags` (legacy 10-tag bucket). Pass-through from
   * `parsedResumeData.industries` / second-pass override.
   */
  industrySector?: string[]
  /** Pass-through from `parsedResumeData.relevantIndustry`. */
  relevantIndustry?: string[]
  /** Pass-through from `parsedResumeData.relevantSpecialization`. */
  relevantSpecialization?: string[]
  /** Pass-through from `parsedResumeData.proposedTags`. */
  proposedTags?: string[]
}

export interface UserTagsInput {
  cv?: UserTagsCvInput
  statedPreferences?: StatedPreferences
  /**
   * Independent preferred-lang signal — falls back to
   * statedPreferences.preferredLang when absent. Caller may pass this
   * separately when applying mid-conversation lang lock without a full
   * statedPreferences fetch.
   */
  preferredLang?: "zh" | "en" | "mixed"
  /** ISO timestamp; pass-through to lastUpdatedFromCv when cv input present. */
  cvUpdatedAt?: string
  /** ISO timestamp; pass-through to lastUpdatedFromChat when statedPreferences present. */
  chatUpdatedAt?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TECH_SKILL_TOKENS: ReadonlyArray<string> = [
  "python",
  "javascript",
  "typescript",
  "react",
  "node",
  "go ", // trailing space avoids matching "go" inside "logo"
  "golang",
  "rust",
  "c++",
  "java",
  "kotlin",
  "swift",
  "aws",
  "gcp",
  "azure",
  "docker",
  "kubernetes",
  "tensorflow",
  "pytorch",
  "graphql",
]

const KNOWN_INDUSTRY_TOKENS: ReadonlySet<string> = new Set([
  "tech_software",
  "tech_hardware",
  "fintech_finance",
  "ai_ml",
  "healthcare_biotech",
  "consumer_retail",
  "media_entertainment",
  "manufacturing_industrial",
  "education",
  "other",
])

/** Lowercase + collapse whitespace + trim. Returns null when empty. */
function normalizeSkill(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const norm = raw.toLowerCase().trim().replace(/\s+/g, " ")
  return norm.length > 0 ? norm : null
}

/**
 * Phase 61 — heuristic skill-name → SkillBucket inference. Maps common
 * skill names to one of the 10 Phase 52 SKILL_BUCKET_VOCAB tokens.
 * Returns `domain_specific` when no pattern matches.
 *
 * Used by `migrate-skills-to-objects.mjs` to upgrade legacy pa-users.tags
 * `skills: string[]` → `skills: SkillEntry[]` and by `mergeUserTags` to
 * stamp a sensible bucket on freshly-extracted CV skills.
 *
 * Order matters: more-specific patterns first (prevent "react" matching as
 * a programming-language).
 */
const SKILL_BUCKET_HEURISTICS: ReadonlyArray<[RegExp, SkillBucket]> = [
  // Programming languages — exact-token list. Keep BEFORE frameworks so e.g.
  // "java" doesn't get pulled into a future "javascript" framework regex.
  [
    /^(python|javascript|typescript|java|c\+\+|c#|c|go|golang|rust|ruby|swift|kotlin|scala|php|r|matlab|sql|html|css|bash|shell|perl|elixir|haskell|clojure|julia|dart|lua|objective-c|powershell)$/i,
    "programming_languages",
  ],
  // Frameworks & libraries
  [
    /^(react|reactjs|vue|vuejs|angular|next\.?js|nextjs|nuxt|svelte|django|flask|fastapi|rails|express|spring(\s|_)?boot|laravel|gatsby|remix|node\.?js|nodejs|graphql|redux|jest|mocha|cypress|playwright|tailwind|bootstrap|jquery|three\.?js|d3\.?js|electron|capacitor|expo|react(-|_)?native|flutter|axios|webpack|vite|rollup|babel)$/i,
    "frameworks_and_libraries",
  ],
  // Databases
  [
    /^(postgres(ql)?|mysql|mongodb|mongo|redis|elasticsearch|cassandra|dynamodb|snowflake|bigquery|sqlite|mariadb|oracle(\s|_)?db|sql(\s|_)?server|firebase(\s|_)?firestore|firestore|supabase|cockroachdb|neo4j|opensearch|clickhouse)$/i,
    "databases",
  ],
  // Cloud / infrastructure
  [
    /^(aws|amazon(\s|_)?web(\s|_)?services|gcp|google(\s|_)?cloud(\s|_)?platform|google(\s|_)?cloud|azure|microsoft(\s|_)?azure|kubernetes|docker|terraform|ansible|helm|vault|consul|nginx|apache|cloudflare|heroku|vercel|netlify|firebase|fastly|digitalocean|linode|openshift|ecs|eks|gke|aks|lambda|cloud(\s|_)?run|serverless)$/i,
    "cloud_and_infrastructure",
  ],
  // DevOps / tooling
  [
    /^(git|github|gitlab|bitbucket|jenkins|circle\s?ci|circleci|github\s?actions|gha|gitlab(\s|_)?ci|datadog|grafana|prometheus|sentry|new(\s|_)?relic|splunk|pagerduty|opsgenie|jira|confluence|slack|notion|linear|asana|trello|sonarqube|snyk|dependabot|renovate|pulumi|argo(\s|_)?cd|argocd|spinnaker|tekton|harness|fastlane|cocoapods|npm|yarn|pnpm|pip|cargo|maven|gradle|bazel|nx|lerna)$/i,
    "devops_and_tooling",
  ],
  // Data & ML
  [
    /^(machine(\s|_)?learning|deep(\s|_)?learning|nlp|natural(\s|_)?language(\s|_)?processing|computer(\s|_)?vision|pytorch|tensorflow|scikit(\s|_)?learn|sklearn|pandas|numpy|spark|kafka|airflow|dbt|huggingface|transformers|llm|rag|vector(\s|_)?database|embeddings|fine(\s|_)?tuning|reinforcement(\s|_)?learning|xgboost|lightgbm|keras|jax|mlflow|kubeflow|sagemaker|vertex(\s|_)?ai|databricks|snowpark|tableau|power(\s|_)?bi|looker|mixpanel|amplitude|segment|fivetran|stitch|hadoop|hive|presto|trino|flink|beam|opencv|spacy|nltk|gensim|prophet|statsmodels|matplotlib|seaborn|plotly|jupyter|colab|ray)$/i,
    "data_and_ml",
  ],
  // Design & UX
  [
    /^(figma|sketch|adobe|photoshop|illustrator|indesign|after(\s|_)?effects|premiere(\s|_)?pro|xd|design(\s|_)?systems?|ux|ui|wireframing|prototyping|user(\s|_)?research|usability(\s|_)?testing|interaction(\s|_)?design|visual(\s|_)?design|motion(\s|_)?design|invision|zeplin|framer|principle|webflow|axure|miro|whimsical)$/i,
    "design_and_ux",
  ],
  // Product & business
  [
    /^(product(\s|_)?management|roadmapping|stakeholder(\s|_)?management|okrs?|kpis?|analytics|product(\s|_)?strategy|go(\s|_)?to(\s|_)?market|gtm|product(\s|_)?marketing|growth|a\/b(\s|_)?testing|funnel(\s|_)?analysis|cohort(\s|_)?analysis|customer(\s|_)?research|jobs(\s|_)?to(\s|_)?be(\s|_)?done|jtbd|product(\s|_)?led(\s|_)?growth|plg)$/i,
    "product_and_business",
  ],
  // Soft skills
  [
    /^(communication|leadership|teamwork|presentation|mentorship|negotiation|public(\s|_)?speaking|conflict(\s|_)?resolution|cross(\s|_)?functional(\s|_)?collaboration|stakeholder(\s|_)?management|coaching|feedback|empathy|active(\s|_)?listening|critical(\s|_)?thinking|time(\s|_)?management|prioritization|decision(\s|_)?making|problem(\s|_)?solving)$/i,
    "soft_skills",
  ],
]

export function inferSkillBucket(name: string): SkillBucket {
  const n = (name ?? "").toLowerCase().trim()
  if (!n) return "domain_specific"
  for (const [re, bucket] of SKILL_BUCKET_HEURISTICS) {
    if (re.test(n)) return bucket
  }
  return "domain_specific"
}

/**
 * Phase 61 — common-abbreviation → spelled-out expansions for skill names.
 * The Phase 52 SkillNameSchema rejects `KNOWN_ABBREVIATIONS` (ml, ai, js,
 * ts, k8s, saas, ux, ui, ...) but these are real skills that show up on
 * every CV. Pre-expand common abbreviations to their spelled-out form
 * BEFORE validation so they pass the strict schema.
 */
const SKILL_ABBREV_EXPANSIONS: Record<string, string> = {
  ml: "machine_learning",
  ai: "artificial_intelligence",
  js: "javascript",
  ts: "typescript",
  py: "python",
  k8s: "kubernetes",
  saas: "software_as_a_service",
  ux: "user_experience",
  ui: "user_interface",
  oss: "open_source_software",
  pr: "pull_requests",
  ci: "continuous_integration",
  cd: "continuous_delivery",
  db: "databases",
  vm: "virtual_machines",
  iam: "identity_and_access_management",
  ide: "integrated_development_environment",
  cli: "command_line_interface",
  api: "application_programming_interfaces",
  hr: "human_resources_skill",
  kpi: "key_performance_indicators",
  qa: "quality_assurance",
  sre: "site_reliability_engineering",
  ds: "data_science",
  fe: "frontend_engineering",
  be: "backend_engineering",
  rfp: "request_for_proposal",
}

/**
 * Phase 61 — sanitize a free-form skill name for canonical storage. The
 * Phase 52 `SkillNameSchema` regex requires `^[a-z][a-z0-9_+#.-]{1,63}$`
 * (lowercase + underscore + dot + plus + hyphen) AND rejects entries in
 * KNOWN_ABBREVIATIONS. LLM / CV extraction routinely emits "C++",
 * "Node.js", "Spring Boot", "ML", "AI" — we collapse whitespace to
 * underscore, expand known abbreviations, and ensure first char is a
 * letter.
 *
 * Returns null for inputs that can't be canonicalized.
 */
export function canonicalizeSkillName(raw: string): string | null {
  if (typeof raw !== "string") return null
  let s = raw.toLowerCase().trim()
  if (!s) return null
  // collapse whitespace → underscore
  s = s.replace(/\s+/g, "_")
  // strip disallowed chars (keeps a-z 0-9 _ + # . -)
  s = s.replace(/[^a-z0-9_+#.\-]/g, "")
  if (!s) return null
  // Expand known abbreviations PRE-validation so they pass the schema.
  if (Object.prototype.hasOwnProperty.call(SKILL_ABBREV_EXPANSIONS, s)) {
    s = SKILL_ABBREV_EXPANSIONS[s]!
  }
  // ensure first char is a letter; prefix with `s_` if not
  if (!/^[a-z]/.test(s)) s = `s_${s}`
  // length constraint: min 2, max 64. Truncate when over.
  if (s.length < 2) return null
  if (s.length > 64) s = s.slice(0, 64)
  return s
}

/**
 * Phase 61 — turn a raw input (string OR existing SkillEntry-shaped object)
 * into a canonical Phase 52 `Skill` object. Used by `collectSkills` so the
 * merger output always matches the Phase 52 SkillSchema.
 *
 * Applied defaults when the input is a plain string:
 *   - bucket: `inferSkillBucket(name)` heuristic
 *   - proficiency: "intermediate" (neutral default)
 *   - evidenceCount: 1
 *   - baseWeight: 1.0 (full weight; Phase 56 V16 score =
 *     `baseWeight × jdRelative` — without baseWeight, JD-rel multiplier is
 *     wasted; default 1.0 makes legacy users score immediately).
 *
 * Returns null when the name fails the Phase 52 SKILL_NAME_PATTERN regex.
 */
function toSkillEntry(raw: unknown): Skill | null {
  // Object shape: pick `name` and pass-through `bucket` / `proficiency` /
  // `evidenceCount` / `baseWeight` if present.
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>
    const rawName = typeof obj.name === "string" ? obj.name : null
    if (!rawName) return null
    const name = canonicalizeSkillName(rawName)
    if (!name) return null
    const bucket = (typeof obj.bucket === "string" ? obj.bucket : inferSkillBucket(name)) as SkillBucket
    const proficiency = typeof obj.proficiency === "string" ? obj.proficiency : "intermediate"
    const evidenceCount =
      typeof obj.evidenceCount === "number" && Number.isFinite(obj.evidenceCount)
        ? Math.max(0, Math.floor(obj.evidenceCount))
        : 1
    const baseWeight =
      typeof obj.baseWeight === "number" && Number.isFinite(obj.baseWeight)
        ? Math.max(0, Math.min(1, obj.baseWeight))
        : 1.0
    try {
      return SkillSchema.parse({ name, bucket, proficiency, evidenceCount, baseWeight })
    } catch {
      return null
    }
  }
  // String shape: build with defaults.
  if (typeof raw === "string") {
    const norm = canonicalizeSkillName(raw)
    if (!norm) return null
    try {
      return SkillSchema.parse({
        name: norm,
        bucket: inferSkillBucket(norm),
        proficiency: "intermediate",
        evidenceCount: 1,
        baseWeight: 1.0,
      })
    } catch {
      return null
    }
  }
  return null
}

/**
 * Returns the de-duplicated SkillEntry list from the CV. Order is
 * insertion order across:
 *   1. candidateProfile.skills (LLM-extracted; canonical priority)
 *   2. workHistory[].skills (per-job skills; supplemental)
 *
 * Each input string is upgraded to a Phase 52 SkillEntry via
 * `toSkillEntry` (heuristic bucket + neutral defaults). Empty / non-array
 * inputs return [].
 */
function collectSkills(cv: UserTagsCvInput | undefined): Skill[] {
  if (!cv) return []
  const seen = new Set<string>()
  const skills: Skill[] = []
  const ingest = (raw: unknown): void => {
    const entry = toSkillEntry(raw)
    if (!entry) return
    if (seen.has(entry.name)) return
    seen.add(entry.name)
    skills.push(entry)
  }
  if (Array.isArray(cv.candidateProfile?.skills)) {
    for (const s of cv.candidateProfile.skills) ingest(s)
  }
  if (Array.isArray(cv.workHistory)) {
    for (const w of cv.workHistory) {
      if (Array.isArray(w?.skills)) {
        for (const s of w.skills) ingest(s)
      }
    }
  }
  return skills
}

/**
 * Detect industry bucket from skill bag using known tech tokens. Returns
 * `["tech_software"]` when any tech token is present, otherwise [].
 *
 * Phase 61 — accepts SkillEntry[] (matching the Phase 52 canonical schema).
 */
function inferIndustryFromSkills(skills: ReadonlyArray<Skill>): IndustryTag[] {
  for (const s of skills) {
    const name = (s?.name ?? "").toLowerCase()
    for (const tok of TECH_SKILL_TOKENS) {
      if (name === tok.trim()) return ["tech_software"]
      if (name.includes(tok)) return ["tech_software"]
    }
  }
  return []
}

/** Filter raw industryTags array → known tokens; drop "other" when other tags exist. */
function filterIndustryTags(raw: string[] | undefined): IndustryTag[] {
  if (!Array.isArray(raw)) return []
  const filtered = raw.filter(
    (t): t is IndustryTag =>
      typeof t === "string" && KNOWN_INDUSTRY_TOKENS.has(t)
  )
  // If only "other", treat as "no signal" so the priority chain falls
  // through to fallback heuristics.
  if (filtered.length === 0) return []
  if (filtered.every((t) => t === "other")) return []
  // Preserve order, drop "other" when other tags are present.
  return filtered.filter((t) => t !== "other")
}

/**
 * Compose industryEnum following the priority chain:
 *   1. CV.industryTags (filtered ≠ ["other"])
 *   2. roleToIndustryBuckets(statedPreferences.targetRole)
 *   3. tech-token sniff on skills
 *   4. ["other"]
 *
 * Phase 61 — `skills` is now `ReadonlyArray<Skill>` (Phase 52 canonical
 * shape) so the sniff inspects `skill.name` instead of the raw string.
 */
function composeIndustryEnum(
  cv: UserTagsCvInput | undefined,
  statedPreferences: StatedPreferences | undefined,
  skills: ReadonlyArray<Skill>
): IndustryTag[] {
  // 1. CV.industryTags (filtered).
  const fromCv = filterIndustryTags(cv?.industryTags)
  if (fromCv.length > 0) return fromCv

  // 2. Map from targetRole. statedPreferences.targetRole stores
  //    canonicalized tokens (closed enum) — passing through as
  //    CanonicalRole[] is safe at runtime.
  const targetRole = statedPreferences?.targetRole
  if (Array.isArray(targetRole) && targetRole.length > 0) {
    const buckets = roleToIndustryBuckets(targetRole as CanonicalRole[])
    if (Array.isArray(buckets) && buckets.length > 0) return [...buckets]
  }

  // 3. Sniff tech tokens in skill bag.
  const fromSkills = inferIndustryFromSkills(skills)
  if (fromSkills.length > 0) return fromSkills

  // 4. Fallback.
  return ["other"]
}

/**
 * Pick recent role title + company from workHistory[0] (preferred) or
 * experiences[0] (legacy fallback). Trims + drops empty strings.
 */
function pickRecentRole(
  cv: UserTagsCvInput | undefined
): { title?: string; company?: string } {
  if (!cv) return {}
  const wh = Array.isArray(cv.workHistory) ? cv.workHistory[0] : undefined
  if (wh) {
    const title =
      typeof wh.title === "string" && wh.title.trim().length > 0
        ? wh.title.trim()
        : typeof wh.role === "string" && wh.role.trim().length > 0
          ? wh.role.trim()
          : undefined
    const company =
      typeof wh.company === "string" && wh.company.trim().length > 0
        ? wh.company.trim()
        : undefined
    if (title || company) return { title, company }
  }
  const ex = Array.isArray(cv.experiences) ? cv.experiences[0] : undefined
  if (ex) {
    const title =
      typeof ex.title === "string" && ex.title.trim().length > 0
        ? ex.title.trim()
        : undefined
    const company =
      typeof ex.company === "string" && ex.company.trim().length > 0
        ? ex.company.trim()
        : undefined
    if (title || company) return { title, company }
  }
  return {}
}

const WORK_HISTORY_SUMMARY_CAP = 200

/**
 * Build a 1-line summary of the first 3 roles. Format:
 *   "Title @ Company; Title @ Company; Title @ Company"
 *
 * Each segment skipped when both title + company are empty. Whole string
 * soft-capped at 200 chars (suffixed with "…" when truncated).
 */
function buildWorkHistorySummary(cv: UserTagsCvInput | undefined): string | undefined {
  if (!cv) return undefined
  const segments: string[] = []
  const wh = Array.isArray(cv.workHistory) ? cv.workHistory : []
  for (const w of wh.slice(0, 3)) {
    const title =
      typeof w.title === "string" && w.title.trim().length > 0
        ? w.title.trim()
        : typeof w.role === "string" && w.role.trim().length > 0
          ? w.role.trim()
          : ""
    const company =
      typeof w.company === "string" && w.company.trim().length > 0
        ? w.company.trim()
        : ""
    if (!title && !company) continue
    if (title && company) segments.push(`${title} @ ${company}`)
    else if (title) segments.push(title)
    else segments.push(company)
  }
  // Fallback to experiences[] when workHistory empty.
  if (segments.length === 0) {
    const ex = Array.isArray(cv.experiences) ? cv.experiences : []
    for (const e of ex.slice(0, 3)) {
      const title =
        typeof e.title === "string" && e.title.trim().length > 0
          ? e.title.trim()
          : ""
      const company =
        typeof e.company === "string" && e.company.trim().length > 0
          ? e.company.trim()
          : ""
      if (!title && !company) continue
      if (title && company) segments.push(`${title} @ ${company}`)
      else if (title) segments.push(title)
      else segments.push(company)
    }
  }
  if (segments.length === 0) return undefined
  let out = segments.join("; ")
  if (out.length > WORK_HISTORY_SUMMARY_CAP) {
    out = out.slice(0, WORK_HISTORY_SUMMARY_CAP - 1) + "…"
  }
  return out
}

function deriveTargetRoleFunctionFromCvTitle(title: string | undefined): UserTags["targetRoleFunction"] {
  if (!title) return undefined
  const mapped = mapAnswerToRoleFunction(title)
  return mapped.length > 0 ? mapped : undefined
}

function dedupeRoleFunctions(values: ReadonlyArray<string | undefined | null>): UserTags["targetRoleFunction"] {
  const seen = new Set<RoleFunction>()
  const out: RoleFunction[] = []
  for (const value of values) {
    if (typeof value !== "string") continue
    const token = value.trim().toLowerCase()
    if (!(ROLE_FUNCTION_VOCAB as readonly string[]).includes(token)) continue
    const role = token as RoleFunction
    if (seen.has(role)) continue
    seen.add(role)
    out.push(role)
  }
  return out.length > 0 ? out : undefined
}

function stringsFromUnknown(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function deriveTargetRoleFunctionFromStatedPreferences(
  statedPreferences: StatedPreferences | undefined
): UserTags["targetRoleFunction"] {
  if (!statedPreferences) return undefined
  const ext = statedPreferences as StatedPreferences & { targetRoleFunction?: unknown }
  const direct = dedupeRoleFunctions(stringsFromUnknown(ext.targetRoleFunction))
  if (direct) return direct
  const mapped: string[] = []
  for (const role of stringsFromUnknown(statedPreferences.targetRole)) {
    mapped.push(...mapAnswerToRoleFunction(role))
  }
  return dedupeRoleFunctions(mapped)
}

function normalizeJobTypeToken(value: string): string {
  const token = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (token === "fulltime") return "full_time"
  if (token === "parttime") return "part_time"
  if (token === "new_grad" || token === "newgraduate") return "new_graduate"
  if (token === "intern") return "internship"
  if (token === "coop" || token === "co_op") return "co_op_rotation"
  return token
}

function deriveTargetJobTypeFromStatedPreferences(
  targetJobType: unknown,
  legacyTargetJobTypes: unknown
): UserTags["targetJobType"] {
  const values = stringsFromUnknown(targetJobType)
  if (values.length === 0) values.push(...stringsFromUnknown(legacyTargetJobTypes))
  const seen = new Set<(typeof JOB_TYPE_VOCAB)[number]>()
  const out: Array<(typeof JOB_TYPE_VOCAB)[number]> = []
  for (const value of values) {
    const token = normalizeJobTypeToken(value)
    if (!(JOB_TYPE_VOCAB as readonly string[]).includes(token)) continue
    const jobType = token as (typeof JOB_TYPE_VOCAB)[number]
    if (seen.has(jobType)) continue
    seen.add(jobType)
    out.push(jobType)
  }
  return out.length > 0 ? out : undefined
}

function deriveTargetRoleFunctionFromSkills(skills: ReadonlyArray<Skill>): UserTags["targetRoleFunction"] {
  if (!Array.isArray(skills) || skills.length === 0) return undefined
  const bucketCounts = new Map<SkillBucket, number>()
  for (const skill of skills) {
    const bucket = skill.bucket
    bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1)
  }
  const count = (bucket: SkillBucket): number => bucketCounts.get(bucket) ?? 0
  const engineeringBuckets: SkillBucket[] = [
    "programming_languages",
    "frameworks_and_libraries",
    "devops_and_tooling",
    "cloud_and_infrastructure",
    "databases",
  ]
  const engineeringVariety = engineeringBuckets.filter((bucket) => count(bucket) > 0).length
  const out: RoleFunction[] = []
  if (engineeringVariety >= 3) out.push("software_engineering")
  if (count("data_and_ml") >= 2) out.push("data_analysis")
  if (count("design_and_ux") >= 2) out.push("creatives_and_design")
  if (count("product_and_business") >= 2) out.push("product_management")
  return dedupeRoleFunctions(out)
}

function isCareerStage(value: unknown): value is CareerStage {
  return typeof value === "string" && (CAREER_STAGE_VOCAB as readonly string[]).includes(value)
}

function deriveCareerStageFromYoeRange(yoeRange: [number, number] | undefined): CareerStage | undefined {
  if (!yoeRange) return undefined
  const [minYears, maxYears] = yoeRange
  if (!Number.isFinite(minYears) || !Number.isFinite(maxYears)) return undefined
  const high = Math.max(minYears, maxYears)
  const low = Math.min(minYears, maxYears)
  if (high <= 1) return "entry_level"
  if (high <= 3) return "junior"
  if (high <= 6) return "mid_level"
  if (low >= 7) return "senior"
  return "mid_level"
}

/** Map a scalar YoE count → coarse career stage (mirrors the yoeRange bands). */
function deriveCareerStageFromYears(years: number | undefined): CareerStage | undefined {
  if (typeof years !== "number" || !Number.isFinite(years) || years < 0) return undefined
  return deriveCareerStageFromYoeRange([years, years])
}

/**
 * The set of "downward" stages that a recent intern/TA/student gig can wrongly
 * pin a candidate to. When the title says one of these but the candidate's
 * years-of-experience says otherwise, the title is almost certainly a stale or
 * side gig (e.g. a grad-school teaching-assistant role on a 5-year marketer's
 * résumé) and must NOT override the yoe-derived stage.
 */
const JUNIOR_TITLE_STAGES: ReadonlySet<CareerStage> = new Set<CareerStage>(["intern", "student"])

/** Minimum years that disqualifies an intern/student stage. */
const NON_INTERN_YOE_THRESHOLD = 2

/**
 * Reconcile the title-derived and yoe-derived career stage.
 *
 * `careerStage` is a TARGET hard-filter axis (V16 builds a seniority window
 * around it). A résumé title is a SOFT HINT, NOT a target — the live bug was
 * "Software Engineer Intern" history pinning `careerStage = "intern"`, which
 * (with empty `targetLocations`) over-filtered the matcher to zero. So a
 * downward intern/student TITLE must never become a hard `intern`/`student`
 * target on its own. Capture-merger-writer contract (2026-05-29).
 *
 * Precedence (do NOT change without milestone):
 *  1. Onboarding-stated `careerStage` is authoritative (handled by caller).
 *  2. Prefer the YoE-derived stage for an intern/student title (YoE is a
 *     stronger, intent-adjacent signal than a possibly-stale recent gig):
 *     - YoE ≥ ~2y and genuinely more senior → use the yoe-derived stage
 *       (a recent intern/TA gig overriding a multi-year career).
 *     - any yoe-derived stage present → prefer it over the intern/student
 *       title (the title is a soft hint, the YoE band is the better target).
 *  3. … and when an intern/student title has NO YoE signal at all → leave
 *     careerStage UNSET (return `undefined`) rather than pinning it to
 *     `intern`/`student` as a target. An unset stage lets the V16 matcher
 *     apply its widened (no-window) seniority bypass instead of clamping to
 *     intern-only jobs.
 *  4. A non-intern title with no YoE → keep the title-derived stage (a real
 *     "Senior Engineer" title is a reasonable target hint).
 *  5. No title signal → fall back to the yoe-derived stage.
 *
 * `yoeYearsHigh` is the high end of the YoE signal (max of yoeRange, or the
 * scalar totalYearsExperience) — used to apply the ≥2-year floor.
 */
function reconcileCareerStage(
  titleStage: CareerStage | undefined,
  yoeStage: CareerStage | undefined,
  yoeYearsHigh: number | undefined,
): CareerStage | undefined {
  if (!titleStage) return yoeStage
  if (JUNIOR_TITLE_STAGES.has(titleStage)) {
    // Intern/student TITLE: never pin it as a hard target.
    if (
      yoeStage &&
      typeof yoeYearsHigh === "number" &&
      yoeYearsHigh >= NON_INTERN_YOE_THRESHOLD &&
      CAREER_STAGE_INDEX[yoeStage] > CAREER_STAGE_INDEX[titleStage]
    ) {
      return yoeStage
    }
    // Any yoe-derived stage present → prefer it over the soft title hint.
    if (yoeStage) return yoeStage
    // No YoE signal at all → leave UNSET so the matcher widens the window
    // instead of clamping to intern/student-only jobs.
    return undefined
  }
  return titleStage
}

function deriveCareerStageFromTitle(title: string | undefined): CareerStage | undefined {
  const t = title?.trim().toLowerCase()
  if (!t) return undefined
  // 2026-05-28 fix: intern/student titles take precedence over seniority words.
  // "Product Manager Intern", "Senior Software Engineer Intern", "Marketing
  // Analyst Co-op" are INTERN roles — the function word (manager/senior) must
  // not win. Previously the manager/senior branches below matched first and
  // mis-tagged these (e.g. "Product Manager Intern" → manager). Guard: a role
  // that MANAGES interns ("intern program manager", "manager of interns") is
  // NOT itself an intern.
  const managesInterns =
    /\bintern(ship)?s?\s+(program\s+)?(manager|lead|director|coordinator|supervisor)\b/.test(t) ||
    /\b(manager|director|head|lead)\s+of\s+intern/.test(t)
  if (!managesInterns) {
    if (/\bintern(ship)?\b/.test(t) || /\bco[-\s]?op\b/.test(t)) return "intern"
    if (/\bstudent\b/.test(t)) return "student"
  }
  if (/\bfounder\b/.test(t)) return "founder"
  if (/\b(c[-\s]?level|chief|cto|ceo|cfo|coo|cmo)\b/.test(t)) return "c_level"
  if (/\bvp|vice\s+president\b/.test(t)) return "vp"
  if (/\bdirector\b/.test(t)) return "director"
  if (/\bprincipal\b/.test(t)) return "principal"
  if (/\bstaff\b/.test(t)) return "staff"
  if (/\b(lead|manager|head of)\b/.test(t)) return "manager"
  if (/\bsenior|sr\.?\b/.test(t)) return "senior"
  if (/\b(mid[-\s]?level|sde\s*ii|software engineer ii)\b/.test(t)) return "mid_level"
  if (/\b(junior|jr\.?)\b/.test(t)) return "junior"
  if (/\b(entry[-\s]?level|new\s+grad|graduate)\b/.test(t)) return "entry_level"
  if (/\bintern(ship)?\b/.test(t)) return "intern"
  if (/\bstudent\b/.test(t)) return "student"
  return undefined
}

// NOTE (capture-merger-writer contract, 2026-05-29): the former
// `deriveTargetJobTypeFromProfile(title, careerStage)` helper was REMOVED.
// `targetJobType` is a TARGET hard-filter axis and must come from INTENT only
// (statedPreferences / onboarding / extractor) — never from the résumé title
// or a title-derived careerStage. Deriving a target jobType from a "...Intern"
// history title (→ `["internship"]`) was the live recall bug. Do NOT
// reintroduce a résumé→targetJobType derivation.

const COMPANY_SIZE_SET = new Set<string>(COMPANY_SIZE_VOCAB)

function isCompanySize(value: unknown): value is CompanySize {
  return typeof value === "string" && COMPANY_SIZE_SET.has(value)
}

/**
 * Normalize a stated company-size preference to the canonical schema shape.
 * Accepts a single token or an OR array (2026-05-30). Off-vocab values are
 * dropped (validated vs the shared `COMPANY_SIZE_VOCAB` closed enum, no regex).
 * Returns a scalar for a single value (back-compat) and an array for a
 * multi-pick OR; `undefined` when nothing valid was provided. Carried so a
 * chat-set size survives a CV re-merge.
 */
function mapCompanySizePreference(value: unknown): UserTags["companySize"] {
  if (Array.isArray(value)) {
    const valid = Array.from(new Set(value.filter(isCompanySize)))
    if (valid.length === 0) return undefined
    return valid.length === 1 ? valid[0] : valid
  }
  return isCompanySize(value) ? value : undefined
}

const COMPANY_STAGE_SET = new Set<string>(COMPANY_STAGE_VOCAB)

function isCompanyStage(value: unknown): value is (typeof COMPANY_STAGE_VOCAB)[number] {
  return typeof value === "string" && COMPANY_STAGE_SET.has(value)
}

/** Company-STAGE (funding) preference — same OR/scalar shape as companySize. Off-vocab dropped. */
function mapCompanyStagePreference(value: unknown): UserTags["companyStage"] {
  if (Array.isArray(value)) {
    const valid = Array.from(new Set(value.filter(isCompanyStage)))
    if (valid.length === 0) return undefined
    return valid.length === 1 ? valid[0] : valid
  }
  return isCompanyStage(value) ? value : undefined
}

/**
 * Map StatedPreferences.visaStatus → tag-schema visa token.
 *
 * D4 canonicalization (Jyesht-Diwani fix 2026-05-28): a green-card holder must
 * land on the canonical `permanent_resident` token, NOT the legacy `gc` alias.
 * Both `gc` and the canonical `permanent_resident` (which `StatedPreferences`
 * may carry from `onboarding.ts`) normalize to `permanent_resident`. `opt` /
 * `h1b` are intentionally preserved (downstream match-reason readers key on
 * them and they are out of scope for this fix).
 */
function mapVisaStatus(
  v: StatedPreferences["visaStatus"] | "permanent_resident",
): TagsVisaStatus | undefined {
  if (v == null) return undefined
  switch (v) {
    case "citizen":
    case "opt":
    case "h1b":
      return v
    case "gc":
    case "permanent_resident":
      return "permanent_resident"
    case "sponsorship_needed":
      return "sponsor_needed"
    case "unknown":
      return "other"
    default:
      return undefined
  }
}

/** Map StatedPreferences.prefersStartup (boolean | null) → tag-schema enum. */
function mapPrefersStartup(
  v: StatedPreferences["prefersStartup"]
): StartupPreference | undefined {
  if (v === true) return "startup"
  if (v === false) return "bigtech"
  if (v === null) return "either"
  return undefined
}

/** Map preferredLang signal — drop "mixed" (caller falls back to runtime detect). */
function mapPreferredLang(
  fromInput: UserTagsInput["preferredLang"],
  fromPrefs: StatedPreferences["preferredLang"]
): TagsPreferredLang | undefined {
  const v = fromInput ?? fromPrefs
  if (v === "zh" || v === "en") return v
  return undefined
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fold the 4+ disjoint candidate-signal sources (CV doc, statedPreferences,
 * embedding fields, lang lock) into one canonical `UserTags` object that
 * lives at `pa-users/{userId}.tags`.
 *
 * Pure / deterministic. Does NOT mutate input. Does NOT touch Firestore.
 * Caller is responsible for read + write side effects (H.3 worker).
 */
export function mergeUserTags(input: UserTagsInput): UserTags {
  const { cv, statedPreferences, cvUpdatedAt, chatUpdatedAt } = input

  // ---- CV side --------------------------------------------------------
  const skills = collectSkills(cv)
  const industryEnum = composeIndustryEnum(cv, statedPreferences, skills)
  const { title: recentRoleTitle, company: recentCompany } = pickRecentRole(cv)
  const workHistorySummary = buildWorkHistorySummary(cv)

  // ---- embedding pass-through ----------------------------------------
  let embedding: number[] | undefined
  let embeddingModel: string | undefined
  let embeddingComputedAt: string | undefined
  if (cv?.embedding && Array.isArray(cv.embedding) && cv.embedding.length === 1536) {
    embedding = cv.embedding
    if (typeof cv.embeddingModel === "string" && cv.embeddingModel.length > 0) {
      embeddingModel = cv.embeddingModel
    }
    if (typeof cv.embeddingComputedAt === "string" && cv.embeddingComputedAt.length > 0) {
      embeddingComputedAt = cv.embeddingComputedAt
    }
  }

  // ---- chat side ------------------------------------------------------
  const targetRoleValues = stringsFromUnknown(statedPreferences?.targetRole)
  const targetRole = targetRoleValues.length > 0 ? [...targetRoleValues] : undefined
  // RÉSUMÉ→TARGET DERIVATION — SINGLE ALLOWED EXCEPTION (capture-merger-writer
  // contract, 2026-05-29). `targetRoleFunction` is a TARGET hard-filter axis,
  // and almost every target axis must come from INTENT (statedPreferences /
  // onboarding / extractor), NEVER from the résumé. The ONE exception is
  // `targetRoleFunction`: inferring the role family from the candidate's recent
  // title / skill mix is reasonable as a LAST-RESORT default when intent gave
  // us nothing (a SWE résumé → targeting software_engineering is a sane guess,
  // and an empty `targetRoleFunction` makes V16 fall back to a non-role-gated
  // query). statedPreferences ALWAYS wins; CV-title and CV-skill derivations
  // only fire when intent is empty. This is intentionally distinct from
  // `targetJobType` (intent-ONLY — see below — because "Software Engineer
  // Intern" history must NOT become a `targetJobType=[internship]` hard filter)
  // and `careerStage` (title is a soft hint only — see below).
  const targetRoleFunction =
    deriveTargetRoleFunctionFromStatedPreferences(statedPreferences) ??
    deriveTargetRoleFunctionFromCvTitle(recentRoleTitle) ??
    deriveTargetRoleFunctionFromSkills(skills)
  const yoeRange =
    Array.isArray(statedPreferences?.yoeRange) && statedPreferences.yoeRange.length === 2
      ? ([statedPreferences.yoeRange[0], statedPreferences.yoeRange[1]] as [number, number])
      : undefined
  const statedPreferencesExt = statedPreferences as
    | (StatedPreferences & {
        careerStage?: unknown
        companySize?: unknown
        companyStage?: unknown
        minSalary?: unknown
        minSalaryUsd?: unknown
        targetJobType?: unknown
        targetJobTypes?: unknown
      })
    | undefined
  // careerStage precedence: onboarding-stated wins; otherwise reconcile the
  // title-derived stage against the YoE-derived stage so a recent intern/TA
  // gig can't drag a multi-year career down to `intern`/`student`. YoE comes
  // from onboarding `yoeRange` first, falling back to résumé
  // `totalYearsExperience`.
  const cvTotalYears =
    typeof cv?.totalYearsExperience === "number" && Number.isFinite(cv.totalYearsExperience)
      ? cv.totalYearsExperience
      : undefined
  const yoeHigh =
    yoeRange !== undefined
      ? Math.max(yoeRange[0], yoeRange[1])
      : cvTotalYears
  const yoeDerivedStage =
    deriveCareerStageFromYoeRange(yoeRange) ?? deriveCareerStageFromYears(cvTotalYears)
  const careerStage = isCareerStage(statedPreferencesExt?.careerStage)
    ? statedPreferencesExt.careerStage
    : reconcileCareerStage(
        deriveCareerStageFromTitle(recentRoleTitle),
        yoeDerivedStage,
        yoeHigh,
      )
  const visaStatus = mapVisaStatus(statedPreferences?.visaStatus)
  const prefersStartup = mapPrefersStartup(statedPreferences?.prefersStartup)
  const targetLocations = Array.isArray(statedPreferences?.targetLocations)
    ? [...statedPreferences.targetLocations]
    : undefined
  const targetCountry = Array.isArray(statedPreferences?.targetCountry)
    ? [...statedPreferences.targetCountry]
    : undefined
  const preferredLang = mapPreferredLang(input.preferredLang, statedPreferences?.preferredLang)
  const minSalary =
    typeof statedPreferencesExt?.minSalary === "number" && Number.isFinite(statedPreferencesExt.minSalary)
      ? Math.max(0, Math.floor(statedPreferencesExt.minSalary))
      : typeof statedPreferencesExt?.minSalaryUsd === "number" && Number.isFinite(statedPreferencesExt.minSalaryUsd)
        ? Math.max(0, Math.floor(statedPreferencesExt.minSalaryUsd))
        : typeof statedPreferences?.salaryFloor === "number" && Number.isFinite(statedPreferences.salaryFloor)
          ? Math.max(0, Math.floor(statedPreferences.salaryFloor))
          : undefined
  const companySize = mapCompanySizePreference(statedPreferencesExt?.companySize)
  const companyStage = mapCompanyStagePreference(statedPreferencesExt?.companyStage)
  // targetJobType is INTENT-ONLY (capture-merger-writer contract, 2026-05-29).
  // THE LIVE BUG: this previously had a
  //   `?? deriveTargetJobTypeFromProfile(recentRoleTitle, careerStage)`
  // résumé fallback, so a candidate whose recent title was "Software Engineer
  // Intern" got `targetJobType = ["internship"]` — a TARGET hard filter
  // inferred from HISTORY. V16 then hard-dropped every non-internship job →
  // recCount=0. targetJobType is a TARGET axis (what the candidate wants NOW),
  // never derivable from what they did BEFORE. It is set ONLY from
  // statedPreferences (onboarding / triage / extractor intent). When intent
  // carries none → leave UNSET so the matcher does not gate on jobType at all
  // (the matcher domain owns the intent-confirmed graceful fallback, NOT the
  // résumé). `deriveTargetJobTypeFromProfile` is intentionally retired here.
  const targetJobType = deriveTargetJobTypeFromStatedPreferences(
    statedPreferencesExt?.targetJobType,
    statedPreferencesExt?.targetJobTypes
  )

  // ---- Phase B2 — company preference pass-through ---------------------
  // targetCompanyTags: dedupe + lowercase, cap at 30 to mirror UserTagsSchema.
  // urgentlySeeking: strict boolean pass-through (drop non-booleans).
  const urgentlySeeking =
    typeof statedPreferences?.urgentlySeeking === "boolean"
      ? statedPreferences.urgentlySeeking
      : undefined

  // ---- Phase 53 — canonical Phase 52 fields pass-through --------------
  // Each field defensively normalized: lowercase + trimmed strings, dedupe.
  const dedupedStrings = (
    raw: string[] | undefined,
    cap?: number
  ): string[] | undefined => {
    if (!Array.isArray(raw)) return undefined
    const seen = new Set<string>()
    const out: string[] = []
    for (const v of raw) {
      if (typeof v !== "string") continue
      const norm = v.trim().toLowerCase()
      if (norm.length === 0 || seen.has(norm)) continue
      seen.add(norm)
      out.push(norm)
      if (cap && out.length >= cap) break
    }
    return out.length > 0 ? out : undefined
  }
  // W3 — `industrySector` field is now typed as `IndustrySector[]`
  // (canonical 42-token vocab). Narrow the deduped strings to the canonical
  // set so a non-vocab upstream value is dropped at the merge boundary rather
  // than silently corrupting the schema. `INDUSTRY_SECTOR_VOCAB` is bound at
  // module top.
  const onlyCanonicalSectors = (
    raw: string[] | undefined,
  ): Array<(typeof INDUSTRY_SECTOR_VOCAB)[number]> | undefined => {
    if (!raw) return undefined
    const filtered = raw.filter(
      (t): t is (typeof INDUSTRY_SECTOR_VOCAB)[number] =>
        (INDUSTRY_SECTOR_VOCAB as readonly string[]).includes(t),
    )
    return filtered.length > 0 ? filtered : undefined
  }
  // industrySector source precedence (Jyesht-Diwani fix 2026-05-28):
  //   1. parser `relevantIndustry` / `industries` (accurate — extracted from
  //      the candidate's actual work experience) filtered to canonical vocab,
  //   2. fall back to `cv.industrySector` ONLY when the parser yielded no
  //      canonical sector. Historically `cv.industrySector` carried the
  //      cv-ingest "industry second-pass" output, which fires on a weak F1
  //      `industryTags` extract and can hallucinate sectors a candidate never
  //      worked in (e.g. AI/ML + clean-energy for a pure marketer). Preferring
  //      `relevantIndustry` keeps the accurate signal and drops the
  //      low-confidence override. Non-canonical tokens are dropped either way.
  const industrySector =
    onlyCanonicalSectors(dedupedStrings(cv?.relevantIndustry, 6)) ??
    onlyCanonicalSectors(dedupedStrings(cv?.industrySector, 6))
  const relevantIndustry = dedupedStrings(cv?.relevantIndustry, 6)
  const relevantSpecialization = dedupedStrings(cv?.relevantSpecialization, 6)
  const proposedTags = dedupedStrings(cv?.proposedTags, 12)
  // Phase B2 — company-tag pref. Cap=30 mirrors UserTagsSchema.max(30).
  const targetCompanyTags = dedupedStrings(statedPreferences?.targetCompanyTags, 30)

  // ---- SOFT-vs-HARD preference model (2026-05-28) ---------------------
  // Pass-through `preferenceHardness` from statedPreferences, validated
  // through the canonical schema (drops non-vocab axes / malformed entries).
  // Parse-fail (or absent) → undefined → field omitted (backward compat).
  const preferenceHardnessRaw = (statedPreferences as { preferenceHardness?: unknown } | undefined)
    ?.preferenceHardness
  let preferenceHardness: UserTags["preferenceHardness"]
  if (preferenceHardnessRaw && typeof preferenceHardnessRaw === "object") {
    const parsed = PreferenceHardnessSchema.safeParse(preferenceHardnessRaw)
    if (parsed.success && Object.keys(parsed.data).length > 0) {
      preferenceHardness = parsed.data
    }
  }

  // ---- assemble + omit-undefined --------------------------------------
  // We deliberately avoid placing `undefined` keys on the output so the
  // shape round-trips through Firestore (Firestore drops `undefined` on
  // write but preserves `null` — exact-match tests are easier without
  // either).
  const out: UserTags = {
    skills,
    industryEnum,
    schemaVersion: USER_TAGS_SCHEMA_VERSION,
  }
  if (recentRoleTitle) out.recentRoleTitle = recentRoleTitle
  if (recentCompany) out.recentCompany = recentCompany
  if (workHistorySummary) out.workHistorySummary = workHistorySummary
  if (embedding) out.embedding = embedding
  if (embeddingModel) out.embeddingModel = embeddingModel
  if (embeddingComputedAt) out.embeddingComputedAt = embeddingComputedAt
  if (targetRole) out.targetRole = targetRole
  if (targetRoleFunction) out.targetRoleFunction = targetRoleFunction
  if (yoeRange) out.yoeRange = yoeRange
  if (careerStage) out.careerStage = careerStage
  if (visaStatus) out.visaStatus = visaStatus
  if (prefersStartup) out.prefersStartup = prefersStartup
  if (targetLocations) out.targetLocations = targetLocations
  if (targetCountry) out.targetCountry = targetCountry
  if (preferredLang) out.preferredLang = preferredLang
  if (minSalary !== undefined) out.minSalary = minSalary
  if (companySize) out.companySize = companySize
  if (companyStage) out.companyStage = companyStage
  if (targetJobType) out.targetJobType = targetJobType
  if (industrySector && industrySector.length > 0) out.industrySector = industrySector
  if (relevantIndustry) out.relevantIndustry = relevantIndustry
  if (relevantSpecialization) out.relevantSpecialization = relevantSpecialization
  if (proposedTags) out.proposedTags = proposedTags
  if (targetCompanyTags) out.targetCompanyTags = targetCompanyTags
  if (urgentlySeeking !== undefined) out.urgentlySeeking = urgentlySeeking
  if (preferenceHardness) out.preferenceHardness = preferenceHardness
  if (cv && cvUpdatedAt) out.lastUpdatedFromCv = cvUpdatedAt
  if (statedPreferences && chatUpdatedAt) out.lastUpdatedFromChat = chatUpdatedAt

  return out
}
