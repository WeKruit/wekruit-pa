/**
 * Callable wrapper for `paAdminCandidateComms`
 * (apps/functions/src/admin-candidate-comms.ts). Returns ONE time-ordered
 * timeline merging SMS (pa-messages) + email (pa-headhunter-emails outbound,
 * pa-email-inbound inbound) for a candidate, so the UserDetail
 * "Communications" panel shows the full conversation, not just SMS.
 */
import { httpsCallable } from "firebase/functions"
import { functions } from "./firebase.js"

export interface CommsTimelineRow {
  id: string
  ts: string
  channel: "sms" | "email"
  direction: "inbound" | "outbound"
  subject?: string
  text: string
  status?: string
  source: string
}

export interface CandidateCommsResult {
  userId: string
  candidateEmail?: string
  rows: CommsTimelineRow[]
  counts: { sms: number; email: number; total: number }
  truncated: boolean
  generatedAt: string
}

export async function getCandidateComms(userId: string): Promise<CandidateCommsResult> {
  const fn = httpsCallable<{ userId: string }, CandidateCommsResult>(functions(), "paAdminCandidateComms")
  const res = await fn({ userId })
  return res.data
}
