import { httpsCallable } from "firebase/functions"

/** Mirror of apps/functions ReinitializeCandidateResult. */
export interface ReinitializeCandidateResult {
  userId: string
  archivedMessages: number
  cleared: boolean
  resumePreserved: boolean
  jobRecPreserved: Record<string, number>
  reEnriched: boolean
  tagKeys: string[]
  reEngageMode: "candidate_self_initiates"
}

const CALLABLE = "paReinitializeCandidate"

/**
 * Reset a candidate's GLOBAL profile (memory, tags, conversation → archived) back to a fresh
 * just-onboarded-from-résumé state, preserving job-specific data (matched jobs, prescreen
 * sessions). The candidate self-initiates the next conversation. Admin-only callable.
 */
export async function reinitializeCandidate(userId: string): Promise<ReinitializeCandidateResult> {
  const { functions } = await import("./firebase.js")
  const fn = httpsCallable<{ userId: string }, ReinitializeCandidateResult>(functions(), CALLABLE)
  const result = await fn({ userId })
  return result.data
}
