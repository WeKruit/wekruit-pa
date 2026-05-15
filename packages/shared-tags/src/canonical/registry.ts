/**
 * Phase 52 — Canonical vocab registry. [TAG-10]
 *
 * Maps vocab name → `{ values, schema, supportsOverlay }` so consumers
 * (Phase 59 dashboard, mergeUserTags, JD enrichment) can iterate over
 * **all** canonical axes without hard-coding 9 separate imports.
 *
 * Adam-locked: D8 — single source of truth, no vocab duplication.
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
}

export const ALL_CANONICAL_VOCABS: Record<string, CanonicalVocabEntry> = {
  roleFunction: {
    name: "roleFunction",
    values: ROLE_FUNCTION_VOCAB,
    schema: RoleFunctionSchema,
    supportsOverlay: false,
    isOpenVocab: false,
    matchSemantics: "hard_filter",
  },
  industrySector: {
    name: "industrySector",
    values: INDUSTRY_SECTOR_VOCAB,
    schema: IndustrySectorSchema,
    supportsOverlay: true, // D16 — admin add-able
    isOpenVocab: false,
    matchSemantics: "soft_score",
  },
  major: {
    name: "major",
    values: MAJOR_VOCAB,
    schema: MajorSchema,
    supportsOverlay: false,
    isOpenVocab: false,
    matchSemantics: "soft_score", // D3
  },
  visa: {
    name: "visa",
    values: VISA_VOCAB,
    schema: VisaSchema,
    supportsOverlay: false,
    isOpenVocab: false,
    matchSemantics: "hard_filter",
  },
  jobType: {
    name: "jobType",
    values: JOB_TYPE_VOCAB,
    schema: JobTypeSchema,
    supportsOverlay: false,
    isOpenVocab: false,
    matchSemantics: "hard_filter",
  },
  careerStage: {
    name: "careerStage",
    values: CAREER_STAGE_VOCAB,
    schema: CareerStageSchema,
    supportsOverlay: false,
    isOpenVocab: false,
    matchSemantics: "hard_filter",
  },
  location: {
    name: "location",
    values: LOCATION_VOCAB,
    schema: LocationSchema,
    supportsOverlay: false,
    isOpenVocab: false,
    matchSemantics: "hard_filter",
  },
  relevantTags: {
    name: "relevantTags",
    values: [], // open vocab
    schema: RelevantTagSchema,
    supportsOverlay: false, // separate sandbox path inside overlay collection
    isOpenVocab: true,
    pattern: RELEVANT_TAG_PATTERN,
    matchSemantics: "soft_score",
  },
  skillBucket: {
    name: "skillBucket",
    values: SKILL_BUCKET_VOCAB,
    schema: SkillBucketSchema,
    supportsOverlay: false,
    isOpenVocab: false,
    matchSemantics: "soft_score", // bucket × name combined
  },
  companyStage: {
    name: "companyStage",
    values: COMPANY_STAGE_VOCAB,
    schema: CompanyStageSchema,
    supportsOverlay: false,
    isOpenVocab: false,
    matchSemantics: "soft_score", // informational only (weight 0)
  },
  companyTag: {
    name: "companyTag",
    values: COMPANY_TAG_VOCAB,
    schema: CompanyTagSchema,
    supportsOverlay: true, // admin promote via overlay collection
    isOpenVocab: true,
    pattern: COMPANY_TAG_PATTERN,
    matchSemantics: "soft_score",
  },
}

export const CANONICAL_VOCAB_NAMES = Object.keys(
  ALL_CANONICAL_VOCABS,
) as readonly string[]
