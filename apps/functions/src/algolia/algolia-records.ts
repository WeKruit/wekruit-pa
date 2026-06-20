/**
 * Pure Algolia record mappers for the two indexes the admin dashboard searches:
 *  - `pa_recruiter_submissions` — every recruiter submission (search by
 *    candidate / submitter / job; filter by status / job).
 *  - `pa_candidates` — the whole pa-users pool (search by name / email / phone /
 *    linkedin / skills; filter by class / source / lifecycle).
 *
 * Kept dependency-free + pure so they unit-test without firebase. The sync
 * triggers + backfill (algolia-sync.ts / algolia-backfill.ts) call these.
 */
import {
  classifyCandidateProfile,
  deriveCandidateSource,
  type CandidateListUserDoc,
} from "@pa/core-types"

export const SUBMISSIONS_INDEX = "pa_recruiter_submissions"
export const CANDIDATES_INDEX = "pa_candidates"

/** Searchable + filterable attributes to configure on each index (settings). */
export const SUBMISSIONS_SEARCHABLE = [
  "candidateName",
  "candidateEmail",
  "candidateLink",
  "submitterName",
  "submitterEmail",
  "jobTitle",
  "companyLabel",
] as const
export const SUBMISSIONS_FACETS = ["status", "jobId"] as const

export const CANDIDATES_SEARCHABLE = [
  "displayName",
  "email",
  "phoneE164",
  "linkedinUrl",
  "skills",
  "companies",
] as const
export const CANDIDATES_FACETS = ["candidateClass", "source", "lifecycle"] as const

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

function toMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : 0
  }
  if (value && typeof value === "object") {
    const o = value as { seconds?: number; _seconds?: number; toDate?: () => Date }
    if (typeof o.seconds === "number") return o.seconds * 1000
    if (typeof o._seconds === "number") return o._seconds * 1000
    if (typeof o.toDate === "function") {
      try {
        const d = o.toDate()
        if (d instanceof Date && Number.isFinite(d.getTime())) return d.getTime()
      } catch {
        /* fall through */
      }
    }
  }
  return 0
}

export interface AlgoliaSubmissionRecord {
  objectID: string
  candidateName?: string
  candidateEmail?: string
  candidateLink?: string
  submitterName?: string
  submitterEmail?: string
  jobTitle?: string
  companyLabel?: string
  jobId?: string
  inboundJobId?: string
  status: string
  hardChecked: number
  hardTotal: number
  sheetSyncError: boolean
  createdAtMs: number
}

export function toSubmissionRecord(id: string, data: Record<string, unknown>): AlgoliaSubmissionRecord {
  const submitter = (data.submitter ?? {}) as Record<string, unknown>
  const candidate = (data.candidate ?? {}) as Record<string, unknown>
  const score = (data.score ?? {}) as Record<string, unknown>
  return {
    objectID: id,
    candidateName: str(candidate.name),
    candidateEmail: str(candidate.email),
    candidateLink: str(candidate.link),
    submitterName: str(submitter.name),
    submitterEmail: str(submitter.email),
    jobTitle: str(data.jobTitleSnapshot),
    companyLabel: str(data.companyLabelSnapshot),
    jobId: str(data.jobId),
    inboundJobId: str(data.inboundJobId),
    status: str(data.status) ?? "new",
    hardChecked: typeof score.hardChecked === "number" ? score.hardChecked : 0,
    hardTotal: typeof score.hardTotal === "number" ? score.hardTotal : 0,
    sheetSyncError: Boolean(data.sheetSyncError),
    createdAtMs: toMs(data.createdAt),
  }
}

export interface AlgoliaCandidateRecord {
  objectID: string
  displayName?: string
  email?: string
  phoneE164?: string
  linkedinUrl?: string
  source: string
  candidateClass: string
  lifecycle: string
  skills: string[]
  companies: string[]
  createdAtMs: number
}

/** Mirrors Candidates.tsx deriveLifecycle (no candidate-job join needed). */
function deriveLifecycle(data: Record<string, unknown>): string {
  const d = data as {
    candidateLifecycleState?: string
    outreach?: { status?: string }
    onboardingStatus?: string
    phoneE164?: string
    email?: string
  }
  if (d.candidateLifecycleState) return d.candidateLifecycleState
  if (d.outreach?.status === "opted_out") return "opted_out"
  if (d.onboardingStatus === "active") return "claimed"
  if (d.onboardingStatus === "provisional") return "profile_created"
  if (d.phoneE164 || d.email) return "reachable"
  return "prospect"
}

function skillsOf(data: Record<string, unknown>): string[] {
  const tags = data.globalTags as { skills?: unknown } | undefined
  const raw = tags?.skills
  if (!Array.isArray(raw)) return []
  return raw
    .map((s) => (typeof s === "string" ? s : (s as { value?: string })?.value))
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .slice(0, 40)
}

function companiesOf(data: Record<string, unknown>): string[] {
  const exp = data.experience
  if (!Array.isArray(exp)) return []
  return exp
    .map((e) => (e as { company?: unknown })?.company)
    .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    .slice(0, 20)
}

export function toCandidateRecord(id: string, data: Record<string, unknown>): AlgoliaCandidateRecord {
  const doc = { ...data, id } as unknown as CandidateListUserDoc
  const source = deriveCandidateSource(doc)
  const candidateClass = classifyCandidateProfile(source, doc)
  return {
    objectID: id,
    displayName: str(data.displayName),
    email: str(data.email),
    phoneE164: str(data.phoneE164),
    linkedinUrl: str(data.linkedinUrl),
    source,
    candidateClass,
    lifecycle: deriveLifecycle(data),
    skills: skillsOf(data),
    companies: companiesOf(data),
    createdAtMs: toMs(data.createdAt),
  }
}
