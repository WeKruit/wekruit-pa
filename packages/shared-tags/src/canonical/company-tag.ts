/**
 * Phase A2 (post-v1.7) — Canonical `companyTag` vocab.
 *
 * Open vocab with seed list. Add-able via D16 sandbox→promote overlay
 * (Firestore `pa-canonical-tags` collection, vocab key `company-tag`).
 *
 * Used by:
 *  - `pa-companies/{id}.companyTags: CompanyTag[]` (job-side)
 *  - `pa-users/{uid}.tags.targetCompanyTags: CompanyTag[]` (user-side soft pref)
 *
 * Match semantics: soft score (Jaccard overlap × 0.15 weight; see V16 B4).
 */

import { z } from "zod"

/**
 * Seed list — admin can promote new tokens at runtime via the overlay
 * collection. Keep this list short and meaningful; growth happens through
 * proposed→promoted, not by edits here.
 */
export const COMPANY_TAG_VOCAB = [
  "big_tech",
  "mag_7",
  "yc_active",
  "yc_alumni",
  "unicorn",
  "ai_native",
  "fintech_unicorn",
  "crypto_web3",
  "retail_ops",
  "gov_contract",
  "agency_consulting",
] as const

export type CompanyTag = (typeof COMPANY_TAG_VOCAB)[number] | string

/**
 * Token pattern for open-vocab additions (matches `relevant-tags` style):
 * lowercase, 2..64 chars, underscores allowed, must start with a letter.
 */
export const COMPANY_TAG_PATTERN = /^[a-z][a-z0-9_]{1,63}$/

/**
 * Zod schema accepts any pattern-conforming token (open vocab). Seed-list
 * membership is informational only at validation time. Closed-enum
 * validation happens at write time against the resolved overlay vocab.
 */
export const CompanyTagSchema = z
  .string()
  .regex(COMPANY_TAG_PATTERN, "companyTag must be lowercase snake_case, start with a letter")
  .min(2)
  .max(64)

export const CompanyTagListSchema = z.array(CompanyTagSchema)
