export const OUTREACH_OPS_ROUTE = "/admin/outreach-ops"
export const OUTREACH_OPS_CALLABLE_NAME = "paAdminOutreachOpsSnapshot"
export const OUTREACH_OPS_DEFAULT_LIMIT = 50
export const OUTREACH_OPS_MAX_LIMIT = 200

export type OutreachOpsFilters = {
  jobId?: string
  status?: string
  approvalState?: string
  limit?: number
}

export type OutreachOpsSnapshotRequest = {
  jobId?: string
  status?: string
  approvalState?: string
  limit: number
}

export type OutreachOpsSummary = {
  totalInvites: number
  allowed: number
  blocked: number
  pendingApproval: number
  approved: number
  queued: number
  sent: number
  delivered: number
  failed: number
  deadLetter: number
  dryRun: number
  capacityBlocked: number
  cooldownBlocked: number
  optOutBlocked: number
  duplicateBlocked: number
}

export type OutreachOpsCapacitySnapshot = Record<string, unknown> & {
  groupId: string
  fromNumber?: string
  status: string
  dailyCap: number
  usedToday: number
  remainingToday: number
  rolling24hUsed?: number
  checkedAt: string
  reason?: string
}

export type OutreachOpsInviteRow = Record<string, unknown> & {
  inviteId: string
  candidateId: string
  candidateDisplayName: string
  jobId: string
  jobTitle: string
  companyName: string
  matchId?: string
  recommendedAction?: string
  finalScore?: number
  policyDecision: string
  approvalState: string
  status: string
  dryRun: boolean
  decisionReason: string
  blockedSignals: string[]
  cooldownUntil?: string
  stickyAccountGroupId?: string
  capacitySnapshot?: OutreachOpsCapacitySnapshot
  outboundId?: string
  sendblueStatus?: string
  lastError?: string
  createdAt: string
  updatedAt?: string
}

export type OutreachOpsJobRow = {
  jobId: string
  jobTitle: string
  companyName: string
  pendingInvites: number
  blockedInvites: number
  queuedInvites: number
}

export type OutreachOpsSnapshot = {
  generatedAt: string
  filters: OutreachOpsSnapshotRequest
  summary: OutreachOpsSummary
  jobs: OutreachOpsJobRow[]
  invites: OutreachOpsInviteRow[]
  capacity: OutreachOpsCapacitySnapshot[]
  failures: OutreachOpsInviteRow[]
  approvalBatches: Array<{ batchId: string; pendingInvites: number; createdAt: string }>
}

export type OutreachOpsBadgeTone = "ok" | "warn" | "info" | "muted"

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const PHONE_RE = /(?:\+\d{8,15}|\b(?:\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})\b)/g
const RESUME_RE = /\b(?:https?:\/\/\S*(?:resume|cv)[^\s]*\.(?:pdf|docx?|txt)|(?:resume|cv)[\w ._-]*\.(?:pdf|docx?|txt))\b/gi

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function buildOutreachOpsSnapshotRequest(filters: OutreachOpsFilters): OutreachOpsSnapshotRequest {
  const request: OutreachOpsSnapshotRequest = {
    limit: clampLimit(filters.limit),
  }
  const jobId = cleanString(filters.jobId)
  const status = cleanString(filters.status)
  const approvalState = cleanString(filters.approvalState)
  if (jobId) request.jobId = jobId
  if (status) request.status = status
  if (approvalState) request.approvalState = approvalState
  return request
}

export function clampLimit(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(numeric)) return OUTREACH_OPS_DEFAULT_LIMIT
  return Math.max(1, Math.min(OUTREACH_OPS_MAX_LIMIT, Math.trunc(numeric)))
}

export function redactContactLikeText(value: string): string {
  return value
    .replace(EMAIL_RE, "[redacted email]")
    .replace(PHONE_RE, "[redacted phone]")
    .replace(RESUME_RE, "[redacted resume]")
}

export function formatSafeText(value: unknown, max = 160): string {
  if (value === null || value === undefined || value === "") return "-"
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "-"
  if (typeof value === "boolean") return value ? "yes" : "no"
  if (Array.isArray(value)) {
    if (value.length === 0) return "-"
    return compactText(value.map((item) => formatSafeText(item, max)).join(", "), max)
  }
  if (typeof value === "object") return "[object]"
  return compactText(redactContactLikeText(String(value)), max)
}

export function formatCount(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0"
  return Math.trunc(value).toLocaleString("en-US")
}

export function formatScore(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-"
  return value.toFixed(2)
}

export function formatTimestamp(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "-"
  return value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC")
}

export function statusTone(value: string | undefined): OutreachOpsBadgeTone {
  if (!value) return "muted"
  if (["delivered", "sent", "queued", "approved", "active", "auto_outbound", "not_required"].includes(value)) return "ok"
  if (["failed", "dead_letter", "blocked", "do_not_contact", "rejected", "paused", "throttled", "missing"].includes(value)) return "warn"
  if (["pending", "draft", "hitl_review", "warmup", "degraded", "unknown"].includes(value)) return "info"
  return "muted"
}

export function getPendingReviewRows(snapshot: OutreachOpsSnapshot): OutreachOpsInviteRow[] {
  return snapshot.invites.filter((row) => row.approvalState === "pending")
}

export function getBlockedRows(snapshot: OutreachOpsSnapshot): OutreachOpsInviteRow[] {
  return snapshot.invites.filter((row) => {
    return row.status === "blocked" || row.policyDecision === "blocked" || row.policyDecision === "do_not_contact"
  })
}

export function getFailureRows(snapshot: OutreachOpsSnapshot): OutreachOpsInviteRow[] {
  if (snapshot.failures.length > 0) return snapshot.failures
  return snapshot.invites.filter((row) => row.status === "failed" || row.status === "dead_letter")
}

const CAPACITY_SIGNAL_TOKENS = ["capacity", "daily_cap", "group_full", "missing_capacity", "invalid_capacity"]
const COOLDOWN_SIGNAL_TOKENS = ["cooldown"]
const OPT_OUT_SIGNAL_TOKENS = ["opted_out", "opt_out", "do_not_contact", "outreach_blocked"]
const DUPLICATE_SIGNAL_TOKENS = ["duplicate", "same_company_role", "same_job"]

export function classifyBlockedSignals(signals: string[]): {
  capacity: string[]
  cooldown: string[]
  optOut: string[]
  duplicate: string[]
  other: string[]
} {
  const result = {
    capacity: [] as string[],
    cooldown: [] as string[],
    optOut: [] as string[],
    duplicate: [] as string[],
    other: [] as string[],
  }
  for (const signal of signals) {
    const normalized = signal.toLowerCase()
    if (CAPACITY_SIGNAL_TOKENS.some((token) => normalized.includes(token))) result.capacity.push(signal)
    else if (COOLDOWN_SIGNAL_TOKENS.some((token) => normalized.includes(token))) result.cooldown.push(signal)
    else if (OPT_OUT_SIGNAL_TOKENS.some((token) => normalized.includes(token))) result.optOut.push(signal)
    else if (DUPLICATE_SIGNAL_TOKENS.some((token) => normalized.includes(token))) result.duplicate.push(signal)
    else result.other.push(signal)
  }
  return result
}

export function summarizeBlockedSignals(rows: OutreachOpsInviteRow[]): {
  capacity: number
  cooldown: number
  optOut: number
  duplicate: number
  other: number
} {
  return rows.reduce(
    (acc, row) => {
      const signals = classifyBlockedSignals(row.blockedSignals)
      if (signals.capacity.length > 0 || row.capacitySnapshot?.remainingToday === 0) acc.capacity += 1
      if (signals.cooldown.length > 0 || row.cooldownUntil) acc.cooldown += 1
      if (signals.optOut.length > 0 || row.policyDecision === "do_not_contact") acc.optOut += 1
      if (signals.duplicate.length > 0) acc.duplicate += 1
      if (signals.other.length > 0) acc.other += 1
      return acc
    },
    { capacity: 0, cooldown: 0, optOut: 0, duplicate: 0, other: 0 },
  )
}

export function getReadOnlyActionState(row: OutreachOpsInviteRow): {
  disabled: true
  label: "Queue disabled"
  reasons: string[]
} {
  const signals = classifyBlockedSignals(row.blockedSignals)
  const reasons = ["S6 admin UI is read-only"]
  if (row.dryRun) reasons.push("dry-run decision")
  if (row.policyDecision === "blocked") reasons.push("policy blocked")
  if (row.policyDecision === "do_not_contact" || signals.optOut.length > 0) reasons.push("opt-out / do-not-contact")
  if (signals.capacity.length > 0 || row.capacitySnapshot?.remainingToday === 0) reasons.push("capacity blocked")
  if (signals.cooldown.length > 0 || row.cooldownUntil) reasons.push("cooldown active")
  if (signals.duplicate.length > 0) reasons.push("duplicate suppressed")
  if (row.approvalState === "pending") reasons.push("pending HITL approval")
  if (row.approvalState === "rejected") reasons.push("approval rejected")
  if (row.status === "failed" || row.status === "dead_letter") reasons.push("failure requires backend retry path")
  return { disabled: true, label: "Queue disabled", reasons: [...new Set(reasons)] }
}

export function formatCapacityUsage(row: OutreachOpsCapacitySnapshot): string {
  return `${formatCount(row.usedToday)} / ${formatCount(row.dailyCap)} used, ${formatCount(row.remainingToday)} left`
}

function compactText(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max))}...`
}
