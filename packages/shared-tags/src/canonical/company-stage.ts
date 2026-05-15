/**
 * Phase A2 (post-v1.7) — Canonical `companyStage` vocab.
 *
 * Adam-locked: 11 enum, closed. Informational only — NOT in match score
 * formula (GOAL-company-tier-yc-match.md "DECIDED CONSTRAINTS" — stage
 * weight 0, `companyStageStrict` flag removed).
 *
 * Multi-pick not allowed — each `pa-companies/{id}.companyStage` is a single
 * value. `unknown` is the default for un-enriched docs.
 */

import { z } from "zod"

export const COMPANY_STAGE_VOCAB = [
  "pre_seed",
  "seed",
  "series_a",
  "series_b",
  "series_c",
  "series_d_plus",
  "ipo_public",
  "private_mature",
  "bootstrapped",
  "non_profit",
  "unknown",
] as const

export type CompanyStage = (typeof COMPANY_STAGE_VOCAB)[number]

export const CompanyStageSchema = z.enum(COMPANY_STAGE_VOCAB)
