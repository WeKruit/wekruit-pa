/**
 * Canonical `companySize` vocab (2026-05-30).
 *
 * Promoted to `@wekruit/shared-tags` so the LLM-driven onboarding/conversation
 * extractor maps free-form company-size answers to a SHARED closed enum (no
 * regex classification, no per-module vocab duplication). Previously this
 * vocab lived only inline in `pa-orchestrator`'s `user-tags-merger.ts`.
 *
 * MULTI-PICK allowed (OR): a candidate may want "an early-stage startup OR big
 * tech" → `["early_startup", "enterprise"]`. The matcher reads the user's
 * preference; `open` is the explicit no-preference token.
 *
 * Spelled-out, no abbreviations (D5). Closed enum.
 */

import { z } from "zod"

export const COMPANY_SIZE_VOCAB = [
  "seed",
  "early_startup",
  "scale_up",
  "mid_market",
  "enterprise",
  "open",
] as const

export type CompanySize = (typeof COMPANY_SIZE_VOCAB)[number]

export const CompanySizeSchema = z.enum(COMPANY_SIZE_VOCAB)
