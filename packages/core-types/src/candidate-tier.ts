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
}

/**
 * Suggest a tier for a PRESCREEN rejection from existing signals. Returns null
 * for non-rejection terminals (PASS / PAUSE / null) — nothing to tier.
 *
 * Thresholds (advisory): overall fit drives it because the global tier is about
 * "how strong is this person", independent of this role's must-haves.
 *  - HARD_STOP → tier_3 (explicit hard mismatch) unless fit is genuinely high.
 *  - FAIL: fit ≥ 0.50 → tier_1 · 0.30–0.50 → tier_2 · < 0.30 → tier_3.
 *  - An "uncertain" checklist verdict softens a tier_3 to tier_2 (not a hard no).
 */
export function suggestTierFromPrescreen(signal: PrescreenTierSignal): CandidateTier | null {
  const { terminal } = signal
  if (terminal === "PASS" || terminal === "PAUSE" || terminal == null) return null
  const fit = typeof signal.weightedFitScore === "number" ? signal.weightedFitScore : null

  let tier: CandidateTier
  if (terminal === "HARD_STOP") {
    tier = fit != null && fit >= 0.6 ? "tier_2" : "tier_3"
  } else if (fit != null) {
    tier = fit >= 0.5 ? "tier_1" : fit >= 0.3 ? "tier_2" : "tier_3"
  } else {
    // No fit score — fall back to the checklist verdict (uncertain ≠ hard no).
    tier = signal.checklistVerdict === "uncertain" ? "tier_2" : "tier_3"
  }

  if (tier === "tier_3" && signal.checklistVerdict === "uncertain") tier = "tier_2"
  return tier
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
