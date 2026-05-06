/**
 * v1.7 Phase 70 — `paAdminMatchDebug` admin-only callable.
 *
 * Live debugger for the V16 match cascade. Mirrors `paPromoteSandboxTag`
 * admin-auth pattern (Firebase Auth `auth.token.admin === true` claim,
 * with `PA_ADMIN_TOKEN` fallback for scripted callers).
 *
 * REQ-IDs: MATCHDEBUG-01..04
 *
 * Endpoint shape:
 *
 *   Input  { userId, weightOverrides?, limit? }
 *   Output { jobs, total, dropped, hardFilter, noUserTags?, llmCacheStale?, userTags? }
 *
 * Diff vs the recruiter-bound `queryMatchingJobs` tool wrapper:
 *  - Returns the FULL v16 score breakdown per job (not just title/url/reason)
 *    so the dashboard can render per-component sliders + tooltips.
 *  - Echoes the loaded userTags snapshot for the dashboard sidebar profile
 *    (the recruiter-tool path strips it).
 *  - Accepts `weightOverrides` 0..1 per axis to power the score-sandbox UI.
 *
 * Architecture: thin shim over `queryMatchingJobsV16`. All score-component
 * logic lives in the V16 module — this CF only validates input + projects
 * the result for the dashboard.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { getFirestore } from "firebase-admin/firestore"
import { z } from "zod"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

// PA_ADMIN_TOKEN — scripted-caller fallback (mirrors paPromoteSandboxTag).
const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Each weight override is independently optional + clamped 0..1. Missing
 * keys fall back to canonical V16_SCORE_WEIGHTS inside `scoreV16Job`.
 */
const WeightOverridesSchema = z
  .object({
    llmMatch: z.number().min(0).max(1).optional(),
    skillJaccard: z.number().min(0).max(1).optional(),
    relevantTags: z.number().min(0).max(1).optional(),
    industrySector: z.number().min(0).max(1).optional(),
    cvEmbCosine: z.number().min(0).max(1).optional(),
    salaryFit: z.number().min(0).max(1).optional(),
  })
  .optional()

export const AdminMatchDebugInputSchema = z.object({
  userId: z.string().min(8),
  weightOverrides: WeightOverridesSchema,
  limit: z.number().int().min(1).max(50).default(10),
  /** Scripted-admin fallback (mirrors paPromoteSandboxTag). */
  adminToken: z.string().optional(),
})
export type AdminMatchDebugInput = z.infer<typeof AdminMatchDebugInputSchema>

// ---------------------------------------------------------------------------
// CF entry — admin-gated, delegates to V16
// ---------------------------------------------------------------------------

export const paAdminMatchDebug = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req) => {
    // 1. Admin gate — same pattern as paPromoteSandboxTag.
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })

    // 2. Parse + validate.
    const parsed = AdminMatchDebugInputSchema.safeParse(req.data)
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message)
    }

    // 3. Lazy-load V16 (heavier than the rest of this file; admin-only call).
    const { queryMatchingJobsV16 } = await import("@pa/job-rec")
    const db = getFirestore()

    const args: Parameters<typeof queryMatchingJobsV16>[0] = {
      userId: parsed.data.userId,
      limit: parsed.data.limit,
    }
    if (parsed.data.weightOverrides) {
      args.weightOverrides = parsed.data.weightOverrides
    }

    const out = await queryMatchingJobsV16(args, { db, log: () => undefined })

    // 4. Project a thin shape for dashboard rendering — keep score breakdown
    //    + matchedSkills + a slice of requiredSkills for the JD diff drawer.
    return {
      jobs: out.jobs.map((j) => ({
        jobId: j.id,
        jobTitle: j.jobTitle,
        companyName: j.companyName,
        atsApplyUrl: j.atsApplyUrl ?? null,
        roleFunction: j.roleFunction ?? [],
        seniorityLevel: j.seniorityLevel ?? null,
        sponsorship: j.sponsorship ?? null,
        firstSeenAt: j.firstSeenAt ?? null,
        v16Score: j.v16Score,
        matchedSkills: j.matchedSkills,
        reason: j.reason,
        requiredSkills: Array.isArray(j.requiredSkills)
          ? j.requiredSkills.slice(0, 10)
          : [],
      })),
      total: out.total,
      dropped: out.dropped,
      hardFilter: out.hardFilter,
      noUserTags: out.noUserTags ?? false,
      llmCacheStale: out.llmCacheStale ?? false,
      userTags: out.userTags ?? null,
    }
  },
)
