/**
 * `paAdminMarkCandidateQuality` — operator marks a candidate's durable quality tier from the
 * submission drawer, WITHOUT rejecting them (Adam 2026-07-26: "we need a feature to tag a candidate
 * as high quality and we can have a list of them to view on admin dashboard, so even they are not
 * fit for the role yet we can find them later").
 *
 * NO NEW TAXONOMY. This writes the SAME `pa-users.globalCandidateTier` the rejection flows already
 * write, through the SAME `applyGlobalCandidateTier` best-wins writer — tier_1 is already defined
 * as "strong, re-review for new roles", which is exactly the thing Adam is asking to record. A
 * parallel "highQuality" boolean would be a second candidate-quality vocabulary that the tier
 * browse, the headhunter MCP and the re-review flow would all have to learn about; CLAUDE.md calls
 * that anti-pattern out by name.
 *
 * The only gap was the ENTRY POINT: a tier could only be stamped as a side effect of a rejection.
 * Now an operator can stamp one from any submission at any status, and the candidate shows up in
 * the existing tier browse (`paAdminRejectedCandidatesSnapshot` scans by tier, not by rejection) —
 * so no second list page either.
 *
 * The candidate is resolved (or created) through the same LinkedIn-handle tracking the eval trigger
 * uses, so the tier lands on the candidate's GLOBAL profile and survives the role that surfaced
 * them. A submission with no LinkedIn cannot be resolved to a durable identity — that returns a
 * reason rather than inventing one.
 *
 * LABEL-ONLY: never touches submission status, never messages anyone.
 */
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { z } from "zod"
import { CandidateTierSchema, type CandidateTier } from "@pa/core-types"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"
import { applyGlobalCandidateTier } from "./candidate-tier.js"
import { ensureRecruiterSubmissionCandidateTracked } from "./recruiter-candidate-tracking.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")
const SUBMISSIONS = "pa-recruiter-submissions"

export interface MarkQualityResult {
  ok: true
  candidateId: string
  /** Best-wins result — may be BETTER than what was just submitted. */
  globalTier: CandidateTier
  globalChanged: boolean
}

export async function runMarkCandidateQuality(
  deps: { db: Firestore; now?: () => string; log?: (...args: unknown[]) => void },
  input: { submissionId: string; tier: CandidateTier; reason?: string; actor?: string },
): Promise<MarkQualityResult | { ok: false; reason: string }> {
  const now = deps.now ? deps.now() : new Date().toISOString()
  const ref = deps.db.collection(SUBMISSIONS).doc(input.submissionId)
  const snap = await ref.get()
  if (!snap.exists) return { ok: false, reason: "submission_not_found" }
  const submission = (snap.data() ?? {}) as Record<string, unknown>

  // Resolves the LinkedIn handle → global pa-users candidate, creating the profile when this is
  // the first time we have seen them. statusOverride omitted: marking quality is not a status move.
  const tracking = await ensureRecruiterSubmissionCandidateTracked(deps.db, {
    submissionId: input.submissionId,
    submission,
    now,
    writeCreatedEvent: false,
  })
  if (!tracking.candidateId) {
    // No LinkedIn ⇒ no durable identity to hang a global tier on. Marking the SUBMISSION instead
    // would create exactly the role-scoped, un-findable flag this feature exists to avoid.
    return { ok: false, reason: "no_candidate_identity_linkedin_required" }
  }

  const applied = await applyGlobalCandidateTier(
    {
      candidateId: tracking.candidateId,
      tier: input.tier,
      source: "admin",
      jobId: typeof submission.jobId === "string" ? submission.jobId : undefined,
      reason: input.reason,
      // A human clicked this. It is not an AI suggestion being confirmed, so there is no
      // aiSuggestedTier and therefore no override-correction event to write.
      humanConfirmed: true,
      actor: input.actor ?? "operator",
    },
    { db: deps.db, now: () => now, log: deps.log },
  )

  return {
    ok: true,
    candidateId: tracking.candidateId,
    globalTier: applied.globalTier,
    globalChanged: applied.globalChanged,
  }
}

const Input = z.object({
  submissionId: z.string().min(1),
  tier: CandidateTierSchema,
  reason: z.string().max(500).nullish(),
  adminToken: z.string().nullish(),
})

export const paAdminMarkCandidateQuality = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 60, secrets: [PA_ADMIN_TOKEN] },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const parsed = Input.safeParse(req.data ?? {})
    if (!parsed.success) throw new HttpsError("invalid-argument", "submissionId + tier required")
    const actor = (req as { auth?: { token?: { email?: string } } }).auth?.token?.email ?? "operator"
    return runMarkCandidateQuality(
      { db: getFirestore(), log: (...a: unknown[]) => logger.info("[mark-quality]", ...a) },
      {
        submissionId: parsed.data.submissionId,
        tier: parsed.data.tier,
        reason: parsed.data.reason ?? undefined,
        actor,
      },
    )
  },
)
