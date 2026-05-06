/**
 * Phase 52 — Bucketed open-vocab `skills`. [TAG-09]
 *
 * 10 buckets enum. Per-skill object with name (no abbreviations), bucket,
 * proficiency, evidenceCount, baseWeight.
 *
 * Adam-locked decisions:
 *  - D7: per-skill `baseWeight` (global static) × JD-relative weight
 *    (Qwen-7B nightly batch) at match time
 *  - D5: skill `name` lowercase, no abbreviations (`python` not `py`,
 *    `kubernetes` not `k8s`)
 *  - Anti-pattern (CLAUDE.md): do NOT truncate skills to top 12 — write
 *    full list to `tags.skills`
 */

import { z } from "zod"
import { KNOWN_ABBREVIATIONS } from "./validation.js"

export const SKILL_BUCKET_VOCAB = [
  "programming_languages",
  "frameworks_and_libraries",
  "databases",
  "cloud_and_infrastructure",
  "devops_and_tooling",
  "data_and_ml",
  "design_and_ux",
  "product_and_business",
  "soft_skills",
  "domain_specific",
] as const

export type SkillBucket = (typeof SKILL_BUCKET_VOCAB)[number]

export const SkillBucketSchema = z.enum(SKILL_BUCKET_VOCAB)

export const SKILL_PROFICIENCY_VOCAB = [
  "beginner",
  "intermediate",
  "advanced",
  "expert",
] as const

export type SkillProficiency = (typeof SKILL_PROFICIENCY_VOCAB)[number]

export const SkillProficiencySchema = z.enum(SKILL_PROFICIENCY_VOCAB)

/**
 * Skill `name` regex: lowercase + underscore + dot + plus + hyphen + digits.
 * Allows `c++`, `c#`, `node.js`, `react-native`, `spring_boot`.
 * Min 2 chars, max 64 chars.
 */
export const SKILL_NAME_PATTERN = /^[a-z][a-z0-9_+#.\-]{1,63}$/

export const SkillNameSchema = z
  .string()
  .regex(
    SKILL_NAME_PATTERN,
    "skill name must be lowercase, 2-64 chars, [a-z0-9_+#.-]",
  )
  .refine((v) => !KNOWN_ABBREVIATIONS.has(v), {
    message: "abbreviation rejected — use spelled-out form",
  })

export const SkillSchema = z.object({
  name: SkillNameSchema,
  bucket: SkillBucketSchema,
  proficiency: SkillProficiencySchema,
  /** Number of distinct evidence references in CV / chat. >= 1. */
  evidenceCount: z.number().int().nonnegative().default(1),
  /**
   * Global static weight in [0, 1]. JD-relative weight is applied
   * separately at match time (Phase 58 Qwen-7B nightly batch).
   * Default 0.5 = "neutral relevance".
   */
  baseWeight: z.number().min(0).max(1).default(0.5),
})

export type Skill = z.infer<typeof SkillSchema>

export const SkillsListSchema = z.array(SkillSchema)

/**
 * Build a default Skill object for a given name+bucket. Useful when LLM
 * extracts only the name and bucket — proficiency/baseWeight default to
 * "intermediate" / 0.5 until reinforcement.
 */
export function makeSkill(
  name: string,
  bucket: SkillBucket,
  overrides: Partial<Skill> = {},
): Skill {
  return SkillSchema.parse({
    name,
    bucket,
    proficiency: "intermediate",
    evidenceCount: 1,
    baseWeight: 0.5,
    ...overrides,
  })
}
