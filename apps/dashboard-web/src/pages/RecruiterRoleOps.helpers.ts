export type RoleOpsTone = "ok" | "warn" | "info" | "muted"
export type RecruiterRolePriorityTier = "urgent" | "high" | "normal" | "paused"
export type RecruiterRoleEmailAudience = "recruiters" | "candidates" | "both" | "none"

export type RecruiterRoleActivationStage =
  | "setup_needed"
  | "needs_recruiter_coverage"
  | "needs_sourced_supply"
  | "needs_submission"
  | "needs_review"
  | "moving"
  | "needs_calibration"

interface RecruiterRoleActivation {
  stage: RecruiterRoleActivationStage
  label: string
  tone: RoleOpsTone
  reason: string
}

interface RoleOpsTimestamp {
  seconds?: number
}

export interface RecruiterRoleOpsJob {
  id: string
  publicId?: string
  title?: string
  compSummary?: string
  wekruitCollaborationStatus?: string
  updatedAt?: RoleOpsTimestamp | string | null
  recruiterBoard?: {
    active?: boolean
    sortOrder?: number
    updatedAt?: RoleOpsTimestamp | string | null
    interviewProcess?: string
    priority?: {
      rank?: number | null
      tier?: RecruiterRolePriorityTier | string | null
      note?: string | null
      emailAudience?: RecruiterRoleEmailAudience | string | null
      updatedAt?: RoleOpsTimestamp | string | null
      updatedByEmail?: string | null
    }
    label?: {
      company?: string
      location?: string
    }
    culture?: {
      bet?: string
      bullets?: string[]
    }
    checklist?: {
      groups?: Array<{
        kind?: string
        heading?: string
        items?: Array<{ id?: string; text?: string }>
      }>
    }
  }
}

export interface RecruiterRoleOpsActivityRow {
  id: string
  jobId?: string
  inboundJobId?: string
}

export interface RecruiterRoleOpsSubmission extends RecruiterRoleOpsActivityRow {
  status?: string
}

export interface RecruiterRoleOpsCandidate extends RecruiterRoleOpsActivityRow {
  stage?: string
}

export interface RecruiterRoleOpsApplication extends RecruiterRoleOpsActivityRow {
  recruiterId?: string
  recruiterEmail?: string
  status?: "pending" | "approved" | "not_approved" | "withdrawn" | "rescinded"
}

export interface RecruiterRoleOpsFeedback extends RecruiterRoleOpsActivityRow {
  difficulty?: string
}

export interface RecruiterRoleOpsQuestion extends RecruiterRoleOpsActivityRow {
  status?: "open" | "answered"
}

export interface RecruiterRoleOpsRow {
  id: string
  publicId: string
  title: string
  company: string
  location: string
  active: boolean
  collaborated: boolean
  readinessScore: number
  readinessLabel: string
  readinessTone: RoleOpsTone
  missingSetup: string[]
  updatedAtMs: number
  updatedAt?: unknown
  sortOrder: number
  priorityRank: number | null
  prioritySort: number
  priorityTier: RecruiterRolePriorityTier
  priorityTone: RoleOpsTone
  priorityNote: string
  priorityEmailAudience: RecruiterRoleEmailAudience
  priorityUpdatedAt?: unknown
  hardChecks: number
  fitChecks: number
  bonusChecks: number
  antiChecks: number
  approvedRecruiters: number
  pendingApplications: number
  sourced: number
  ready: number
  submissions: number
  pendingSubmissions: number
  advanced: number
  rejectedOrDuplicate: number
  openQuestions: number
  hardFeedback: number
  blockedFeedback: number
  activationStage: RecruiterRoleActivationStage
  activationLabel: string
  activationTone: RoleOpsTone
  activationReason: string
  compSummary?: string
  interviewProcess?: string
}

const PENDING_SUBMISSION_STATUSES = ["submitted", "new", "reviewing", "backburner"]
const ADVANCED_SUBMISSION_STATUSES = ["advanced", "interviewing", "offer", "hired"]
const NEGATIVE_SUBMISSION_STATUSES = ["rejected", "duplicate"]

function timestampToMs(raw: unknown): number {
  if (!raw) return 0
  if (typeof raw === "string") return Date.parse(raw) || 0
  if (typeof raw === "object" && typeof (raw as { seconds?: unknown }).seconds === "number") {
    return ((raw as { seconds: number }).seconds) * 1000
  }
  return 0
}

const PRIORITY_TIERS = new Set<RecruiterRolePriorityTier>(["urgent", "high", "normal", "paused"])
const PRIORITY_AUDIENCES = new Set<RecruiterRoleEmailAudience>(["recruiters", "candidates", "both", "none"])

function priorityRank(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 999) return null
  return n
}

function priorityTier(raw: unknown): RecruiterRolePriorityTier {
  return typeof raw === "string" && PRIORITY_TIERS.has(raw as RecruiterRolePriorityTier)
    ? (raw as RecruiterRolePriorityTier)
    : "normal"
}

function priorityAudience(raw: unknown): RecruiterRoleEmailAudience {
  return typeof raw === "string" && PRIORITY_AUDIENCES.has(raw as RecruiterRoleEmailAudience)
    ? (raw as RecruiterRoleEmailAudience)
    : "recruiters"
}

function priorityTone(tier: RecruiterRolePriorityTier): RoleOpsTone {
  if (tier === "urgent") return "warn"
  if (tier === "high") return "info"
  if (tier === "paused") return "muted"
  return "muted"
}

function rowMatchesRole(row: { inboundJobId?: string; jobId?: string }, role: RecruiterRoleOpsJob): boolean {
  const keys = [role.id, role.publicId].filter(Boolean)
  return keys.some((key) => row.inboundJobId === key || row.jobId === key)
}

function recruiterBoardChecklistCount(role: RecruiterRoleOpsJob, kind: string): number {
  return role.recruiterBoard?.checklist?.groups
    ?.filter((group) => group.kind === kind)
    .reduce((sum, group) => sum + (group.items?.filter((item) => item.text?.trim()).length ?? 0), 0) ?? 0
}

function recruiterRoleReadiness(role: RecruiterRoleOpsJob): {
  score: number
  label: string
  tone: RoleOpsTone
  missing: string[]
} {
  const rb = role.recruiterBoard
  const missing: string[] = []
  if (role.wekruitCollaborationStatus !== "collaborated") missing.push("not marked collaborated")
  if (rb?.active !== true) missing.push("board inactive")
  if (!role.title?.trim()) missing.push("missing title")
  if (!rb?.label?.company?.trim()) missing.push("missing recruiter company label")
  if (!rb?.label?.location?.trim()) missing.push("missing location")
  if (!role.compSummary?.trim()) missing.push("missing comp / fee summary")
  if (!rb?.interviewProcess?.trim()) missing.push("missing interview process")
  if (!rb?.culture?.bet?.trim()) missing.push("missing role pitch")
  if (!rb?.culture?.bullets?.filter((bullet) => bullet.trim()).length) missing.push("missing culture bullets")
  if (recruiterBoardChecklistCount(role, "hard") < 1) missing.push("missing hard checks")
  if (recruiterBoardChecklistCount(role, "fit") < 1) missing.push("missing fit checks")
  const score = Math.max(0, 100 - missing.length * 10)
  if (score >= 90) return { score, label: "Launch-ready", tone: "ok", missing }
  if (rb?.active === true && role.wekruitCollaborationStatus === "collaborated") {
    return { score, label: "Live with gaps", tone: "info", missing }
  }
  return { score, label: "Setup needed", tone: "warn", missing }
}

function recruiterRoleActivation(
  row: Omit<RecruiterRoleOpsRow, "activationStage" | "activationLabel" | "activationTone" | "activationReason">,
): RecruiterRoleActivation {
  if (!row.active || !row.collaborated || row.readinessScore < 90) {
    const reason = row.missingSetup[0]
      ? `Setup is incomplete: ${row.missingSetup[0]}.`
      : "Role is not active and collaborated on the recruiter board."
    return { stage: "setup_needed", label: "Setup needed", tone: "warn", reason }
  }
  if (row.blockedFeedback > 0) {
    return {
      stage: "needs_calibration",
      label: "Needs calibration",
      tone: "warn",
      reason: `${row.blockedFeedback} recruiter feedback row${row.blockedFeedback === 1 ? "" : "s"} marked this role blocked.`,
    }
  }
  if (row.openQuestions > 0) {
    return {
      stage: "needs_calibration",
      label: "Needs calibration",
      tone: "info",
      reason: `${row.openQuestions} open recruiter question${row.openQuestions === 1 ? "" : "s"} need WeKruit response.`,
    }
  }
  if (row.approvedRecruiters < 1) {
    return {
      stage: "needs_recruiter_coverage",
      label: "Needs recruiter coverage",
      tone: "warn",
      reason: "No approved recruiter is assigned to activate this role.",
    }
  }
  if (row.sourced < 1) {
    return {
      stage: "needs_sourced_supply",
      label: "Needs sourced supply",
      tone: "info",
      reason: `${row.approvedRecruiters} approved recruiter${row.approvedRecruiters === 1 ? "" : "s"} but no active sourced candidates yet.`,
    }
  }
  if (row.submissions < 1) {
    return {
      stage: "needs_submission",
      label: "Needs submission",
      tone: "info",
      reason: row.ready > 0
        ? `${row.ready} ready candidate${row.ready === 1 ? "" : "s"} but no submission packet yet.`
        : `${row.sourced} sourced candidate${row.sourced === 1 ? "" : "s"} need screening or submission.`,
    }
  }
  if (row.advanced > 0) {
    return {
      stage: "moving",
      label: "Candidate moving",
      tone: "ok",
      reason: `${row.advanced} submitted candidate${row.advanced === 1 ? "" : "s"} advanced beyond review.`,
    }
  }
  if (row.pendingSubmissions > 0) {
    return {
      stage: "needs_review",
      label: "Needs WeKruit review",
      tone: "info",
      reason: `${row.pendingSubmissions} pending submission${row.pendingSubmissions === 1 ? "" : "s"} need WeKruit review.`,
    }
  }
  if (row.rejectedOrDuplicate >= row.submissions) {
    return {
      stage: "needs_calibration",
      label: "Needs calibration",
      tone: "warn",
      reason: "Every submitted candidate is rejected or duplicate; recalibrate the role or recruiter lane.",
    }
  }
  return {
    stage: "needs_review",
    label: "Needs WeKruit review",
    tone: "info",
    reason: "Submitted candidates need a current WeKruit status.",
  }
}

export function buildRecruiterRoleOpsRows(input: {
  jobs: RecruiterRoleOpsJob[]
  submissions: RecruiterRoleOpsSubmission[]
  candidates: RecruiterRoleOpsCandidate[]
  applications: RecruiterRoleOpsApplication[]
  feedback: RecruiterRoleOpsFeedback[]
  questions: RecruiterRoleOpsQuestion[]
}): RecruiterRoleOpsRow[] {
  return input.jobs
    .filter((role) => role.recruiterBoard || role.wekruitCollaborationStatus === "collaborated")
    .map((role) => {
      const readiness = recruiterRoleReadiness(role)
      const roleSubmissions = input.submissions.filter((row) => rowMatchesRole(row, role))
      const roleCandidates = input.candidates.filter((row) => rowMatchesRole(row, role))
      const roleApplications = input.applications.filter((row) => rowMatchesRole(row, role))
      const roleFeedback = input.feedback.filter((row) => rowMatchesRole(row, role))
      const roleQuestions = input.questions.filter((row) => rowMatchesRole(row, role))
      const rbPriority = role.recruiterBoard?.priority
      const pRank = priorityRank(rbPriority?.rank)
      const pTier = priorityTier(rbPriority?.tier)
      const approvedRecruiters = new Set(
        roleApplications
          .filter((row) => row.status === "approved")
          .map((row) => row.recruiterId || row.recruiterEmail)
          .filter(Boolean),
      ).size
      const row = {
        id: role.id,
        publicId: role.publicId || role.id,
        title: role.title || role.id,
        company: role.recruiterBoard?.label?.company || "-",
        location: role.recruiterBoard?.label?.location || "-",
        active: role.recruiterBoard?.active === true,
        collaborated: role.wekruitCollaborationStatus === "collaborated",
        readinessScore: readiness.score,
        readinessLabel: readiness.label,
        readinessTone: readiness.tone,
        missingSetup: readiness.missing,
        updatedAtMs: Math.max(timestampToMs(role.recruiterBoard?.updatedAt), timestampToMs(role.updatedAt)),
        updatedAt: role.recruiterBoard?.updatedAt ?? role.updatedAt,
        sortOrder: Number(role.recruiterBoard?.sortOrder ?? 999),
        priorityRank: pRank,
        prioritySort: pRank ?? 9999,
        priorityTier: pTier,
        priorityTone: priorityTone(pTier),
        priorityNote: typeof rbPriority?.note === "string" ? rbPriority.note : "",
        priorityEmailAudience: priorityAudience(rbPriority?.emailAudience),
        priorityUpdatedAt: rbPriority?.updatedAt,
        hardChecks: recruiterBoardChecklistCount(role, "hard"),
        fitChecks: recruiterBoardChecklistCount(role, "fit"),
        bonusChecks: recruiterBoardChecklistCount(role, "bonus"),
        antiChecks: recruiterBoardChecklistCount(role, "anti"),
        approvedRecruiters,
        pendingApplications: roleApplications.filter((row) => (row.status ?? "pending") === "pending").length,
        sourced: roleCandidates.filter((row) => row.stage !== "archived").length,
        ready: roleCandidates.filter((row) => row.stage === "ready").length,
        submissions: roleSubmissions.length,
        pendingSubmissions: roleSubmissions.filter((row) => PENDING_SUBMISSION_STATUSES.includes(row.status ?? "submitted")).length,
        advanced: roleSubmissions.filter((row) => ADVANCED_SUBMISSION_STATUSES.includes(row.status ?? "")).length,
        rejectedOrDuplicate: roleSubmissions.filter((row) => NEGATIVE_SUBMISSION_STATUSES.includes(row.status ?? "")).length,
        openQuestions: roleQuestions.filter((row) => (row.status ?? "open") === "open").length,
        hardFeedback: roleFeedback.filter((row) => row.difficulty === "hard").length,
        blockedFeedback: roleFeedback.filter((row) => row.difficulty === "blocked").length,
        compSummary: role.compSummary,
        interviewProcess: role.recruiterBoard?.interviewProcess,
      }
      const activation = recruiterRoleActivation(row)
      return {
        ...row,
        activationStage: activation.stage,
        activationLabel: activation.label,
        activationTone: activation.tone,
        activationReason: activation.reason,
      }
    })
    .sort((a, b) =>
      Number(b.active) - Number(a.active) ||
      a.prioritySort - b.prioritySort ||
      a.sortOrder - b.sortOrder ||
      b.updatedAtMs - a.updatedAtMs,
    )
}
