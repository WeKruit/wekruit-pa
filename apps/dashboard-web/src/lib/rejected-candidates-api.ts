/**
 * Dashboard wrappers for the Rejected-candidates-by-tier callables
 * (apps/functions/src/admin-rejected-candidates.ts + admin-candidate-tier-actions.ts).
 */
import { httpsCallable } from "firebase/functions"
import { functions } from "./firebase.js"

export const REJECTED_CANDIDATES_ROUTE = "/admin/rejected-candidates"

export type CandidateTier = "tier_1" | "tier_2" | "tier_3"

export const TIER_LABELS: Record<CandidateTier, string> = {
  tier_1: "Tier 1",
  tier_2: "Tier 2",
  tier_3: "Tier 3",
}
export const TIER_BLURB: Record<CandidateTier, string> = {
  tier_1: "Strong — re-review for new roles",
  tier_2: "Reusable — missing a requirement",
  tier_3: "Hard mismatch — do not re-surface",
}

export interface RejectedCandidateRow {
  candidateId: string
  displayName?: string
  tier: CandidateTier
  source: "prescreen" | "recruiter"
  reusable: boolean
  rejectionCount: number
  updatedAt: string
  lastJobId?: string
  lastReason?: string
  humanConfirmed: boolean
}

export interface RejectedCandidatesSnapshot {
  rows: RejectedCandidateRow[]
  counts: { tier_1: number; tier_2: number; tier_3: number; reusable: number; total: number }
  truncated: boolean
}

export interface RejectedCandidatesFilters {
  tier?: CandidateTier
  reusableOnly?: boolean
  includeTest?: boolean
  limit?: number
}

export async function getRejectedCandidates(filters: RejectedCandidatesFilters): Promise<RejectedCandidatesSnapshot> {
  const fn = httpsCallable<RejectedCandidatesFilters, RejectedCandidatesSnapshot>(
    functions(),
    "paAdminRejectedCandidatesSnapshot",
  )
  const result = await fn(filters)
  return result.data
}

export interface ReevaluateResult {
  candidateId: string
  currentGlobalTier: CandidateTier | null
  suggestedTier: CandidateTier | null
  eventsConsidered: number
  basis: Array<{ tier: CandidateTier; aiSuggestedTier?: CandidateTier; jobId?: string; source?: string; createdAt?: string }>
  applied: boolean
  appliedTier?: CandidateTier
}

export async function reevaluateCandidateTier(input: {
  candidateId: string
  apply?: boolean
  tier?: CandidateTier
}): Promise<ReevaluateResult> {
  const fn = httpsCallable<typeof input, ReevaluateResult>(functions(), "paAdminReevaluateCandidateTier")
  const result = await fn(input)
  return result.data
}
