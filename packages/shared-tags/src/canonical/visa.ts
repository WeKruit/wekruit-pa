/**
 * Phase 52 — Canonical `visa` vocab. [TAG-04]
 *
 * Exactly 4 enum values. Hard filter axis on match (MATCH-04).
 *
 * Adam-locked decisions:
 *  - D4: exactly 4 enum values, do NOT split OPT/CPT/H1B
 *    — all collapse to `sponsor_needed`
 *  - D5: spelled-out (no `pr` for permanent resident etc)
 *
 * Match semantics:
 *  - User `visaStatus = 'sponsor_needed'` → drop jobs with `sponsorship: false`
 *  - User `visaStatus = 'citizen'` or `'permanent_resident'` → match all
 *  - User `visaStatus = 'other'` → match all (with low-confidence fallback)
 */

import { z } from "zod"

export const VISA_VOCAB = [
  "citizen",
  "permanent_resident",
  "sponsor_needed",
  "other",
] as const

export type Visa = (typeof VISA_VOCAB)[number]

export const VisaSchema = z.enum(VISA_VOCAB)
