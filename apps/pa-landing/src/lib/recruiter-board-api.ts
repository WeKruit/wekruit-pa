/**
 * Client helpers for the recruiter board CFs (paCollabJobsList,
 * paRecruiterSubmission). Backs /recruiters and /recruiters/job/:jobId routes.
 */

const DEFAULT_BASE =
  (typeof import.meta !== "undefined" && (import.meta as { env?: { VITE_PA_FUNCTIONS_BASE_URL?: string } }).env?.VITE_PA_FUNCTIONS_BASE_URL) ||
  "https://us-central1-wekruit-5f89b.cloudfunctions.net"

export const COLLAB_JOBS_URL = `${DEFAULT_BASE}/paCollabJobsList`
export const RECRUITER_SUBMISSION_URL = `${DEFAULT_BASE}/paRecruiterSubmission`

// Mirrors PublicCollabJob in apps/functions/src/recruiter-board.ts. Loose
// typing on purpose — the server is source of truth.
export interface CollabJob {
  jobId: string
  title: string
  compSummary?: string
  jdBlocks: Array<{ heading: string; body: string; kind?: "list" | "prose" }>
  recruiterBoard: {
    active: boolean
    sortOrder: number
    label: {
      company: string
      companyCode: string
      location: string
      pills: Array<{ text: string; tone?: "warm" | "cool" | "neutral" }>
    }
    culture: { bet: string; bullets: string[] }
    checklist: {
      groups: Array<{
        kind: "hard" | "fit" | "bonus" | "anti"
        heading: string
        items: Array<{ id: string; text: string }>
      }>
    }
    interviewProcess?: string
  }
}

export interface SubmissionInput {
  jobId: string
  submitter: { name: string; email: string; company?: string }
  candidate: {
    name: string
    link: string
    currentRole?: string
    yoe?: string
    notes?: string
  }
  checklist: { [itemId: string]: boolean }
}

export interface SubmissionResponse {
  ok: boolean
  submissionId?: string
  score?: {
    hardChecked: number; hardTotal: number
    fitChecked: number; fitTotal: number
    bonusChecked: number; bonusTotal: number
    antiChecked: number; antiTotal: number
  }
  reason?: string
}

export async function fetchCollabJobs(): Promise<CollabJob[]> {
  const res = await fetch(COLLAB_JOBS_URL, { method: "GET" })
  if (!res.ok) throw new Error(`paCollabJobsList HTTP ${res.status}`)
  const body = (await res.json()) as { ok: boolean; jobs?: CollabJob[]; reason?: string }
  if (!body.ok || !body.jobs) throw new Error(`paCollabJobsList not_ok: ${body.reason ?? "unknown"}`)
  return body.jobs
}

export async function submitRecruiterCandidate(input: SubmissionInput): Promise<SubmissionResponse> {
  const res = await fetch(RECRUITER_SUBMISSION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => ({}))) as SubmissionResponse
  if (!res.ok) return { ok: false, reason: body.reason ?? `http_${res.status}` }
  return body
}
