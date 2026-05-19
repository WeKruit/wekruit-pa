/**
 * Phase 52 — Canonical vocab registry. [TAG-10]
 *
 * Maps vocab name → `{ values, schema, supportsOverlay }` so consumers
 * (Phase 59 dashboard, mergeUserTags, JD enrichment) can iterate over
 * **all** canonical axes without hard-coding 9 separate imports.
 *
 * Adam-locked: D8 — single source of truth, no vocab duplication.
 *
 * Workstream W4 (pre-launch matching hardening, follows W3 #117) extends
 * each entry with `userField` / `jobField` / `required` so V16 can derive
 * the access path for `pa-users.tags.<userField>` and
 * `matching-jobs.<jobField>` from the registry instead of hardcoding
 * casts. W5 will refactor V16 to consume these bindings (e.g. the
 * `needsOnboarding` loop currently at
 * `apps/job-rec/src/tools/query-matching-jobs-v16.ts:1480` can iterate
 * `REQUIRED_AXES` rather than the 5 axis names spelled out by hand).
 */

import type { z } from "zod"
import {
  ROLE_FUNCTION_VOCAB,
  RoleFunctionSchema,
} from "./role-function.js"
import {
  INDUSTRY_SECTOR_VOCAB,
  IndustrySectorSchema,
} from "./industry-sector.js"
import { MAJOR_VOCAB, MajorSchema } from "./major.js"
import { VISA_VOCAB, VisaSchema } from "./visa.js"
import { JOB_TYPE_VOCAB, JobTypeSchema } from "./job-type.js"
import { CAREER_STAGE_VOCAB, CareerStageSchema } from "./career-stage.js"
import { LOCATION_VOCAB, LocationSchema } from "./location.js"
import {
  RELEVANT_TAG_PATTERN,
  RelevantTagSchema,
} from "./relevant-tags.js"
import {
  SKILL_BUCKET_VOCAB,
  SkillBucketSchema,
} from "./skills.js"
import {
  COMPANY_STAGE_VOCAB,
  CompanyStageSchema,
} from "./company-stage.js"
import {
  COMPANY_TAG_VOCAB,
  COMPANY_TAG_PATTERN,
  CompanyTagSchema,
} from "./company-tag.js"

export interface CanonicalVocabEntry {
  /** Human-readable vocab name (e.g., `"roleFunction"`). */
  name: string
  /** Closed-enum values (or empty array for open-vocab axes). */
  values: readonly string[]
  /** Zod schema for write-time validation. */
  schema: z.ZodType<string>
  /** Whether the vocab supports runtime overlay sandbox→promote. */
  supportsOverlay: boolean
  /** Whether the vocab is open (no fixed enum) — pattern-based instead. */
  isOpenVocab: boolean
  /** If `isOpenVocab`, the regex pattern that tokens must match. */
  pattern?: RegExp
  /** Hard-filter vs soft-score signal at match time. */
  matchSemantics: "hard_filter" | "soft_score"

  /**
   * Workstream W4 — field path on `pa-users/{uid}.tags.<userField>`. Used
   * by V16 + downstream consumers to derive axis access without hardcoding
   * (see `apps/job-rec/src/tools/query-matching-jobs-v16.ts`). `undefined`
   * when the axis has no direct user-side property — e.g. `companyTag`
   * composes `companyPositiveList` + `companyNegativeList`, so there is no
   * single user field to bind.
   */
  userField?: string

  /**
   * Workstream W4 — field path on `matching-jobs/{jobId}.<jobField>`. Used
   * by V16 hard-filter + soft-score loops to derive axis access without
   * hardcoding. `undefined` when the axis is user-side-only (e.g. `major`
   * is a soft signal on the user CV with no job-side counterpart) or when
   * the axis is sourced from a composite (e.g. `companyTags` lives on
   * `pa-companies`, joined into matching results — not stored directly on
   * `matching-jobs/{jobId}`).
   */
  jobField?: string

  /**
   * Workstream W4 — when true, V16 surfaces `needsOnboarding=true` if
   * `userTags[userField]` is empty. Drives the post-match Claire prompt
   * to fill missing onboarding answers before the next rec round.
   *
   * Adam-locked to the 3 axes that block correct match retrieval:
   * `roleFunction` (query-level hard gate at array-contains-any),
   * `visa` (sponsorship hard filter), and `location` (location hard
   * filter w/ anywhere bypass).
   */
  required?: boolean
}

/**
 * Workstream W4 — typed via `satisfies` (not annotated as
 * `Record<string, CanonicalVocabEntry>`) so the literal `userField` / `jobField`
 * strings on each entry are preserved at the type level. This is required for
 * the compile-time `keyof UserTags` guard in `pa-orchestrator`'s test suite —
 * if it widens back to `string`, the drift check goes silent.
 */
export const ALL_CANONICAL_VOCABS = {
  roleFunction: {
    name: "roleFunction",
    values: ROLE_FUNCTION_VOCAB,
    schema: RoleFunctionSchema,
    supportsOverlay: false,
    isOpenVocab: false,
    matchSemantics: "hard_filter",
    // W4 — V16 query layer: where('roleFunction', 'array-contains-any',
    // userTags.targetRoleFunction). Missing = needsOnboarding.
    userField: "targetRoleFunction",
    jobField: "roleFunction",
    required: true,
  },
  industrySector: {
    name: "industrySector",
    values: INDUSTRY_SECTOR_VOCAB,
    schema: IndustrySectorSchema,
    supportsOverlay: true, // D16 — admin add-able
    isOpenVocab: false,
    matchSemantics: "soft_score",
    // W4 — same field name both sides (D8 single source).
    userField: "industrySector",
    jobField: "industrySector",
    required: false,
  },
  major: {
    name: "major",
    values: MAJOR_VOCAB,
    schema: MajorSchema,
    supportsOverlay: false,
    isOpenVocab: false,
    matchSemantics: "soft_score", // D3
    // W4 — `major` is a per-education-entry signal on
    // `pa-resume-parser` output (see `packages/pa-resume-parser/src/schema.ts`
    // `education[i].major`), not a top-level `UserTags` key. Both fields
    // are intentionally undefined so generic V16 axis loops skip it; the
    // CV parser handles major matching via its own nested path.
    userField: undefined,
    jobField: undefined,
    required: false,
  },
  visa: {
    name: "visa",
    values: VISA_VOCAB,
    schema: VisaSchema,
    supportsOverlay: false,
    isOpenVocab: false,
    matchSemantics: "hard_filter",
    // W4 — user is `visaStatus` (1 of 4 D4 tokens); job is `sponsorship`
    // (bool). V16 drops jobs with sponsorship=false when user is
    // sponsor_needed. Missing = needsOnboarding.
    userField: "visaStatus",
    jobField: "sponsorship",
    required: true,
  },
  jobType: {
    name: "jobType",
    values: JOB_TYPE_VOCAB,
    schema: JobTypeSchema,
    supportsOverlay: false,
    isOpenVocab: false,
    matchSemantics: "hard_filter",
    // W4 — user is plural array `targetJobType[]`; job is singular `jobType`
    // (one of 10 D5 tokens). V16 hard filter checks job.jobType ∈
    // user.targetJobType. NOT required: legacy V16 falls back to
    // `tagsExt.targetJobTypes` and ultimately serves an unfiltered set when
    // both are empty (graceful, not an onboarding block).
    userField: "targetJobType",
    jobField: "jobType",
    required: false,
  },
  careerStage: {
    name: "careerStage",
    values: CAREER_STAGE_VOCAB,
    schema: CareerStageSchema,
    supportsOverlay: false,
    isOpenVocab: false,
    matchSemantics: "hard_filter",
    // W4 — user is `careerStage` (canonical token); job is `seniorityLevel`
    // (same vocab, but V16 widens via `acceptableCareerStages()`). NOT
    // required: V16 falls back to title-regex inference when both are
    // absent.
    userField: "careerStage",
    jobField: "seniorityLevel",
    required: false,
  },
  location: {
    name: "location",
    values: LOCATION_VOCAB,
    schema: LocationSchema,
    supportsOverlay: false,
    isOpenVocab: false,
    matchSemantics: "hard_filter",
    // W4 — user is plural `targetLocations[]`; job is plural
    // `locationBuckets[]`. V16 intersects (with anywhere bypass). Missing
    // user target = needsOnboarding because V16 cannot apply the location
    // gate without it.
    userField: "targetLocations",
    jobField: "locationBuckets",
    required: true,
  },
  relevantTags: {
    name: "relevantTags",
    values: [], // open vocab
    schema: RelevantTagSchema,
    supportsOverlay: false, // separate sandbox path inside overlay collection
    isOpenVocab: true,
    pattern: RELEVANT_TAG_PATTERN,
    matchSemantics: "soft_score",
    // W4 — same field name both sides (open vocab, max 12 cap).
    userField: "relevantTags",
    jobField: "relevantTags",
    required: false,
  },
  skillBucket: {
    name: "skillBucket",
    values: SKILL_BUCKET_VOCAB,
    schema: SkillBucketSchema,
    supportsOverlay: false,
    isOpenVocab: false,
    matchSemantics: "soft_score", // bucket × name combined
    // W4 — user is `skills` (SkillEntry[] with bucket + baseWeight); job
    // is `requiredSkills` (string[]). V16 computes weighted Jaccard
    // (skill name × baseWeight × jd-rel) — both fields are bound here so
    // the soft-score loop can find them generically.
    userField: "skills",
    jobField: "requiredSkills",
    required: false,
  },
  companyStage: {
    name: "companyStage",
    values: COMPANY_STAGE_VOCAB,
    schema: CompanyStageSchema,
    supportsOverlay: false,
    isOpenVocab: false,
    matchSemantics: "soft_score", // informational only (weight 0)
    // W4 — user is preference list `targetCompanyTags`; job-side stage
    // lives on `pa-companies/{slug}.companyStage` (joined into ranking
    // input via `load-companies.ts`, NOT on `matching-jobs` directly).
    userField: "targetCompanyTags",
    jobField: "companyTags",
    required: false,
  },
  companyTag: {
    name: "companyTag",
    values: COMPANY_TAG_VOCAB,
    schema: CompanyTagSchema,
    supportsOverlay: true, // admin promote via overlay collection
    isOpenVocab: true,
    pattern: COMPANY_TAG_PATTERN,
    matchSemantics: "soft_score",
    // W4 — composite axis on both sides:
    //   - user: `companyPositiveList` + `companyNegativeList` (separate
    //     positive/negative reducer in V16); `targetCompanyTags` for the
    //     tag-style preference.
    //   - job: stitched from `pa-companies/{slug}.companyTags` at load
    //     time, not stored on `matching-jobs`.
    // Both intentionally `undefined` (not omitted) — consumers must handle
    // this axis with the dedicated company-name normalization path, not a
    // generic field lookup. Explicit undefined keeps the entry's literal
    // type uniform with the other 10 axes so generic loops type-check.
    userField: undefined,
    jobField: undefined,
    required: false,
  },
} as const satisfies Record<string, CanonicalVocabEntry>

export const CANONICAL_VOCAB_NAMES = Object.keys(
  ALL_CANONICAL_VOCABS,
) as readonly string[]

// ---------------------------------------------------------------------------
// Workstream W4 — convenience selectors over the registry. Consumers
// (V16 needsOnboarding loop, hard-filter loop, soft-score loop) read these
// instead of hardcoding axis names. Computed once at module load; immutable.
// ---------------------------------------------------------------------------

/**
 * Axes that block correct match retrieval when the user has not answered.
 * V16 surfaces `needsOnboarding=true` with `missingAxes` populated from
 * this list. Adam-locked subset: roleFunction, visa, location.
 */
export const REQUIRED_AXES: readonly string[] = Object.entries(
  ALL_CANONICAL_VOCABS,
)
  .filter(([, v]) => v.required === true)
  .map(([k]) => k)

/**
 * Axes that V16 applies as hard filters (drop the job when it fails).
 * Includes both required + non-required hard-filter axes (e.g. jobType
 * and careerStage are hard filters but degrade gracefully when the user
 * has not specified them).
 */
export const HARD_FILTER_AXES: readonly string[] = Object.entries(
  ALL_CANONICAL_VOCABS,
)
  .filter(([, v]) => v.matchSemantics === "hard_filter")
  .map(([k]) => k)

/**
 * Axes that V16 applies as soft scores (contribute to weighted total,
 * never drop the job).
 */
export const SOFT_SCORE_AXES: readonly string[] = Object.entries(
  ALL_CANONICAL_VOCABS,
)
  .filter(([, v]) => v.matchSemantics === "soft_score")
  .map(([k]) => k)
