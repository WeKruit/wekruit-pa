/**
 * @pa/job-tag-enricher — Zod schema for `EnrichedJobTags`.
 *
 * Symmetric to `parsedResumeData` from pa-resume-parser, but for the
 * job-posting side. Single shared-tags canonical vocab is the authority
 * (`@wekruit/shared-tags/canonical/*`); we re-import the vocab arrays so
 * Zod hard-validates LLM output against the same enum the matching path
 * reads from. No regex token-derivation; LLM is the only writer.
 *
 * Fields locked v1.6 D1..D16 + v1.7 ENRICHER-01..03:
 *  - roleFunction       — closed jobright-17 enum, multi-pick (1..2)
 *  - industrySector     — closed 42-vocab, multi-pick (1..3) — D2 admin-extensible
 *  - relevantTags       — open vocab (max 12, lowercase + underscore, ≥3 chars)
 *  - skills             — bucketed Skill[] (per shared-tags `SkillSchema`)
 *  - seniorityLevel     — closed 13-stage enum (single-pick)
 *  - sponsorshipHint    — boolean | null (only when JD explicit)
 *  - locationBuckets    — closed 130+ enum (multi-pick, max 6)
 *  - jobType            — closed 10-enum (single-pick)
 *  - confidence         — { overall, fields } subjective LLM confidence
 */

import { z } from "zod"
import {
  ROLE_FUNCTION_VOCAB,
  INDUSTRY_SECTOR_VOCAB,
  CAREER_STAGE_VOCAB,
  JOB_TYPE_VOCAB,
  LOCATION_VOCAB,
  SKILL_BUCKET_VOCAB,
  SKILL_PROFICIENCY_VOCAB,
  SKILL_NAME_PATTERN,
} from "@wekruit/shared-tags/canonical"

/** Open-vocab `relevantTags` pattern — lowercase + underscore, 2-80 chars. */
const RELEVANT_TAG_PATTERN = /^[a-z][a-z0-9_]{1,79}$/

/**
 * Skill object — mirrors shared-tags `SkillSchema` but tolerates
 * baseWeight=0.5 default + optional fields, since LLM may not always
 * emit a per-skill weight. Note: we do NOT call `KNOWN_ABBREVIATIONS`
 * `.refine` here since the LLM is prompted to spell out; if it slips,
 * a downstream retry with stricter prompt handles it (parser.ts loop).
 */
export const enrichedSkillEntry = z.object({
  name: z
    .string()
    .regex(SKILL_NAME_PATTERN, "skill name must be lowercase 2-64 chars [a-z0-9_+#.-]"),
  bucket: z.enum(SKILL_BUCKET_VOCAB),
  proficiency: z.enum(SKILL_PROFICIENCY_VOCAB),
  evidenceCount: z.number().int().nonnegative().default(1),
  baseWeight: z.number().min(0).max(1).default(0.5),
})
export type EnrichedSkillEntry = z.infer<typeof enrichedSkillEntry>

/** Per-field confidence map — every field 0..1; LLM emits subjective grades. */
export const confidenceFields = z.object({
  roleFunction: z.number().min(0).max(1),
  industrySector: z.number().min(0).max(1),
  relevantTags: z.number().min(0).max(1),
  skills: z.number().min(0).max(1),
  seniorityLevel: z.number().min(0).max(1),
  locationBuckets: z.number().min(0).max(1),
  jobType: z.number().min(0).max(1),
})
export type ConfidenceFields = z.infer<typeof confidenceFields>

export const enrichedConfidence = z.object({
  overall: z.number().min(0).max(1),
  fields: confidenceFields,
})
export type EnrichedConfidence = z.infer<typeof enrichedConfidence>

/**
 * The enricher's contract. Hard-validated by Zod against the shared
 * canonical vocab. Any LLM output that produces an out-of-vocab token
 * triggers a parse error → outer retry → next-tier fallback.
 */
export const enrichedJobTags = z.object({
  /** 1-2 from canonical 17 (D1). Hard filter axis. */
  roleFunction: z
    .array(z.enum(ROLE_FUNCTION_VOCAB))
    .min(1)
    .max(2),

  /** 1-3 from canonical 42 (D2). Soft score axis. */
  industrySector: z
    .array(z.enum(INDUSTRY_SECTOR_VOCAB))
    .min(1)
    .max(3),

  /** Up to 12 niche tags (D6). Open vocab. */
  relevantTags: z
    .array(z.string().regex(RELEVANT_TAG_PATTERN, "must match [a-z][a-z0-9_]{1,79}"))
    .max(12)
    .default([]),

  /** Per-skill bucketed with proficiency + baseWeight (D7). */
  skills: z.array(enrichedSkillEntry).max(40).default([]),

  /** Single-pick from canonical 13. */
  seniorityLevel: z.enum(CAREER_STAGE_VOCAB),

  /** boolean | null (only set if JD explicitly mentions sponsorship). */
  sponsorshipHint: z.boolean().nullable().default(null),

  /** Up to 6 from canonical 130+ (multi-region postings allowed). */
  locationBuckets: z.array(z.enum(LOCATION_VOCAB)).max(6).default([]),

  /** Single-pick from canonical 10 enum. */
  jobType: z.enum(JOB_TYPE_VOCAB),

  /** Subjective confidence (LLM-graded). */
  confidence: enrichedConfidence,
})
export type EnrichedJobTags = z.infer<typeof enrichedJobTags>

/**
 * Public-API result shape — wraps `EnrichedJobTags` with tier-tracking
 * metadata (mirrors `ParseResumeResult` from pa-resume-parser).
 */
export interface EnrichJobTagsResult {
  tags: EnrichedJobTags
  modelUsed: string
  usedTier: "primary" | "secondary" | "tertiary"
  fallbackChain: string[]
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
}
