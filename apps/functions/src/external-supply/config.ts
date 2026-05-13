/**
 * v2.0 External Supply V1 — Wave C Block F2 — `getExternalSupplyConfig`
 * admin callable.
 *
 * Returns the runtime feature flags the dashboard needs to decide which
 * controls to render. Per EXECUTOR-PLANS.md F Q5 + G Q3:
 *   - `liveOutreachEnabled`: true iff
 *     `process.env.EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED === "true"`.
 *   - `instantlyConfigured`: true iff `process.env.INSTANTLY_API_KEY` is set
 *     (non-empty).
 *
 * The dashboard hides the live-sync button until both are true. The sync
 * callable (`instantly-sync.ts`) ALSO re-checks both at request entry and
 * downgrades to `dry_run` if either is false — so this callable is purely
 * cosmetic, never load-bearing for safety.
 */

import { onCall } from "firebase-functions/v2/https"
import { requireExternalSupplyAdmin } from "./resolve-identity.js"

export interface ExternalSupplyConfigResult {
  liveOutreachEnabled: boolean
  instantlyConfigured: boolean
}

export interface GetExternalSupplyConfigDeps {
  readEnv?: (key: string) => string | undefined
}

type CallableAuth = Parameters<typeof requireExternalSupplyAdmin>[0]

export function runGetExternalSupplyConfig(
  _data: unknown,
  auth: CallableAuth,
  deps: GetExternalSupplyConfigDeps = {},
): ExternalSupplyConfigResult {
  requireExternalSupplyAdmin(auth)
  const readEnv = deps.readEnv ?? ((key: string) => process.env[key])
  const liveOutreachEnabled = readEnv("EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED") === "true"
  const apiKey = readEnv("INSTANTLY_API_KEY")
  const instantlyConfigured = typeof apiKey === "string" && apiKey.trim().length > 0
  return { liveOutreachEnabled, instantlyConfigured }
}

export const paExternalSupplyGetConfig = onCall(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 30,
  },
  async (req): Promise<ExternalSupplyConfigResult> => {
    return runGetExternalSupplyConfig(req.data, req.auth, {})
  },
)
