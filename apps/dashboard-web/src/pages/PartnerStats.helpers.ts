export const PARTNER_STATS_CALLABLE = "paAdminPartnerStats"
export const SET_AWAITING_HM_CALLABLE = "paAdminSetAwaitingHm"

export interface PartnerStatsFunnelSummary {
  signedUp: number
  withResume: number
  withSkills: number
  enteredJobFlow: number
  prescreenStarted: number
  prescreenReviewPending: number
  awaitingHmResponse: number
  passed: number
  notPassed: number
  employerVisible: number
}

export interface PartnerStatsJobRow {
  jobId: string
  jobTitle: string
  company: string
  state: string
  stateUpdatedAt: string
  reviewStatus?: string
}

export interface PartnerStatsUserRow {
  userId: string
  email: string
  displayName?: string
  registeredAt: string
  lifecycleState?: string
  source?: string
  entrySource?: string
  entryJobId?: string
  attributedVia: "top_level" | "entry" | "both"
  hasResume: boolean
  resumeStatus?: string
  roleFunction: string[]
  careerStage?: string
  yoeRange?: string
  topSkills: string[]
  jobs: PartnerStatsJobRow[]
  currentStage: string
}

export interface PartnerStatsSnapshot {
  generatedAt: string
  partnerSource: string
  funnel: PartnerStatsFunnelSummary
  users: PartnerStatsUserRow[]
  allPartnerSources: string[]
}

export type StageFilter = "all" | "signed_up" | "resume_submitted" | "interviewing" | "review_pending" | "awaiting_hm_response" | "passed" | "not_passed" | "employer_visible"

export const STAGE_LABELS: Record<string, string> = {
  signed_up: "Signed up",
  resume_submitted: "Resume submitted",
  interviewing: "Interviewing",
  review_pending: "Under review",
  awaiting_hm_response: "Awaiting HM",
  passed: "Passed",
  not_passed: "Not passed",
  employer_visible: "Employer visible",
}

export const STAGE_TONES: Record<string, "good" | "bad" | "warn" | "muted"> = {
  signed_up: "muted",
  resume_submitted: "muted",
  interviewing: "warn",
  review_pending: "warn",
  awaiting_hm_response: "warn",
  passed: "good",
  not_passed: "bad",
  employer_visible: "good",
}

export function stageTone(stage: string): "good" | "bad" | "warn" | "muted" {
  return STAGE_TONES[stage] ?? "muted"
}

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage.replace(/_/g, " ")
}

export function formatDate(iso: string): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
  } catch {
    return iso.slice(0, 10)
  }
}
