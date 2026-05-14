/**
 * V2 P3.3 — admin callable: poll an outstanding BrightData snapshot.
 *
 * Companion to `paExternalSupplyRunLinkedInEnrich` — when the initial sync
 * trigger times out and returns status='building', the dashboard hits this
 * to fetch the latest snapshot state and persist the profile when ready.
 *
 * Same input shape as the trigger (recordId | linkedinUrl | approvedEntityId)
 * so the dashboard doesn't need to remember runId/snapshotId.
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

export interface PollLinkedInEnrichResult {
  matchId: string
  runId: string
  vendor: "brightdata"
  linkedinUrl: string
  snapshotId: string
  status: "ready" | "building" | "failed"
  profile: Record<string, unknown> | null
}

export const paExternalSupplyPollLinkedInEnrich = onCall(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (req): Promise<PollLinkedInEnrichResult> => {
    requireExternalSupplyAdmin(req.auth)
    const parsed = InputSchema.safeParse(req.data)
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message)
    }
    const body: Record<string, string> = {}
    if (parsed.data.recordId) body.sourceRecordId = parsed.data.recordId
    if (parsed.data.approvedEntityId) body.approvedEntityId = parsed.data.approvedEntityId
    if (parsed.data.linkedinUrl) body.linkedinUrl = parsed.data.linkedinUrl

    const url = `${resolveSourcingBaseUrl()}/api/sourcing/vendor-profile-poll`
    logger.info("[external-supply.poll_linkedin_enrich]", { url, body })

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
    if (res.status === 503) throw new HttpsError("failed-precondition", "bright_data_key_missing")
    if (res.status === 404) throw new HttpsError("not-found", safeMessage(text))
    if (res.status === 400 || res.status === 422) {
      throw new HttpsError("invalid-argument", safeMessage(text))
    }
    if (res.status === 502) {
      throw new HttpsError("unavailable", `bright_data_upstream:${safeMessage(text).slice(0, 200)}`)
    }
    if (!res.ok) {
      throw new HttpsError("internal", `sourcing_api_${res.status}:${safeMessage(text).slice(0, 200)}`)
    }
    const json = JSON.parse(text) as { data?: PollLinkedInEnrichResult }
    if (!json.data) throw new HttpsError("internal", "sourcing_api_empty_data")
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
