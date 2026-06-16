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

export async function getOpsMetrics(input: AdminOpsMetricsInput): Promise<AdminOpsMetricsResult> {
  const fn = httpsCallable<AdminOpsMetricsInput, AdminOpsMetricsResult>(functions(), OPS_METRICS_CALLABLE)
  const result = await fn(input)
  return result.data
}
