/**
 * `paAdminRediscoverForJob` — admin-only callable that surfaces the
 * silver-medalist / retained-pool reactivation in the dashboard.
 *
 * Thin auth+validate shim over `runRediscoverForJob` (apps/functions/src/
 * headhunter-mcp/extended.ts) — the SAME runner the Slack-agent
 * `rediscover_for_job` tool calls. Zero new business logic: it reuses the V16
 * two-way scorer (`rankCandidatesForJob` from `@pa/job-rec`) over the global
 * candidate-tier pool (tier_1 strongest … from a PRIOR rejection elsewhere),
 * reactivating the NOT_PASS-stays-in-pool population against a fresh job.
 *
 * Consent-safe projection: mirrors paAdminJobMatchDebug's PII posture — returns
 * candidateId + displayName + scores + recommendedAction + global tier only. No
 * contact handles, no transcript, no résumé. The dashboard renders counts / ids
 * / scores so an operator can decide who to reactivate without leaking PII.
 *
 * Caveat surfaced to the UI: `runRediscoverForJob` only resolves jobs present
 * in `matching-jobs` (the scraped catalog); a pa-jobs collab job created via the
 * admin form may not be indexed there yet → the runner returns
 * `{ error: "job_not_in_matching_jobs ..." }`, which we pass through verbatim so
 * the dashboard can show a graceful "not in the matchable catalog yet" state.
 *
 * Auth mirrors paAdminMatchDebug / paPromoteSandboxTag: Firebase Auth
 * `auth.token.admin === true` OR the `PA_ADMIN_TOKEN` scripted-caller fallback.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { getFirestore } from "firebase-admin/firestore"
import { z } from "zod"
import { runRediscoverForJob } from "./headhunter-mcp/extended.js"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

// PA_ADMIN_TOKEN — scripted-caller fallback (mirrors paAdminMatchDebug).
const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const AdminRediscoverForJobInputSchema = z.object({
  jobId: z.string().min(1, "jobId is required"),
  /** Global candidate tiers to reactivate (default tier_1 + tier_2). */
  tiers: z.array(z.enum(["tier_1", "tier_2", "tier_3"])).min(1).max(3).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  /** Scripted-admin fallback (mirrors paAdminMatchDebug). */
  adminToken: z.string().optional(),
})
export type AdminRediscoverForJobInput = z.infer<typeof AdminRediscoverForJobInputSchema>

/**
 * Pure handler — deps-injected (db passed in) so it's unit-testable without
 * booting firebase-admin. Delegates entirely to the shared
 * `runRediscoverForJob` runner. The runner already returns a consent-safe shape
 * (no contact handles / transcript / résumé), so we pass it through unchanged.
 */
export async function runAdminRediscoverForJob(
  raw: unknown,
  deps: { db: ReturnType<typeof getFirestore> },
): Promise<Record<string, unknown>> {
  const parsed = AdminRediscoverForJobInputSchema.safeParse(raw)
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error.message)
  }
  const input: { jobId: string; tiers?: Array<"tier_1" | "tier_2" | "tier_3">; limit?: number } = {
    jobId: parsed.data.jobId,
    limit: parsed.data.limit,
  }
  if (parsed.data.tiers) input.tiers = parsed.data.tiers
  return runRediscoverForJob(input, { db: deps.db }) as Promise<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// CF entry — admin-gated, delegates to the shared runRediscoverForJob runner.
// ---------------------------------------------------------------------------

export const paAdminRediscoverForJob = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    return runAdminRediscoverForJob(req.data, { db: getFirestore() })
  },
)
