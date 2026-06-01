export interface RecruiterApplicationReviewProfile {
  id: string
  email?: string
  firebaseUid?: string
  name?: string
  status?: string
}

export interface RecruiterApplicationReviewSubmission {
  id: string
  recruiterId?: string | null
  recruiterEmail?: string
  jobId?: string
  inboundJobId?: string
  status?: string
  recruiterFeedbackRating?: number | null
}

export interface RecruiterApplicationReviewCandidate {
  id: string
  candidateId?: string
  recruiterId?: string | null
  recruiterEmail?: string
  jobId?: string
  inboundJobId?: string
  stage?: string
  candidate?: {
    name?: string
    currentRole?: string
    yoe?: string
    notes?: string
  }
}

export interface RecruiterApplicationReviewApplication {
  id: string
  recruiterId?: string
  recruiterEmail?: string
  jobId?: string
  inboundJobId?: string
  jobTitleSnapshot?: string
  status?: "pending" | "approved" | "not_approved" | "withdrawn" | "rescinded"
  pitch?: string | null
  preparedCandidateIds?: string[]
  preparedCandidateCount?: number
}

export interface RoleApplicationPreparedCandidatePreview {
  id: string
  label: string
  headline: string
  stage: string
}

export interface RoleApplicationReview {
  recommendation: "approve" | "review" | "decline"
  tone: "ok" | "info" | "warn"
  headline: string
  rationale: string
  noteTemplate: string
  evidence: string[]
  risks: string[]
  preparedCandidates: RoleApplicationPreparedCandidatePreview[]
  metrics: {
    qualityScore: number
    avgRating: number | null
    interviewRate: number
    submissionsTotal: number
    preparedCandidates: number
    readyPreparedCandidates: number
    approvedRoles: number
    pendingApplications: number
    sameRoleApprovedRecruiters: number
  }
}

export function normalizeApplicationReviewRating(rating: unknown): number | null {
  const n = typeof rating === "number" ? rating : Number(rating)
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null
}

export function applicationReviewRecruiterMatches(
  row: { recruiterId?: string | null; recruiterEmail?: string },
  profile: RecruiterApplicationReviewProfile | null,
  application: RecruiterApplicationReviewApplication,
): boolean {
  const appEmail = application.recruiterEmail?.trim().toLowerCase()
  const profileEmail = profile?.email?.trim().toLowerCase()
  return Boolean(
    (application.recruiterId && row.recruiterId === application.recruiterId) ||
    (profile?.id && row.recruiterId === profile.id) ||
    (appEmail && row.recruiterEmail?.trim().toLowerCase() === appEmail) ||
    (profileEmail && row.recruiterEmail?.trim().toLowerCase() === profileEmail),
  )
}

export function applicationReviewJobKey(row: { inboundJobId?: string; jobId?: string }): string {
  return (row.inboundJobId || row.jobId || "").trim()
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function candidatePreview(candidate: RecruiterApplicationReviewCandidate): RoleApplicationPreparedCandidatePreview {
  const c = candidate.candidate ?? {}
  const headline = [c.currentRole, c.yoe ? `${c.yoe} exp` : ""].filter(Boolean).join(" · ")
  return {
    id: candidate.id,
    label: c.name || c.currentRole || "Prepared candidate",
    headline: headline || c.notes || "No candidate background supplied.",
    stage: candidate.stage || "sourced",
  }
}

export function buildRoleApplicationReview(input: {
  application: RecruiterApplicationReviewApplication
  profiles: RecruiterApplicationReviewProfile[]
  submissions: RecruiterApplicationReviewSubmission[]
  candidates: RecruiterApplicationReviewCandidate[]
  applications: RecruiterApplicationReviewApplication[]
}): RoleApplicationReview {
  const { application, profiles, submissions, candidates, applications } = input
  const appEmail = application.recruiterEmail?.trim().toLowerCase()
  const profile = profiles.find((p) =>
    (application.recruiterId && p.id === application.recruiterId) ||
    (appEmail && p.email?.trim().toLowerCase() === appEmail),
  ) ?? null
  const recruiterSubmissions = submissions.filter((row) => applicationReviewRecruiterMatches(row, profile, application))
  const recruiterCandidates = candidates.filter((row) => applicationReviewRecruiterMatches(row, profile, application))
  const recruiterApplications = applications.filter((row) => applicationReviewRecruiterMatches(row, profile, application))
  const roleKey = applicationReviewJobKey(application)
  const preparedIds = new Set((application.preparedCandidateIds ?? []).filter(Boolean))
  const preparedCandidateRows = recruiterCandidates
    .filter((candidate) =>
      preparedIds.has(candidate.id) ||
      (candidate.candidateId ? preparedIds.has(candidate.candidateId) : false) ||
      (!preparedIds.size && roleKey && applicationReviewJobKey(candidate) === roleKey && candidate.stage !== "archived"),
    )
    .slice(0, 6)
  const preparedCandidateCount = application.preparedCandidateCount ?? (preparedIds.size || preparedCandidateRows.length)
  const readyPreparedCandidates = preparedCandidateRows.filter((candidate) => candidate.stage === "ready" || candidate.stage === "submitted").length
  const ratings = recruiterSubmissions
    .map((submission) => normalizeApplicationReviewRating(submission.recruiterFeedbackRating))
    .filter((rating): rating is number => rating !== null)
  const avgRating = ratings.length ? ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length : null
  const advancedCount = recruiterSubmissions.filter((submission) => ["advanced", "interviewing", "hired"].includes(submission.status ?? "")).length
  const negativeCount = recruiterSubmissions.filter((submission) => ["rejected", "duplicate"].includes(submission.status ?? "")).length
  const interviewRate = recruiterSubmissions.length ? Math.round((advancedCount / recruiterSubmissions.length) * 100) : 0
  const rejectionRate = recruiterSubmissions.length ? Math.round((negativeCount / recruiterSubmissions.length) * 100) : 0
  const approvedRoleIds = new Set(recruiterApplications.filter((row) => row.status === "approved").map(applicationReviewJobKey).filter(Boolean))
  const pendingApplications = recruiterApplications.filter((row) => row.id !== application.id && (row.status ?? "pending") === "pending").length
  const sameRoleApprovedRecruiters = roleKey
    ? applications.filter((row) => row.id !== application.id && row.status === "approved" && applicationReviewJobKey(row) === roleKey).length
    : 0
  const ratingScore = avgRating !== null ? (avgRating / 4) * 48 : recruiterSubmissions.length ? 18 : 28
  const movementScore = Math.min(24, interviewRate * 0.48)
  const proofScore = Math.min(18, preparedCandidateCount * 8 + readyPreparedCandidates * 4)
  const loadPenalty = Math.min(18, approvedRoleIds.size * 1.5 + pendingApplications * 4 + Math.max(0, sameRoleApprovedRecruiters - 5) * 3)
  const rejectionPenalty = Math.min(24, rejectionRate * 0.24)
  const disabledPenalty = profile?.status === "disabled" ? 55 : 0
  const qualityScore = clamp(Math.round(ratingScore + movementScore + proofScore - loadPenalty - rejectionPenalty - disabledPenalty), 0, 100)
  const evidence = [
    avgRating !== null ? `Average candidate rating ${avgRating.toFixed(1)}/4` : "No rated submissions yet",
    `${interviewRate}% interview or advanced rate`,
    `${preparedCandidateCount} prepared candidate${preparedCandidateCount === 1 ? "" : "s"}`,
    `${approvedRoleIds.size}/10 approved role load`,
    `${sameRoleApprovedRecruiters} recruiter${sameRoleApprovedRecruiters === 1 ? "" : "s"} already approved on this role`,
  ]
  const risks: string[] = []
  if (profile?.status === "disabled") risks.push("Recruiter account is disabled.")
  if (pendingApplications >= 3) risks.push("Recruiter already has three other pending role applications.")
  if (approvedRoleIds.size >= 10) risks.push("Recruiter is at the approved role limit.")
  if (sameRoleApprovedRecruiters >= 8) risks.push("This role may already have enough recruiter coverage.")
  if (recruiterSubmissions.length >= 3 && avgRating !== null && avgRating < 2.5) risks.push("Average candidate rating is below the approval bar.")
  if (recruiterSubmissions.length >= 3 && rejectionRate >= 60) risks.push("Recent submission outcomes skew rejected or duplicate.")
  if (!preparedCandidateCount && qualityScore < 70) risks.push("No prepared candidate proof attached.")

  const recommendation: RoleApplicationReview["recommendation"] =
    risks.some((risk) => risk.includes("disabled") || risk.includes("role limit") || risk.includes("below the approval bar"))
      ? "decline"
      : qualityScore >= 72 || readyPreparedCandidates > 0 || (preparedCandidateCount > 0 && !risks.length)
        ? "approve"
        : "review"
  const tone: RoleApplicationReview["tone"] = recommendation === "approve" ? "ok" : recommendation === "decline" ? "warn" : "info"
  const roleTitle = application.jobTitleSnapshot || "this role"
  const headline =
    recommendation === "approve" ? "Approve for trusted role coverage" :
    recommendation === "decline" ? "Do not approve without stronger proof" :
    "Needs operator calibration before decision"
  const rationale =
    recommendation === "approve"
      ? "The recruiter has enough track record or prepared candidate proof to justify active coverage."
      : recommendation === "decline"
        ? "The current quality, capacity, or account-risk signal is too weak for trusted access."
        : "The application needs a human check because the proof is incomplete or mixed."
  const noteTemplate =
    recommendation === "approve"
      ? `Approved for ${roleTitle}. Please actively source against the hard checks and keep candidates updated in your tracker.`
      : recommendation === "decline"
        ? `Not approved for ${roleTitle} yet. Please attach stronger candidate proof or improve submission quality before reapplying.`
        : `Holding ${roleTitle} for now. Please add prepared candidates or clarify your sourcing lane before we approve this role.`

  return {
    recommendation,
    tone,
    headline,
    rationale,
    noteTemplate,
    evidence,
    risks,
    preparedCandidates: preparedCandidateRows.map(candidatePreview),
    metrics: {
      qualityScore,
      avgRating,
      interviewRate,
      submissionsTotal: recruiterSubmissions.length,
      preparedCandidates: preparedCandidateCount,
      readyPreparedCandidates,
      approvedRoles: approvedRoleIds.size,
      pendingApplications,
      sameRoleApprovedRecruiters,
    },
  }
}
