/**
 * Canonical candidate TIER model — shared by the prescreen rejection flow, the
 * recruiter-submission rejection flow, and the admin "Rejected candidates"
 * browse view. ONE vocabulary so a candidate rejected for role A can be
 * re-surfaced for new roles by tier.
 *
 * Adam-locked (2026-06-16):
 *  - Polarity: `tier_1` is the STRONGEST (strong candidate, wrong role — worth
 *    re-reviewing for new roles); `tier_3` is a hard no. (Matches the existing
 *    recruiter `reusableForCandidateTier` = tier !== "tier_3".)
 *  - The candidate's GLOBAL tier is BEST-WINS across all their rejections: any
 *    single tier_1 rejection makes them globally tier_1. Per-role rejections
 *    keep their own tier on the rejection record.
 *  - AI SUGGESTS a tier (operator confirms/overrides); these mappers produce
 *    that advisory suggestion from existing AI verdicts. Human owns the final.
 */
import { z } from "zod"

export const CANDIDATE_TIERS = ["tier_1", "tier_2", "tier_3"] as const
export const CandidateTierSchema = z.enum(CANDIDATE_TIERS)
export type CandidateTier = (typeof CANDIDATE_TIERS)[number]

export const CANDIDATE_TIER_SOURCES = ["prescreen", "recruiter"] as const
export const CandidateTierSourceSchema = z.enum(CANDIDATE_TIER_SOURCES)
export type CandidateTierSource = (typeof CANDIDATE_TIER_SOURCES)[number]

/** Human-facing tier labels. tier_1 best → tier_3 hard no. */
export const CANDIDATE_TIER_LABELS: Record<CandidateTier, string> = {
  tier_1: "Tier 1 · strong, re-review for new roles",
  tier_2: "Tier 2 · reusable, missing a requirement",
  tier_3: "Tier 3 · hard mismatch, do not re-surface",
}

/** Rank for best-wins comparison — higher is better (tier_1 = 3). */
export function tierRank(tier: CandidateTier): number {
  return tier === "tier_1" ? 3 : tier === "tier_2" ? 2 : 1
}

/** The better (more reusable) of two tiers. */
export function bestTier(a: CandidateTier, b: CandidateTier): CandidateTier {
  return tierRank(a) >= tierRank(b) ? a : b
}

/** Reconcile a new rejection's tier into the candidate's global tier (best-wins). */
export function reconcileGlobalTier(
  current: CandidateTier | undefined | null,
  incoming: CandidateTier,
): CandidateTier {
  return current ? bestTier(current, incoming) : incoming
}

/** tier_1 / tier_2 are reusable for other roles; tier_3 is a hard no. */
export function isReusableTier(tier: CandidateTier): boolean {
  return tier !== "tier_3"
}

// ---------------------------------------------------------------------------
// AI verdict → suggested tier (advisory; operator confirms/overrides)
// ---------------------------------------------------------------------------

/** Recruiter `aiEvaluation.verdict` values (recruiter-submission-eval.ts). */
export type RecruiterAiVerdict = "advance" | "borderline" | "reject"

/**
 * Suggest a tier for a RECRUITER rejection from the AI verdict + hard-gap count.
 *  - advance / borderline → tier_1 (the AI thought they were close → re-review)
 *  - reject with 0 hard gaps → tier_2 (soft miss, still reusable)
 *  - reject with hard gaps   → tier_3 (clear must-have mismatch)
 */
export function suggestTierFromRecruiterAi(
  verdict: RecruiterAiVerdict | undefined | null,
  hardGaps: number,
): CandidateTier {
  if (verdict === "advance" || verdict === "borderline") return "tier_1"
  return hardGaps > 0 ? "tier_3" : "tier_2"
}

/** Prescreen terminal + the checklist eval verdict feed the prescreen suggestion. */
export type PrescreenTerminalLike = "PASS" | "FAIL" | "HARD_STOP" | "PAUSE" | null
export type ChecklistVerdict = "pass" | "reject" | "uncertain" | undefined | null

export interface PrescreenTierSignal {
  terminal: PrescreenTerminalLike
  /** Overall AI fit (pa-evaluation-attempts.weightedFitScore), 0..1. */
  weightedFitScore?: number | null
  checklistVerdict?: ChecklistVerdict
  /** Count of failed MUST-HAVE checklist items, if known. */
  hardGaps?: number | null
  /** Strong school OR strong company (role-aware). Drives tier_2 for non-top-5%. */
  strongBackground?: boolean
}

/**
 * Adam-locked tiering (2026-06-17): tier_1 is RARE — only the top ~5% by
 * prescreen fit (a near-pass FAIL). Everyone else is tier_2 ONLY if they have a
 * strong school or company (reusable for other roles); otherwise tier_3.
 *
 *  - PASS / PAUSE / null → null (not a rejection).
 *  - FAIL with fit ≥ {@link PRESCREEN_TIER_1_FIT_CUTOFF} → tier_1 (near-pass).
 *  - HARD_STOP → never tier_1 (explicit hard mismatch).
 *  - else: strongBackground → tier_2, otherwise tier_3.
 *
 * `weightedFitScore` is the 0–1 fit RATIO (score/scoreMax). A real population
 * percentile is computed at backfill time; this fixed cutoff approximates the
 * top-5% for the live per-candidate path.
 */
export const PRESCREEN_TIER_1_FIT_CUTOFF = 0.9

export function suggestTierFromPrescreen(signal: PrescreenTierSignal): CandidateTier | null {
  const { terminal } = signal
  if (terminal === "PASS" || terminal === "PAUSE" || terminal == null) return null
  const fit = typeof signal.weightedFitScore === "number" ? signal.weightedFitScore : null

  // tier_1 ONLY for a near-pass FAIL (top ~5%). HARD_STOP can never be tier_1.
  if (terminal === "FAIL" && fit != null && fit >= PRESCREEN_TIER_1_FIT_CUTOFF) return "tier_1"
  // Not top-5%: reusable for other roles only with a strong school/company.
  if (signal.strongBackground) return "tier_2"
  return "tier_3"
}

// ---------------------------------------------------------------------------
// Global tier record stamped on pa-users (durable, role-independent)
// ---------------------------------------------------------------------------

export const GlobalCandidateTierSchema = z.object({
  /** Best-wins tier across all of this candidate's rejections. */
  tier: CandidateTierSchema,
  /** Which flow produced the current (best) tier. */
  source: CandidateTierSourceSchema,
  /** tier_1 / tier_2 → true. Cached for cheap browse filtering. */
  reusable: z.boolean(),
  /** ISO timestamp of the last tier update. */
  updatedAt: z.string().min(1),
  /** How many rejection events have contributed to this candidate's tier. */
  rejectionCount: z.number().int().nonnegative().default(1),
  /** The job tied to the most recent rejection (advisory context). */
  lastJobId: z.string().max(200).optional(),
  /** Short human reason for the most recent rejection (advisory). */
  lastReason: z.string().max(500).optional(),
  /** True once a human has confirmed/overridden (vs AI-only suggestion). */
  humanConfirmed: z.boolean().optional(),
})
export type GlobalCandidateTier = z.infer<typeof GlobalCandidateTierSchema>
