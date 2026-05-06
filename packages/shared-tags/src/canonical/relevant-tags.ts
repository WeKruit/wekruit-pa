/**
 * Phase 52 — `relevantTags` open vocab pattern. [TAG-08]
 *
 * Open-vocab sandbox, max 12 per profile (D6).
 * Pattern: `^[a-z][a-z0-9_]{1,79}$` (lowercase, underscore-separated, 2-80 chars).
 * Parse-time extracted by pa-resume-parser v2 (Phase 53).
 * Soft score on match (D9, MATCH-05 weight 0.15).
 *
 * Adam-locked:
 *  - D5: lowercase + underscore only, no abbreviations
 *  - D6: parse-time extract, max 12 cap
 *
 * Niche tags that are too specific to fit `industrySector` / `roleFunction`
 * live here. Examples: `large_language_model_training`, `quantitative_trading`,
 * `developer_tools`, `creator_economy`, `b2b_saas`.
 */

import { z } from "zod"
import { KNOWN_ABBREVIATIONS } from "./validation.js"

export const RELEVANT_TAG_PATTERN = /^[a-z][a-z0-9_]{1,79}$/

export const RELEVANT_TAGS_MAX = 12

export const RelevantTagSchema = z
  .string()
  .regex(RELEVANT_TAG_PATTERN, "must match [a-z][a-z0-9_]{1,79}")
  .refine((v) => !KNOWN_ABBREVIATIONS.has(v), {
    message: "abbreviation rejected — use spelled-out form",
  })

export const RelevantTagsListSchema = z
  .array(RelevantTagSchema)
  .max(RELEVANT_TAGS_MAX, `must not exceed ${RELEVANT_TAGS_MAX} tags`)

/**
 * Validate a single open-vocab `relevantTag`.
 * Returns `{ ok: true }` on success, `{ ok: false, reason }` on failure.
 */
export function validateRelevantTag(s: string): {
  ok: boolean
  reason?: string
} {
  if (s !== s.toLowerCase()) return { ok: false, reason: "must be lowercase" }
  if (/\s/.test(s)) return { ok: false, reason: "must use underscore not space" }
  if (!RELEVANT_TAG_PATTERN.test(s)) {
    return { ok: false, reason: "must match [a-z][a-z0-9_]{1,79}" }
  }
  if (KNOWN_ABBREVIATIONS.has(s)) {
    return {
      ok: false,
      reason: `abbreviation '${s}' rejected — use spelled-out form`,
    }
  }
  return { ok: true }
}

/**
 * Cap helper — return first 12 tags. Used at parse-time when LLM returns
 * a long list to enforce the per-profile budget.
 */
export function capRelevantTags(tags: readonly string[]): string[] {
  return tags.slice(0, RELEVANT_TAGS_MAX)
}
