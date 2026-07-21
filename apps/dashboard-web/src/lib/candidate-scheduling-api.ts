/**
 * Dashboard wrappers for the per-candidate scheduling-ramp callables
 * (apps/functions/src/admin-set-candidate-scheduling.ts).
 *
 * Enabling lets the agent book a REAL interview for a real candidate by adding
 * their uid to the paSchedulingEnabled flag allowlist. It NEVER flips the
 * flag's global value — one candidate at a time.
 */
import { httpsCallable } from "firebase/functions"
import { functions } from "./firebase.js"

export interface CandidateSchedulingState {
  userId: string
  enabled: boolean
  isDevUid: boolean
}

export interface SetCandidateSchedulingResult {
  userId: string
  eligible: boolean
  isDevUid: boolean
  action: "allowlist_add" | "allowlist_remove"
}

export async function getCandidateScheduling(userId: string): Promise<CandidateSchedulingState> {
  const fn = httpsCallable<{ userId: string }, CandidateSchedulingState>(
    functions(),
    "paAdminGetCandidateScheduling",
  )
  const result = await fn({ userId })
  return result.data
}

export async function setCandidateScheduling(
  userId: string,
  enabled: boolean,
): Promise<SetCandidateSchedulingResult> {
  const fn = httpsCallable<{ userId: string; enabled: boolean }, SetCandidateSchedulingResult>(
    functions(),
    "paAdminSetCandidateScheduling",
  )
  const result = await fn({ userId, enabled })
  return result.data
}
