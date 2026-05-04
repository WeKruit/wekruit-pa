/**
 * iter30 WS2 P2 — Canonical-tag confidence formula.
 *
 * Spec: ws-2-7-detail.md §4.2
 *   confidence = 0.4 * minMaxNorm(observationCount, 1, 50)
 *              + 0.4 * approvalSignal
 *              + 0.2 * sourceCountFactor
 *
 * Used at canonical-tag creation time and on each evidence add.
 */

import type { ApprovalStatus } from "@wekruit/shared-tags"

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * Compute confidence for a canonical tag at write time.
 *
 * @param observationCount - Total evidence entries (capped at 10 on the doc
 *   but logically can be higher from the worker's running count)
 * @param approvalStatus - Current approval state
 * @param sourcesSet - Distinct source pipeline labels seen for this canonical
 */
export function computeConfidence(
  observationCount: number,
  approvalStatus: ApprovalStatus,
  sourcesSet: Set<string> | string[],
): number {
  // 0..1 observation density: saturates at 50 observations
  const obs = clamp(observationCount / 50, 0, 1)

  // Approval signal per spec
  const apr =
    approvalStatus === "human-approved"
      ? 1
      : approvalStatus === "auto-approved"
        ? 0.7
        : approvalStatus === "proposed"
          ? 0.4
          : 0 // "rejected"

  // Source diversity: 5 distinct sources → factor = 1.0
  const srcCount =
    sourcesSet instanceof Set ? sourcesSet.size : new Set(sourcesSet).size
  const srcFactor = clamp(srcCount / 5, 0, 1)

  return 0.4 * obs + 0.4 * apr + 0.2 * srcFactor
}

/** Compute per-entity-tag confidence from a worker confidence value. */
export function computeEntityTagConfidence(workerConfidence: number | null): number {
  return clamp(workerConfidence ?? 0.5, 0, 1)
}
