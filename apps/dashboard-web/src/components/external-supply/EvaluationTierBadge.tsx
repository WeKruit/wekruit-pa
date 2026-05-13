/**
 * v2.0 External Supply V1 — Wave D — EvaluationTier pill.
 * Pure mapping lives in `badges.helpers.ts` so it can be unit-tested.
 */
import type { EvaluationTier } from "@pa/core-types"
import { evaluationTierBadge } from "./badges.helpers.js"

export function EvaluationTierBadge({ tier }: { tier: EvaluationTier }) {
  const spec = evaluationTierBadge(tier)
  return <span className={`status-badge ${spec.tone}`}>{spec.label}</span>
}
