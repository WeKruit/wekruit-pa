/**
 * v2.0 External Supply V1 — Wave D — IdentityResolutionStatus pill.
 * Maps every IdentityResolutionStatus to a color + label via the pure helper
 * in `badges.helpers.ts` (testable without mounting React).
 */
import type { IdentityResolutionStatus } from "@pa/core-types"
import { identityStatusBadge } from "./badges.helpers.js"

export function IdentityStatusBadge({ status }: { status: IdentityResolutionStatus }) {
  const spec = identityStatusBadge(status)
  return <span className={`status-badge ${spec.tone}`}>{spec.label}</span>
}
