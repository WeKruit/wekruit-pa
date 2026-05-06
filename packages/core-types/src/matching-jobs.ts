/**
 * v1.6 Phase 55 (MATCH-02) — matching-jobs schema extension.
 *
 * Adds `roleFunction[]` (Phase 52 closed enum, hard-filter axis) and
 * `industrySector[]` (Phase 52 closed enum, soft-score axis) to the
 * matching-jobs Firestore document shape. Backfill is performed by
 * `apps/functions/scripts/migrate-matching-jobs-schema.mjs`.
 *
 * Two orthogonal axes (CLAUDE.md v1.6 design lock):
 *  - `roleFunction`: WHAT the role does — hard-filter via
 *    array-contains-any in queryMatchingJobs (Phase 56).
 *  - `industrySector`: WHAT KIND of company — soft-score overlap.
 *
 * The full matching-jobs document also retains legacy fields
 * (`category`, `industry`, `industryKey`, `industryEnum`) until Phase
 * 56's queryMatchingJobs cuts over to read from `roleFunction[]`. The
 * partial schema here intentionally captures only the v1.6 additions
 * + their migration audit timestamps so consumers can validate the
 * delta independently of the full doc shape.
 */

import { z } from "zod"
import { RoleFunctionSchema, IndustrySectorSchema } from "@wekruit/shared-tags"

/**
 * Schema for the v1.6 fields added to matching-jobs by Phase 55.
 *
 * `roleFunctionMigratedAt` / `industrySectorMigratedAt` are ISO
 * timestamps recorded by the migration script when it writes the new
 * fields — used as the idempotency guard so re-runs skip already-
 * migrated docs whose computed mapping is unchanged.
 */
export const MatchingJobV16PartialSchema = z.object({
  /** Phase 52 D1 — multi-pick role function (hard-filter axis on match). */
  roleFunction: z.array(RoleFunctionSchema).default([]),
  /** Phase 52 D2 — multi-pick industry sector (soft-score axis on match). */
  industrySector: z.array(IndustrySectorSchema).default([]),
  /** ISO timestamp set by Phase 55 migration when roleFunction was written. */
  roleFunctionMigratedAt: z.string().nullable().optional(),
  /** ISO timestamp set by Phase 55 migration when industrySector was written. */
  industrySectorMigratedAt: z.string().nullable().optional(),
})
export type MatchingJobV16Partial = z.infer<typeof MatchingJobV16PartialSchema>
