export const PASSED_CANDIDATES_ROUTE = "/admin/passed-candidates"
export const PASSED_CANDIDATES_CALLABLE_NAME = "paAdminPassedCandidatesSnapshot"
export const PASSED_CANDIDATES_DEFAULT_LIMIT = 50
export const PASSED_CANDIDATES_MAX_LIMIT = 100

export type PassedCandidatesFilters = {
  jobId: string
  limit?: number
}

export type PassedCandidatesRequest = {
  jobId: string
  limit: number
}

export type PassedCandidatesRow = {
  id: string
  snapshotId: string
  candidateId: string
  jobId: string
  candidateJobStateId: string
  state: "passed" | "employer_visible"
  displayName: string
  resumeSummary?: string
  level1Snapshot?: Record<string, unknown>
  passReason?: string
  matchReason?: string
  createdAt: string
  profile: {
    piiConsentAt?: string
    consentStatus: "granted" | "missing"
    level1Status?: string
    level1CompletedAt?: string
    onboardingStatus?: string
    candidateLifecycleState?: string
  }
  transcript: {
    prescreenSessionId?: string
    turns: Array<{
      id: string
      role: "user" | "assistant" | "system"
      body: string
      qId?: string
      actionKind?: string
      scoreSummary?: string
      createdAt?: string
    }>
  }
}

export type PassedCandidatesSnapshot = {
  generatedAt: string
  filters: PassedCandidatesRequest
  summary: {
    totalPassedSnapshots: number
    withConsent: number
    missingConsent: number
    withTranscript: number
    droppedInvalidSnapshot: number
    droppedStateMismatch: number
  }
  rows: PassedCandidatesRow[]
}

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const PHONE_RE = /(?:\+\d[\d\s().-]{7,}\d|\b(?:\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})\b)/g
const RESUME_RE = /\b(?:https?:\/\/\S*(?:resume|cv)[^\s]*|gs:\/\/\S+|(?:resume|cv)[\w ._-]*\.(?:pdf|docx?|txt))\b/gi
const STORAGE_RE = /\b(?:https?:\/\/\S*(?:storage\.googleapis\.com|firebasestorage\.googleapis\.com|storage\.cloud\.google\.com)\S*)\b/gi
const LINKEDIN_RE = /\bhttps?:\/\/(?:www\.)?linkedin\.com\/\S+\b/gi
const HANDLE_RE = /(^|\s)@[A-Za-z0-9_.-]{3,}\b/g

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function clampPassedCandidatesLimit(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(numeric)) return PASSED_CANDIDATES_DEFAULT_LIMIT
  return Math.max(1, Math.min(PASSED_CANDIDATES_MAX_LIMIT, Math.trunc(numeric)))
}

export function buildPassedCandidatesRequest(filters: PassedCandidatesFilters): PassedCandidatesRequest {
  return {
    jobId: cleanString(filters.jobId) ?? "",
    limit: clampPassedCandidatesLimit(filters.limit),
  }
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(EMAIL_RE, "[redacted email]")
    .replace(PHONE_RE, "[redacted phone]")
    .replace(LINKEDIN_RE, "[redacted linkedin]")
    .replace(HANDLE_RE, "$1[redacted handle]")
    .replace(STORAGE_RE, "[redacted storage]")
    .replace(RESUME_RE, "[redacted resume]")
}

export function formatSafeText(value: unknown, max = 180): string {
  if (value === null || value === undefined || value === "") return "-"
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "-"
  if (typeof value === "boolean") return value ? "yes" : "no"
  if (Array.isArray(value)) return value.length ? value.map((item) => formatSafeText(item, max)).join(", ").slice(0, max) : "-"
  if (typeof value === "object") return "[object]"
  return redactSensitiveText(String(value)).slice(0, max)
}

export function formatSafeJson(value: unknown, max = 520): string {
  if (!value || typeof value !== "object") return "-"
  return redactSensitiveText(JSON.stringify(value, null, 2)).slice(0, max)
}

export function formatTimestamp(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "-"
  return value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC")
}

export function formatCount(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0"
  return Math.trunc(value).toLocaleString("en-US")
}
