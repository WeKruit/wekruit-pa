/**
 * `paAdminReevaluateCandidateTier` — admin "Re-evaluate for new roles" action
 * on the Rejected-candidates browse. Re-derives the AI-suggested GLOBAL tier
 * from the candidate's existing per-role tier evidence (the AI verdicts already
 * produced at each rejection), and optionally applies an operator-confirmed
 * tier (human authority overrides best-wins). Auth via the shared admin gate.
 */
import { getFirestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { z } from "zod"
import { CandidateTierSchema, type CandidateTier } from "@pa/core-types"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"
import {
  reevaluateCandidateTier,
  setGlobalCandidateTierManual,
  type ReevaluateCandidateTierResult,
} from "./candidate-tier.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

export const AdminReevaluateCandidateTierInputSchema = z.object({
  candidateId: z.string().min(1),
  /** When true, set the global tier to `tier` (or the suggestion) with operator authority. */
  apply: z.boolean().optional().default(false),
  /** Operator-chosen tier when applying; falls back to the AI suggestion. */
  tier: CandidateTierSchema.optional(),
  adminToken: z.string().optional(),
})
export type AdminReevaluateCandidateTierInput = z.infer<typeof AdminReevaluateCandidateTierInputSchema>

export interface AdminReevaluateCandidateTierResult extends ReevaluateCandidateTierResult {
  applied: boolean
  appliedTier?: CandidateTier
}

export const paAdminReevaluateCandidateTier = onCall(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 60, secrets: [PA_ADMIN_TOKEN] },
  async (req): Promise<AdminReevaluateCandidateTierResult> => {
    const { uid } = authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const parsed = AdminReevaluateCandidateTierInputSchema.safeParse(req.data ?? {})
    if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
    const input = parsed.data
    const db = getFirestore()

    const evaluation = await reevaluateCandidateTier(input.candidateId, { db })

    let applied = false
    let appliedTier: CandidateTier | undefined
    if (input.apply) {
      const target = input.tier ?? evaluation.suggestedTier
      if (!target) {
        throw new HttpsError("failed-precondition", "No tier to apply (no evidence and none provided).")
      }
      await setGlobalCandidateTierManual(
        { candidateId: input.candidateId, tier: target, actor: uid || "operator", reason: "re-evaluated for new roles" },
        { db },
      )
      applied = true
      appliedTier = target
    }

    return { ...evaluation, applied, ...(appliedTier ? { appliedTier } : {}) }
  },
)
