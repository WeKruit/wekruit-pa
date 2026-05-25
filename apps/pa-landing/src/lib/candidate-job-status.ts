export type CandidateJobStatus =
  | "recommended"
  | "invited"
  | "interview_started"
  | "review_pending"
  | "passed"
  | "not_passed"
  | "paused"

export type CandidateJobStatusTone = "neutral" | "active" | "positive" | "muted"

export type CandidateJobStatusDisplay = {
  label: string
  nextStep: string
  tone: CandidateJobStatusTone
  ctaLabel: string
}

export function getCandidateJobStatusDisplay(
  status: CandidateJobStatus,
  jobTitle = "this role"
): CandidateJobStatusDisplay {
  const role = cleanRole(jobTitle)
  switch (status) {
    case "recommended":
      return {
        label: "Recommended",
        nextStep: "Review the role and start Claire's first interview when ready.",
        tone: "neutral",
        ctaLabel: "Review role",
      }
    case "invited":
      return {
        label: "Invited",
        nextStep: "Claire is ready to run the first interview for this role.",
        tone: "active",
        ctaLabel: "Start interview",
      }
    case "interview_started":
      return {
        label: "Interview started",
        nextStep: "Continue in iMessage when you are ready to finish the first interview.",
        tone: "active",
        ctaLabel: "Continue interview",
      }
    case "review_pending":
      return {
        label: "Reviewing",
        nextStep: "WeKruit is reviewing your first screen. We’ll text you the next step here.",
        tone: "active",
        ctaLabel: "View role",
      }
    case "passed":
      return {
        label: "Passed",
        nextStep: "You passed Claire's first screen. WeKruit will keep your profile ready for the next step.",
        tone: "positive",
        ctaLabel: "View role",
      }
    case "not_passed":
      return {
        label: "Not passed",
        nextStep: `This first screen for ${role} was not a fit. Your WeKruit profile stays active for stronger matches.`,
        tone: "muted",
        ctaLabel: "View role",
      }
    case "paused":
      return {
        label: "Paused",
        nextStep: "This role is paused for review. Your broader WeKruit profile remains active.",
        tone: "muted",
        ctaLabel: "View role",
      }
  }
}

function cleanRole(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : "this role"
}
