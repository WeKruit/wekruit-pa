/**
 * Per-candidate scheduling ramp — admin callables.
 *
 * `paAdminSetCandidateScheduling` — operator enables/disables REAL interview
 * scheduling for ONE candidate by mutating ONLY the `paSchedulingEnabled`
 * feature-flag allowlist:
 *   - enabled  → addUserToFlagAllowlist  (FieldValue.arrayUnion)
 *   - disabled → removeUserFromFlagAllowlist (FieldValue.arrayRemove)
 * It NEVER touches the flag's global `value` (no global flip — the operator
 * picks individual candidates; respects the locked outbound/scheduling safety
 * rule that scheduling never widens to all real candidates by accident).
 *
 * `paAdminGetCandidateScheduling` — read-only: returns the candidate's current
 * eligibility (resolved via isSchedulingEligible) + whether they're a hardcoded
 * dev uid (the floor, which can't be toggled off).
 *
 * Auth via the shared admin gate (authorizeAdminCallable). Audit rows are
 * written by the allowlist helpers themselves (flag.allowlist_add /
 * flag.allowlist_remove), so no extra audit code is needed here.
 */
import { getFirestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { z } from "zod"
import { addUserToFlagAllowlist, removeUserFromFlagAllowlist } from "@pa/pa-persistence"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"
import {
  SCHEDULING_FLAG_KEY,
  isSchedulingDevUid,
  isSchedulingEligible,
} from "./claire-agent/scheduling-gate.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

export const AdminSetCandidateSchedulingInputSchema = z.object({
  userId: z.string().min(1),
  enabled: z.boolean(),
  adminToken: z.string().nullish(),
})
export type AdminSetCandidateSchedulingInput = z.infer<typeof AdminSetCandidateSchedulingInputSchema>

export interface AdminSetCandidateSchedulingResult {
  userId: string
  /** Whether scheduling is now eligible for this candidate (post-write resolve). */
  eligible: boolean
  /** True iff the uid is a hardcoded scheduling dev uid (the floor — always eligible). */
  isDevUid: boolean
  /** The action applied to the allowlist. */
  action: "allowlist_add" | "allowlist_remove"
}

export const paAdminSetCandidateScheduling = onCall(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 60, secrets: [PA_ADMIN_TOKEN] },
  async (req): Promise<AdminSetCandidateSchedulingResult> => {
    const { uid } = authorizeAdminCallable(
      req as { auth?: { token?: { admin?: unknown } }; data?: unknown },
    )
    const parsed = AdminSetCandidateSchedulingInputSchema.safeParse(req.data ?? {})
    if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
    const input = parsed.data
    const db = getFirestore()
    const actor = uid || "operator"

    if (input.enabled) {
      // arrayUnion — idempotent; creates the flag doc (value:false, this user on)
      // if absent. NEVER flips the global `value`.
      await addUserToFlagAllowlist(db, SCHEDULING_FLAG_KEY, input.userId, {
        actor,
        reason: "operator enabled real interview scheduling for this candidate",
      })
    } else {
      // arrayRemove — idempotent; touches only the allowlist, leaves global value.
      await removeUserFromFlagAllowlist(db, SCHEDULING_FLAG_KEY, input.userId, {
        actor,
        reason: "operator disabled real interview scheduling for this candidate",
      })
    }

    const eligible = await isSchedulingEligible(db, input.userId)
    return {
      userId: input.userId,
      eligible,
      isDevUid: isSchedulingDevUid(input.userId),
      action: input.enabled ? "allowlist_add" : "allowlist_remove",
    }
  },
)

export const AdminGetCandidateSchedulingInputSchema = z.object({
  userId: z.string().min(1),
  adminToken: z.string().nullish(),
})
export type AdminGetCandidateSchedulingInput = z.infer<typeof AdminGetCandidateSchedulingInputSchema>

export interface AdminGetCandidateSchedulingResult {
  userId: string
  /** Whether scheduling is currently eligible (dev floor OR allowlist/value). */
  enabled: boolean
  /** True iff a hardcoded dev uid (the floor — toggle can't turn it off). */
  isDevUid: boolean
}

export const paAdminGetCandidateScheduling = onCall(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 60, secrets: [PA_ADMIN_TOKEN] },
  async (req): Promise<AdminGetCandidateSchedulingResult> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const parsed = AdminGetCandidateSchedulingInputSchema.safeParse(req.data ?? {})
    if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
    const input = parsed.data
    const db = getFirestore()

    const enabled = await isSchedulingEligible(db, input.userId)
    return {
      userId: input.userId,
      enabled,
      isDevUid: isSchedulingDevUid(input.userId),
    }
  },
)
