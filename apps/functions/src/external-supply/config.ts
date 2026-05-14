/**
 * v2.0 External Supply V1 — Wave C Block F2 — `getExternalSupplyConfig`
 * admin callable.
 *
 * Returns the runtime feature flags the dashboard needs to decide which
 * controls to render:
 *   - `liveOutreachEnabled`: true iff
 *     `process.env.EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED === "true"`.
 *   - `instantlyConfigured`: true iff `process.env.INSTANTLY_API_KEY` is set.
 *   - `mailgunConfigured`: true iff `process.env.MAILGUN_API_KEY` + `MAILGUN_DOMAIN`
 *     + `MAILGUN_FROM` are all non-empty.
 *   - `defaultEmailProvider`: `"mailgun"` per Adam directive 2026-05-14
 *     ("let's not use instantly for now on the pipeline, mailgun if enough,
 *     we can switch it"). Dashboard renders the Mailgun sync button as
 *     primary; Instantly button stays behind a `?provider=instantly` query
 *     param for emergency switch-back.
 *
 * The dashboard hides the live-sync button until both `liveOutreachEnabled`
 * and the chosen provider's `*Configured` flag are true. The sync callables
 * ALSO re-check at request entry and downgrade to `dry_run` if either is
 * false — so this callable is purely cosmetic, never load-bearing for safety.
 */

import { onCall } from "firebase-functions/v2/https"
import { requireExternalSupplyAdmin } from "./resolve-identity.js"

export interface ExternalSupplyConfigResult {
  liveOutreachEnabled: boolean
  instantlyConfigured: boolean
  mailgunConfigured: boolean
  defaultEmailProvider: "mailgun" | "instantly"
}

export interface GetExternalSupplyConfigDeps {
  readEnv?: (key: string) => string | undefined
}

type CallableAuth = Parameters<typeof requireExternalSupplyAdmin>[0]

const NON_EMPTY = (v: string | undefined): boolean =>
  typeof v === "string" && v.trim().length > 0

export function runGetExternalSupplyConfig(
  _data: unknown,
  auth: CallableAuth,
  deps: GetExternalSupplyConfigDeps = {},
): ExternalSupplyConfigResult {
  requireExternalSupplyAdmin(auth)
  const readEnv = deps.readEnv ?? ((key: string) => process.env[key])
  const liveOutreachEnabled = readEnv("EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED") === "true"
  const instantlyConfigured = NON_EMPTY(readEnv("INSTANTLY_API_KEY"))
  const mailgunConfigured =
    NON_EMPTY(readEnv("MAILGUN_API_KEY")) &&
    NON_EMPTY(readEnv("MAILGUN_DOMAIN")) &&
    NON_EMPTY(readEnv("MAILGUN_FROM"))
  return {
    liveOutreachEnabled,
    instantlyConfigured,
    mailgunConfigured,
    defaultEmailProvider: "mailgun",
  }
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
