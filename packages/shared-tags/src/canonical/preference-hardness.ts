/**
 * SOFT-vs-HARD preference model — canonical hardness vocabulary.
 *
 * Adam directive (2026-05-28): candidate preferences "can be soft but need to
 * take effect, and soft as in buffer... we need to ask if user is soft or hard...
 * same for industry/company stage."
 *
 * Spec: `.planning/INITIATIVE-soft-hard-preferences.md` §2.2 (build verbatim).
 *
 * This module defines ONE canonical shape — `preferenceHardness` — that lives
 * on `pa-users/{userId}.tags` alongside the existing canonical axes. It does
 * NOT create a parallel taxonomy: each entry annotates an EXISTING matching
 * axis (salary, industrySector, companyStage, companySize, location, jobType,
 * careerStage, roleFunction) with a hard/soft strength + buffer band. The
 * matcher reads it via `resolveHardness()`; when an axis is unset the reader
 * falls back to `DEFAULT_HARDNESS` (which encodes current behaviour), so a
 * `pa-users.tags` doc carrying ZERO hardness data changes nothing about
 * ranking — full backward compatibility.
 *
 * Strength semantics:
 *   - `hard`: dealbreaker. Matcher drops jobs that violate the constraint
 *     (existing hard-filter behaviour).
 *   - `soft`: preference / buffer. Matcher does NOT drop; it applies a score
 *     penalty within a buffer band so soft-miss jobs still surface, ranked
 *     lower.
 *
 * Buffer fields:
 *   - `bufferPct`: continuous-axis tolerance (salary). 0.10 = accept down to
 *     90% of the floor before the score starts decaying hard.
 *   - `bufferSteps`: ordinal-axis tolerance (companyStage / companySize /
 *     careerStage). 1 = one adjacent enum position is "close enough".
 *
 * @module canonical/preference-hardness
 */

import { z } from "zod"

/**
 * The closed set of matching axes that can carry a hardness annotation.
 * Mirrors the axes named in the spec §2.2. `roleFunction` is included so the
 * key is reserved, but it stays auto-hard (query-layer gate) with no runtime
 * toggle — see `DEFAULT_HARDNESS` + the matcher's `resolveHardness` contract.
 */
export const HARDNESS_AXIS_VOCAB = [
  "salary",
  "industrySector",
  "companyStage",
  "companySize",
  "location",
  "jobType",
  "careerStage",
  "roleFunction",
] as const

export type HardnessAxis = (typeof HARDNESS_AXIS_VOCAB)[number]

/** Hardness strength enum — `hard` (dealbreaker) | `soft` (buffer). */
export const HardnessSchema = z.enum(["hard", "soft"])
export type Hardness = z.infer<typeof HardnessSchema>

/**
 * One per-axis hardness annotation. All buffer/source fields optional so the
 * minimal write is just `{ hardness: "soft" }`. `bufferPct` applies to
 * continuous axes (salary); `bufferSteps` to ordinal axes
 * (companyStage/companySize/careerStage). Provenance fields (`source`,
 * `confidence`, `evidence`, `updatedAt`) make every hardness signal auditable
 * — mirrors the v2.0 tag-with-evidence requirement.
 */
export const PreferenceHardnessEntrySchema = z.object({
  hardness: HardnessSchema,
  bufferPct: z.number().min(0).max(1).optional(),
  bufferSteps: z.number().int().min(0).max(4).optional(),
  source: z.enum(["onboarding", "conversation", "website", "admin", "default_inferred"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.string().max(280).optional(),
  updatedAt: z.string().optional(),
})
export type PreferenceHardnessEntry = z.infer<typeof PreferenceHardnessEntrySchema>

/**
 * The `preferenceHardness` blob: an optional per-axis entry for each axis in
 * `HARDNESS_AXIS_VOCAB`. Absent axis → reader falls back to `DEFAULT_HARDNESS`.
 */
export const PreferenceHardnessSchema = z.object(
  Object.fromEntries(
    HARDNESS_AXIS_VOCAB.map((a) => [a, PreferenceHardnessEntrySchema.optional()]),
  ) as Record<HardnessAxis, z.ZodOptional<typeof PreferenceHardnessEntrySchema>>,
)
export type PreferenceHardness = z.infer<typeof PreferenceHardnessSchema>

/**
 * §2.4 — the reader's fallback when an axis is unset (= backward compat).
 * Deploying the schema with ZERO hardness data must change NOTHING about
 * ranking, so these defaults encode the CURRENT matcher behaviour:
 *
 *   - salary         → soft (buffer 10%)  — V16 salaryFit already degrades, never hard-drops.
 *   - industrySector → soft               — V16 industry is a soft overlap score (weight 0.10).
 *   - companyStage   → soft (steps 1)     — V16 ignores stage today; the soft default keeps the
 *                                           NEW companyStage component a no-op for flag-OFF and a
 *                                           gentle additive boost for flag-ON-without-data.
 *   - companySize    → soft (steps 1)     — see matcher §3.3.
 *   - location       → HARD                — V16 location intersect is a hard gate today.
 *   - jobType        → HARD                — V16 jobType exact-match is a hard gate today.
 *   - careerStage    → HARD (window; steps extend the window) — V16 seniority window is hard today.
 *   - roleFunction   → HARD                — query-layer array-contains-any gate; no toggle.
 *
 * The buffer values here are the spec-locked defaults:
 *   - salary bufferPct = 0.10
 *   - ordinal axes bufferSteps = 1
 */
export const DEFAULT_HARDNESS: Record<HardnessAxis, PreferenceHardnessEntry> = {
  salary: { hardness: "soft", bufferPct: 0.1 },
  industrySector: { hardness: "soft" },
  companyStage: { hardness: "soft", bufferSteps: 1 },
  companySize: { hardness: "soft", bufferSteps: 1 },
  location: { hardness: "hard" },
  jobType: { hardness: "hard" },
  careerStage: { hardness: "hard", bufferSteps: 1 },
  roleFunction: { hardness: "hard" },
}

/** Spec-locked default salary buffer (accept down to 90% of minSalary). */
export const DEFAULT_SALARY_BUFFER_PCT = 0.1
/** Spec-locked default ordinal-axis buffer (one adjacent enum position). */
export const DEFAULT_ORDINAL_BUFFER_STEPS = 1
