/**
 * Client helpers for the recruiter board CFs (paCollabJobsList,
 * paRecruiterSubmission). Backs /recruiters and /recruiters/job/:jobId routes.
 */
import { auth } from "./firebase.js"

const DEFAULT_BASE =
  (typeof import.meta !== "undefined" && (import.meta as { env?: { VITE_PA_FUNCTIONS_BASE_URL?: string } }).env?.VITE_PA_FUNCTIONS_BASE_URL) ||
  "https://us-central1-wekruit-5f89b.cloudfunctions.net"

export const COLLAB_JOBS_URL = `${DEFAULT_BASE}/paCollabJobsList`
export const RECRUITER_ACCESS_URL = `${DEFAULT_BASE}/paRecruiterAccess`
export const RECRUITER_ME_URL = `${DEFAULT_BASE}/paRecruiterMe`
export const RECRUITER_PREFERENCES_URL = `${DEFAULT_BASE}/paRecruiterPreferencesUpdate`
export const RECRUITER_SOURCED_CANDIDATES_LIST_URL = `${DEFAULT_BASE}/paRecruiterSourcedCandidatesList`
export const RECRUITER_SOURCED_CANDIDATE_SAVE_URL = `${DEFAULT_BASE}/paRecruiterSourcedCandidateSave`
export const RECRUITER_ROLE_FEEDBACK_LIST_URL = `${DEFAULT_BASE}/paRecruiterRoleFeedbackList`
export const RECRUITER_ROLE_FEEDBACK_SAVE_URL = `${DEFAULT_BASE}/paRecruiterRoleFeedbackSave`
export const RECRUITER_ROLE_INTELLIGENCE_LIST_URL = `${DEFAULT_BASE}/paRecruiterRoleIntelligenceList`
export const RECRUITER_ROLE_QUESTIONS_LIST_URL = `${DEFAULT_BASE}/paRecruiterRoleQuestionsList`
export const RECRUITER_ROLE_QUESTION_CREATE_URL = `${DEFAULT_BASE}/paRecruiterRoleQuestionCreate`
export const RECRUITER_SUBMISSION_URL = `${DEFAULT_BASE}/paRecruiterSubmission`
export const RECRUITER_SUBMISSIONS_LIST_URL = `${DEFAULT_BASE}/paRecruiterSubmissionsList`

// Mirrors PublicCollabJob in apps/functions/src/recruiter-board.ts. Loose
// typing on purpose — the server is source of truth.
export interface CollabJob {
  jobId: string
  title: string
  compSummary?: string
  updatedAt?: string | null
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
  submitter: { name: string; email: string }
  candidate: {
    name: string
    link: string
    currentRole?: string
    yoe?: string
    notes?: string
  }
  checklist: { [itemId: string]: boolean }
  candidateConsent: true
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
  submissionMode?: "primary_role" | "single_submission"
}

export interface RecruiterProfile {
  recruiterId: string
  firebaseUid: string
  name: string
  email: string
  notificationPreferences?: {
    newRolesEmail: boolean
  }
  workspacePreferences?: {
    primaryRoleIds: string[]
  }
}

export interface RecruiterSession {
  recruiterId: string
  recruiter: RecruiterProfile
}

export interface RecruiterSubmissionStatusHistoryItem {
  status: string
  by?: string
  atIso?: string
  note?: string
}

export interface RecruiterSubmissionItem {
  id: string
  submissionId?: string
  jobId?: string
  inboundJobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  candidate?: {
    name?: string
    link?: string
    currentRole?: string
    yoe?: string
    notes?: string
  }
  score?: SubmissionResponse["score"]
  submissionMode?: "primary_role" | "single_submission" | "unclassified"
  status?: string
  statusHistory?: RecruiterSubmissionStatusHistoryItem[]
  recruiterFeedbackNote?: string | null
  recruiterFeedbackUpdatedAt?: { seconds?: number } | string | null
  createdAt?: { seconds?: number } | string | null
  updatedAt?: { seconds?: number } | string | null
}

export type RecruiterSourcedCandidateStage = "sourced" | "contacted" | "screened" | "ready" | "submitted" | "archived"

export interface RecruiterSourcedCandidateItem {
  id: string
  candidateId: string
  recruiterId?: string
  jobId?: string
  inboundJobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  stage: RecruiterSourcedCandidateStage
  candidate?: {
    name?: string
    link?: string
    currentRole?: string
    yoe?: string
    notes?: string
  }
  calibrationStatus?: string
  calibrationNote?: string | null
  calibrationUpdatedAt?: { seconds?: number } | string | null
  createdAt?: { seconds?: number } | string | null
  updatedAt?: { seconds?: number } | string | null
}

export interface RecruiterSourcedCandidateInput {
  candidateId?: string
  jobId: string
  stage: RecruiterSourcedCandidateStage
  candidate: {
    name: string
    link: string
    currentRole?: string
    yoe?: string
    notes?: string
  }
  calibrationRequest?: {
    note?: string
  }
}

export type RecruiterRoleFeedbackDifficulty = "easy" | "medium" | "hard" | "blocked"

export type RecruiterRoleFeedbackReason =
  | "low_comp"
  | "location_mismatch"
  | "unclear_requirements"
  | "small_candidate_pool"
  | "hiring_team_slow"
  | "role_too_broad"
  | "candidate_interest_low"
  | "too_many_recruiters"
  | "other"

export interface RecruiterRoleFeedbackItem {
  id: string
  recruiterId?: string
  recruiterEmail?: string
  jobId?: string
  inboundJobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  difficulty: RecruiterRoleFeedbackDifficulty
  reasons: RecruiterRoleFeedbackReason[]
  note?: string | null
  createdAt?: { seconds?: number } | string | null
  updatedAt?: { seconds?: number } | string | null
}

export interface RecruiterRoleFeedbackInput {
  jobId: string
  difficulty: RecruiterRoleFeedbackDifficulty
  reasons: RecruiterRoleFeedbackReason[]
  note?: string
}

export interface RecruiterRoleQuestionItem {
  id: string
  questionId?: string
  recruiterId?: string
  recruiterEmail?: string
  jobId?: string
  inboundJobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  question?: string
  status?: "open" | "answered"
  answer?: string | null
  answeredByEmail?: string | null
  answeredAt?: { seconds?: number } | string | null
  createdAt?: { seconds?: number } | string | null
  updatedAt?: { seconds?: number } | string | null
}

export interface RecruiterRoleQuestionInput {
  jobId: string
  question: string
}

export interface RecruiterRoleIntelligenceReasonCount {
  reason: RecruiterRoleFeedbackReason
  count: number
}

export interface RecruiterRoleIntelligenceItem {
  jobId: string
  sourcedCount: number
  readyCount: number
  submissionCount: number
  pendingCount: number
  advancedCount: number
  rejectedCount: number
  duplicateCount: number
  recruiterCount: number
  openQuestionCount: number
  answeredQuestionCount: number
  lastActivityAt: string | null
  feedback: {
    total: number
    easy: number
    medium: number
    hard: number
    blocked: number
    topReasons: RecruiterRoleIntelligenceReasonCount[]
  }
  my: {
    sourcedCount: number
    readyCount: number
    submissionCount: number
    pendingCount: number
  }
}

export async function recruiterAuthHeaders(): Promise<Record<string, string>> {
  const user = auth().currentUser
  if (!user) throw new Error("recruiter_auth_required")
  const token = await user.getIdToken()
  return { Authorization: `Bearer ${token}` }
}

export async function fetchCollabJobs(): Promise<CollabJob[]> {
  const res = await fetch(COLLAB_JOBS_URL, { method: "GET" })
  if (!res.ok) throw new Error(`paCollabJobsList HTTP ${res.status}`)
  const body = (await res.json()) as { ok: boolean; jobs?: CollabJob[]; reason?: string }
  if (!body.ok || !body.jobs) throw new Error(`paCollabJobsList not_ok: ${body.reason ?? "unknown"}`)
  return body.jobs
}

export async function registerRecruiterAccess(input: {
  name: string
  email: string
  inviteCode: string
}): Promise<RecruiterSession> {
  const res = await fetch(RECRUITER_ACCESS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await recruiterAuthHeaders()),
    },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    reason?: string
    recruiterId?: string
    recruiter?: RecruiterProfile
  }
  if (!res.ok || !body.ok || !body.recruiterId || !body.recruiter) {
    throw new Error(body.reason ?? `paRecruiterAccess HTTP ${res.status}`)
  }
  return { recruiterId: body.recruiterId, recruiter: body.recruiter }
}

export async function getRecruiterProfile(): Promise<RecruiterSession> {
  const res = await fetch(RECRUITER_ME_URL, {
    method: "GET",
    headers: await recruiterAuthHeaders(),
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    reason?: string
    recruiterId?: string
    recruiter?: RecruiterProfile
  }
  if (!res.ok || !body.ok || !body.recruiterId || !body.recruiter) {
    throw new Error(body.reason ?? `paRecruiterMe HTTP ${res.status}`)
  }
  return { recruiterId: body.recruiterId, recruiter: body.recruiter }
}

export async function fetchRecruiterSubmissions(): Promise<RecruiterSubmissionItem[]> {
  const res = await fetch(RECRUITER_SUBMISSIONS_LIST_URL, {
    method: "GET",
    headers: await recruiterAuthHeaders(),
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    reason?: string
    submissions?: RecruiterSubmissionItem[]
  }
  if (!res.ok || !body.ok || !body.submissions) {
    throw new Error(body.reason ?? `paRecruiterSubmissionsList HTTP ${res.status}`)
  }
  return body.submissions
}

export async function fetchRecruiterSourcedCandidates(): Promise<RecruiterSourcedCandidateItem[]> {
  const res = await fetch(RECRUITER_SOURCED_CANDIDATES_LIST_URL, {
    method: "GET",
    headers: await recruiterAuthHeaders(),
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    reason?: string
    candidates?: RecruiterSourcedCandidateItem[]
  }
  if (!res.ok || !body.ok || !body.candidates) {
    throw new Error(body.reason ?? `paRecruiterSourcedCandidatesList HTTP ${res.status}`)
  }
  return body.candidates
}

export async function fetchRecruiterRoleFeedback(): Promise<RecruiterRoleFeedbackItem[]> {
  const res = await fetch(RECRUITER_ROLE_FEEDBACK_LIST_URL, {
    method: "GET",
    headers: await recruiterAuthHeaders(),
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    reason?: string
    feedback?: RecruiterRoleFeedbackItem[]
  }
  if (!res.ok || !body.ok || !body.feedback) {
    throw new Error(body.reason ?? `paRecruiterRoleFeedbackList HTTP ${res.status}`)
  }
  return body.feedback
}

export async function fetchRecruiterRoleIntelligence(): Promise<RecruiterRoleIntelligenceItem[]> {
  const res = await fetch(RECRUITER_ROLE_INTELLIGENCE_LIST_URL, {
    method: "GET",
    headers: await recruiterAuthHeaders(),
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    reason?: string
    intelligence?: RecruiterRoleIntelligenceItem[]
  }
  if (!res.ok || !body.ok || !body.intelligence) {
    throw new Error(body.reason ?? `paRecruiterRoleIntelligenceList HTTP ${res.status}`)
  }
  return body.intelligence
}

export async function saveRecruiterRoleFeedback(
  input: RecruiterRoleFeedbackInput,
): Promise<RecruiterRoleFeedbackItem> {
  const res = await fetch(RECRUITER_ROLE_FEEDBACK_SAVE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await recruiterAuthHeaders()),
    },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    reason?: string
    feedback?: RecruiterRoleFeedbackItem
  }
  if (!res.ok || !body.ok || !body.feedback) {
    throw new Error(body.reason ?? `paRecruiterRoleFeedbackSave HTTP ${res.status}`)
  }
  return body.feedback
}

export async function fetchRecruiterRoleQuestions(): Promise<RecruiterRoleQuestionItem[]> {
  const res = await fetch(RECRUITER_ROLE_QUESTIONS_LIST_URL, {
    method: "GET",
    headers: await recruiterAuthHeaders(),
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    reason?: string
    questions?: RecruiterRoleQuestionItem[]
  }
  if (!res.ok || !body.ok || !body.questions) {
    throw new Error(body.reason ?? `paRecruiterRoleQuestionsList HTTP ${res.status}`)
  }
  return body.questions
}

export async function createRecruiterRoleQuestion(
  input: RecruiterRoleQuestionInput,
): Promise<RecruiterRoleQuestionItem> {
  const res = await fetch(RECRUITER_ROLE_QUESTION_CREATE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await recruiterAuthHeaders()),
    },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    reason?: string
    question?: RecruiterRoleQuestionItem
  }
  if (!res.ok || !body.ok || !body.question) {
    throw new Error(body.reason ?? `paRecruiterRoleQuestionCreate HTTP ${res.status}`)
  }
  return body.question
}

export async function saveRecruiterSourcedCandidate(
  input: RecruiterSourcedCandidateInput,
): Promise<RecruiterSourcedCandidateItem> {
  const res = await fetch(RECRUITER_SOURCED_CANDIDATE_SAVE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await recruiterAuthHeaders()),
    },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    reason?: string
    candidate?: RecruiterSourcedCandidateItem
  }
  if (!res.ok || !body.ok || !body.candidate) {
    if (body.reason === "candidate_already_sourced_for_role") {
      throw new Error("This candidate is already sourced for this role by another recruiter.")
    }
    throw new Error(body.reason ?? `paRecruiterSourcedCandidateSave HTTP ${res.status}`)
  }
  return body.candidate
}

export async function updateRecruiterPreferences(
  input: {
    notificationPreferences?: { newRolesEmail: boolean }
    workspacePreferences?: { primaryRoleIds: string[] }
  },
): Promise<RecruiterSession> {
  const res = await fetch(RECRUITER_PREFERENCES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await recruiterAuthHeaders()),
    },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    reason?: string
    recruiter?: RecruiterProfile
  }
  if (!res.ok || !body.ok || !body.recruiter) {
    throw new Error(body.reason ?? `paRecruiterPreferencesUpdate HTTP ${res.status}`)
  }
  return { recruiterId: body.recruiter.recruiterId, recruiter: body.recruiter }
}

export async function submitRecruiterCandidate(input: SubmissionInput): Promise<SubmissionResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  try {
    Object.assign(headers, await recruiterAuthHeaders())
  } catch {
    return { ok: false, reason: "recruiter_auth_required" }
  }
  const res = await fetch(RECRUITER_SUBMISSION_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...input, source: "hiring-board" }),
  })
  const body = (await res.json().catch(() => ({}))) as SubmissionResponse
  if (!res.ok) return { ok: false, reason: body.reason ?? `http_${res.status}` }
  return body
}
