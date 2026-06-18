/**
 * Firebase callable wrapper for `paAdminOpsMetrics`
 * (apps/functions/src/admin-ops-metrics.ts). The CF returns a DAILY series;
 * the page rolls it up client-side via `rollup` (re-exported from the
 * firebase-free `operations-overview-rollup` module so the rollup logic stays
 * unit-testable under node).
 */
import { httpsCallable } from "firebase/functions"
import { functions } from "./firebase.js"
import type { AdminOpsMetricsInput, AdminOpsMetricsResult } from "./operations-overview-rollup.js"

export * from "./operations-overview-rollup.js"

export const OPS_METRICS_CALLABLE = "paAdminOpsMetrics"
export const OPERATIONS_OVERVIEW_ROUTE = "/admin/operations"

const CLIENT_CACHE_TTL_MS = 5 * 60_000

/** Loads the ops metrics. Client-side sessionStorage cache (5-min TTL) so
 *  re-opening the page is instant; the callable also caches server-side. */
export async function getOpsMetrics(input: AdminOpsMetricsInput): Promise<AdminOpsMetricsResult> {
  const cacheKey = `ops-metrics:r${input.rangeDays ?? 90}:t${input.includeTest ? 1 : 0}`
  try {
    const raw = sessionStorage.getItem(cacheKey)
    if (raw) {
      const cached = JSON.parse(raw) as { at?: number; data?: AdminOpsMetricsResult }
      if (cached.data && typeof cached.at === "number" && Date.now() - cached.at < CLIENT_CACHE_TTL_MS) {
        return cached.data
      }
    }
  } catch {
    /* ignore cache read errors */
  }
  const fn = httpsCallable<AdminOpsMetricsInput, AdminOpsMetricsResult>(functions(), OPS_METRICS_CALLABLE)
  const result = await fn(input)
  try {
    sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data: result.data }))
  } catch {
    /* ignore quota errors */
  }
  return result.data
}
