/**
 * v2.0 External Supply V1 — Wave D — Instantly sync state chip.
 * Mirrors `IdentityStatusBadge`. Pure mapping in `badges.helpers.ts`.
 */
import type { InstantlySyncStatus } from "@pa/core-types"
import { instantlySyncBadge } from "./badges.helpers.js"

export function InstantlySyncStateChip({ status }: { status: InstantlySyncStatus }) {
  const spec = instantlySyncBadge(status)
  return <span className={`status-badge ${spec.tone}`}>{spec.label}</span>
}
