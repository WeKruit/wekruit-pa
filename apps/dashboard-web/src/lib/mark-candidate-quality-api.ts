/**
 * Client for `paAdminMarkCandidateQuality` (apps/functions/src/admin-mark-candidate-quality.ts).
 *
 * Marks a candidate's DURABLE, role-independent quality tier from the submission drawer without
 * rejecting them — "strong, wrong role, find them later". Writes the same
 * `pa-users.globalCandidateTier` the rejection flows write, so the marked candidate shows up in the
 * existing tier browse at /admin/rejected-candidates rather than in a second parallel list.
 */
import { httpsCallable } from "firebase/functions"
import { functions } from "./firebase.js"
import type { CandidateTier } from "@pa/core-types"

export type MarkQualityResponse =
  | { ok: true; candidateId: string; globalTier: CandidateTier; globalChanged: boolean }
  | { ok: false; reason: string }

export async function markCandidateQuality(args: {
  submissionId: string
  tier: CandidateTier
  reason?: string
}): Promise<MarkQualityResponse> {
  const fn = httpsCallable<
    { submissionId: string; tier: CandidateTier; reason: string | null },
    MarkQualityResponse
  >(functions(), "paAdminMarkCandidateQuality")
  const res = await fn({ submissionId: args.submissionId, tier: args.tier, reason: args.reason ?? null })
  return res.data
}
