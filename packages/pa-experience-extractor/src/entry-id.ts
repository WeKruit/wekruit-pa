/**
 * Phase EX1 PR-A — content-stable hash for work-entry idempotency.
 *
 * The same (uid, index, title, startDate) tuple always produces the
 * same hash. Rerunning extraction on unchanged data hits the cache;
 * editing a title or startDate produces a NEW hash and naturally
 * orphans the old cache entry (a cleanup script may sweep these later).
 *
 * Lives in its own module to avoid pulling node:crypto into modules
 * that only care about types.
 */

import { createHash } from "node:crypto"

export function computeEntryId(args: {
  uid: string
  index: number
  title: string
  startDate: string | null
}): string {
  const h = createHash("sha256")
  h.update(args.uid)
  h.update("\x00")
  h.update(String(args.index))
  h.update("\x00")
  h.update(args.title.trim().toLowerCase())
  h.update("\x00")
  h.update(args.startDate ?? "")
  return h.digest("hex").slice(0, 32)
}
