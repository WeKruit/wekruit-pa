/**
 * Typed dashboard wrappers for the `paAdminPrescreenOpsSnapshot` admin
 * callable (apps/functions/src/admin-prescreen-ops.ts). Wire types live in
 * `@pa/core-types` (prescreen-ops-types.ts) so client and CF stay in sync.
 *
 * Sessions-mode gotcha: except for `sort:"score_desc"`, `queue:"committed"`,
 * `bucket`, and the default test-session exclusion are applied in-memory
 * inside each server page, so a page can legitimately return fewer than
 * `limit` rows (even 0) while still having a `nextCursor`.
 * `collectPrescreenSessions` walks pages until it has `target` rows or the
 * cursor runs out.
 */
import { httpsCallable } from "firebase/functions"
import type {
  PrescreenOpsQueueFilter,
  PrescreenOpsSessionCursor,
  PrescreenOpsSessionRow,
  PrescreenOpsSnapshotInput,
  PrescreenOpsSnapshotOpsResponse,
  PrescreenOpsSnapshotSessionsResponse,
  StrictReviewSort,
} from "@pa/core-types"
import { functions } from "./firebase.js"

export const PRESCREEN_OPS_ROUTE = "/admin/prescreen-ops"
export const PRESCREEN_OPS_SNAPSHOT_CALLABLE = "paAdminPrescreenOpsSnapshot"

export type PrescreenOpsSessionsPageInput = {
  jobId?: string
  /** Restrict to these candidate userIds (Algolia name → pa_candidates objectIDs). */
  userIds?: string[]
  queue?: PrescreenOpsQueueFilter
  bucket?: string
  includeTest?: boolean
  sort?: StrictReviewSort
  limit?: number
  cursor?: PrescreenOpsSessionCursor
}

export async function getPrescreenOpsSnapshot(
  includeTest = false,
): Promise<PrescreenOpsSnapshotOpsResponse> {
  const fn = httpsCallable<PrescreenOpsSnapshotInput, PrescreenOpsSnapshotOpsResponse>(
    functions(),
    PRESCREEN_OPS_SNAPSHOT_CALLABLE,
  )
  const result = await fn({ mode: "ops", includeTest })
  return result.data
}

export async function listPrescreenSessionsPage(
  input: PrescreenOpsSessionsPageInput,
): Promise<PrescreenOpsSnapshotSessionsResponse> {
  const fn = httpsCallable<PrescreenOpsSnapshotInput, PrescreenOpsSnapshotSessionsResponse>(
    functions(),
    PRESCREEN_OPS_SNAPSHOT_CALLABLE,
  )
  const result = await fn({ mode: "sessions", ...input })
  return result.data
}

export async function collectPrescreenSessions(
  input: Omit<PrescreenOpsSessionsPageInput, "cursor">,
  target: number,
  maxPages = 10,
): Promise<PrescreenOpsSessionRow[]> {
  const rows: PrescreenOpsSessionRow[] = []
  let cursor: PrescreenOpsSessionCursor | undefined
  for (let page = 0; page < maxPages; page += 1) {
    const result = await listPrescreenSessionsPage({ ...input, ...(cursor ? { cursor } : {}) })
    rows.push(...result.rows)
    if (rows.length >= target || !result.nextCursor) break
    cursor = result.nextCursor
  }
  return rows.slice(0, target)
}
