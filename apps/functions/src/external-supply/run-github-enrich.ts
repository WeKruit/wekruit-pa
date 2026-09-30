/**
 * V2 P3.2 — admin callable: trigger GitHub public-profile enrich.
 *
 * Mirrors `run-linkedin-enrich.ts` but talks to core-service's
 * `/api/sourcing/github-profile-lookup` route. GitHub's public REST API is
 * free + unauthenticated (60 req/hr/IP), so this CF has no secret gate and
 * does not return `failed-precondition` on missing config.
 *
 * Status codes:
 *   - 200 → returns the GitHub profile JSON
 *   - 400 / 404 → `HttpsError("invalid-argument" | "not-found", …)`
 *   - 502 → `HttpsError("unavailable", …)` (GitHub rate-limited / 5xx)
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { z } from "zod"
import { requireExternalSupplyAdmin } from "./resolve-identity.js"
import { resolveSourcingBaseUrl } from "./sourcing-bridge.js"

const InputSchema = z
  .object({
    recordId: z.string().min(1).optional(),
    githubUrl: z.string().min(1).optional(),
    approvedEntityId: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.recordId) || Boolean(v.githubUrl) || Boolean(v.approvedEntityId), {
    message: "one_of_recordId_githubUrl_approvedEntityId_required",
  })

export interface RunGitHubEnrichResult {
  matchId: string
  runId: string
  vendor: "github"
  githubUrl: string
  username: string
  status: "ready" | "failed"
  profile: Record<string, unknown> | null
  rateLimit?: { remaining: number; reset: number }
}

export const paExternalSupplyRunGitHubEnrich = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
  },
  async (req): Promise<RunGitHubEnrichResult> => {
    requireExternalSupplyAdmin(req.auth)
    const parsed = InputSchema.safeParse(req.data)
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message)
    }
    const body: Record<string, string> = {}
    if (parsed.data.recordId) body.sourceRecordId = parsed.data.recordId
    if (parsed.data.approvedEntityId) body.approvedEntityId = parsed.data.approvedEntityId
    if (parsed.data.githubUrl) body.githubUrl = parsed.data.githubUrl

    const url = `${resolveSourcingBaseUrl()}/api/sourcing/github-profile-lookup`
    logger.info("[external-supply.run_github_enrich]", { url, body })

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
    if (res.status === 404) throw new HttpsError("not-found", safeMessage(text))
    if (res.status === 400 || res.status === 422) {
      throw new HttpsError("invalid-argument", safeMessage(text))
    }
    if (res.status === 502) {
      throw new HttpsError("unavailable", `github_upstream:${safeMessage(text).slice(0, 200)}`)
    }
    if (!res.ok) {
      throw new HttpsError("internal", `sourcing_api_${res.status}:${safeMessage(text).slice(0, 200)}`)
    }
    const json = JSON.parse(text) as { data?: RunGitHubEnrichResult }
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
