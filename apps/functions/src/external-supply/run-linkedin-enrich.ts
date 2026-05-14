/**
 * V2 P3 — admin callable: trigger BrightData LinkedIn enrich on a candidate.
 *
 * Translates the dashboard's `recordId` (or raw `linkedinUrl`) into a POST
 * against core-service `sourcing-api` at
 * `/api/sourcing/vendor-profile-lookup:run`, forwards the BrightData result
 * straight back to the operator UI.
 *
 * Status-code propagation:
 *   - 503 from core-service ("BRIGHT_DATA_API_KEY secret is not configured")
 *     → `HttpsError("failed-precondition", "bright_data_key_missing")` so the
 *     dashboard surfaces a clear "Adam rotate key" toast.
 *   - 502 from core-service (BrightData upstream HTTP error) →
 *     `HttpsError("unavailable", ...)`.
 *   - 400 / 404 / 422 → `HttpsError("invalid-argument" | "not-found", ...)`.
 *
 * Auth: `requireExternalSupplyAdmin` (same `@wekruit.com` gate as the rest
 * of the external-supply CFs).
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { z } from "zod"
import { requireExternalSupplyAdmin } from "./resolve-identity.js"
import { resolveSourcingBaseUrl } from "./sourcing-bridge.js"

const InputSchema = z
  .object({
    recordId: z.string().min(1).optional(),
    linkedinUrl: z.string().min(1).optional(),
    approvedEntityId: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.recordId) || Boolean(v.linkedinUrl) || Boolean(v.approvedEntityId), {
    message: "one_of_recordId_linkedinUrl_approvedEntityId_required",
  })

export interface RunLinkedInEnrichResult {
  matchId: string
  runId: string
  vendor: "brightdata"
  linkedinUrl: string
  snapshotId: string
  status: "ready" | "building" | "failed"
  profile: Record<string, unknown> | null
}

export const paExternalSupplyRunLinkedInEnrich = onCall(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 180,
  },
  async (req): Promise<RunLinkedInEnrichResult> => {
    requireExternalSupplyAdmin(req.auth)
    const parsed = InputSchema.safeParse(req.data)
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message)
    }

    const body: Record<string, string> = {}
    // wekruit-pa stores records under recordId; core-service sourcing-api
    // uses the same value as `sourceRecordId` because our P2 bridge mirrors
    // recordId → sourceRecordId 1:1 (see sourcing-bridge.ts:mapRecord).
    if (parsed.data.recordId) body.sourceRecordId = parsed.data.recordId
    if (parsed.data.approvedEntityId) body.approvedEntityId = parsed.data.approvedEntityId
    if (parsed.data.linkedinUrl) body.linkedinUrl = parsed.data.linkedinUrl

    const url = `${resolveSourcingBaseUrl()}/api/sourcing/vendor-profile-lookup:run`
    logger.info("[external-supply.run_linkedin_enrich]", { url, body })

    let res: Response
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    } catch (err) {
      throw new HttpsError(
        "unavailable",
        `sourcing_api_unreachable:${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const text = await res.text()
    if (res.status === 503) {
      throw new HttpsError("failed-precondition", "bright_data_key_missing")
    }
    if (res.status === 404) {
      throw new HttpsError("not-found", safeMessage(text))
    }
    if (res.status === 400 || res.status === 422) {
      throw new HttpsError("invalid-argument", safeMessage(text))
    }
    if (res.status === 502) {
      throw new HttpsError("unavailable", `bright_data_upstream:${safeMessage(text).slice(0, 200)}`)
    }
    if (!res.ok) {
      throw new HttpsError("internal", `sourcing_api_${res.status}:${safeMessage(text).slice(0, 200)}`)
    }
    const json = JSON.parse(text) as { data?: RunLinkedInEnrichResult }
    if (!json.data) {
      throw new HttpsError("internal", "sourcing_api_empty_data")
    }
    return json.data
  },
)

function safeMessage(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string } }
    return j.error?.message ?? text
  } catch {
    return text
  }
}
