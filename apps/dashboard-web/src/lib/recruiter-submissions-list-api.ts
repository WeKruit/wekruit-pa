/**
 * Callable wrapper for `paAdminRecruiterSubmissionsList`
 * (apps/functions/src/admin-recruiter-submissions-list.ts). Returns EVERY
 * recruiter submission TRIMMED to the table/search/filter fields (~2.6MB for
 * 3.8k rows) so the Recruiter Submissions search + state filter see the whole
 * pool instead of just the 500 most-recent. The drawer fetches the full doc on
 * open.
 */
import { httpsCallable } from "firebase/functions"
import { functions } from "./firebase.js"

export interface RecruiterSubmissionsListResult {
  rows: Record<string, unknown>[]
  total: number
  truncated: boolean
  generatedAt: string
}

export async function getRecruiterSubmissionsList(): Promise<RecruiterSubmissionsListResult> {
  const fn = httpsCallable<Record<string, never>, RecruiterSubmissionsListResult>(
    functions(),
    "paAdminRecruiterSubmissionsList",
  )
  const res = await fn({})
  return res.data
}
