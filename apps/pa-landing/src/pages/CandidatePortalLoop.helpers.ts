import type { CandidateJobStatus } from "../lib/candidate-job-status.js"

export type CandidateOperatingLoopState =
  | "action_needed"
  | "in_review"
  | "roles_to_review"
  | "intro_signal"
  | "profile_active"

export type CandidateOperatingLoopTone = "live" | "blue" | "green" | "muted"

export type CandidateOperatingLoopStat = {
  label: "New roles" | "Interview" | "Review" | "Feedback" | "Retained"
  value: string
  detail: string
  tone: CandidateOperatingLoopTone
}

export type CandidateOperatingLoop = {
  state: CandidateOperatingLoopState
  primaryLabel: string
  body: string
  nextAction: string
  stats: CandidateOperatingLoopStat[]
}

export type CandidateOperatingLoopMatch = {
  status: CandidateJobStatus
}

export function deriveCandidateOperatingLoop(
  matches: CandidateOperatingLoopMatch[],
): CandidateOperatingLoop {
  const counts = {
    recommended: countByStatus(matches, ["recommended"]),
    interview: countByStatus(matches, ["invited", "interview_started"]),
    review: countByStatus(matches, ["review_pending", "passed"]),
    feedback: countByStatus(matches, ["intro_accepted", "intro_rejected"]),
    retained: countByStatus(matches, ["not_passed", "paused"]),
  }
  const stats: CandidateOperatingLoopStat[] = [
    {
      label: "New roles",
      value: String(counts.recommended),
      detail: "Ready to review",
      tone: counts.recommended > 0 ? "blue" : "muted",
    },
    {
      label: "Interview",
      value: String(counts.interview),
      detail: "Waiting or in progress",
      tone: counts.interview > 0 ? "live" : "muted",
    },
    {
      label: "Review",
      value: String(counts.review),
      detail: "WeKruit-side review",
      tone: counts.review > 0 ? "green" : "muted",
    },
    {
      label: "Feedback",
      value: String(counts.feedback),
      detail: "Intro outcomes captured",
      tone: counts.feedback > 0 ? "green" : "muted",
    },
    {
      label: "Retained",
      value: String(counts.retained),
      detail: "Closed role history",
      tone: "muted",
    },
  ]

  if (counts.interview > 0) {
    return {
      state: "action_needed",
      primaryLabel: "Interview action",
      body: `${counts.interview} ${roleWord(counts.interview)} ${beWord(counts.interview)} waiting for Claire's first interview or already in progress.`,
      nextAction: "Use Up next to start or continue the first interview.",
      stats,
    }
  }

  if (counts.review > 0) {
    return {
      state: "in_review",
      primaryLabel: "WeKruit review",
      body: `${counts.review} ${roleWord(counts.review)} ${beWord(counts.review)} in WeKruit-side review or already passed Claire's first screen.`,
      nextAction: "Check Recent activity and pipeline rows for candidate-visible updates.",
      stats,
    }
  }

  if (counts.recommended > 0) {
    return {
      state: "roles_to_review",
      primaryLabel: "Roles to review",
      body: `${counts.recommended} new ${roleWord(counts.recommended)} ${beWord(counts.recommended)} ready for you to review.`,
      nextAction: "Open New roles and choose what Claire should pursue.",
      stats,
    }
  }

  if (counts.feedback > 0) {
    return {
      state: "intro_signal",
      primaryLabel: "Intro feedback",
      body: `${counts.feedback} intro ${counts.feedback === 1 ? "outcome" : "outcomes"} captured after passed-profile sharing.`,
      nextAction: "Claire and WeKruit use this signal for future matching while your profile stays active.",
      stats,
    }
  }

  return {
    state: "profile_active",
    primaryLabel: "Profile active",
    body:
      counts.retained > 0
        ? `${counts.retained} closed ${roleWord(counts.retained)} stay in history while your profile stays active.`
        : "No role needs action right now. Keep preferences current so future matches stay aligned.",
    nextAction: "Review matching preferences if your target changed.",
    stats,
  }
}

function countByStatus(
  matches: CandidateOperatingLoopMatch[],
  statuses: CandidateJobStatus[],
): number {
  return matches.filter((match) => statuses.includes(match.status)).length
}

function roleWord(count: number): string {
  return count === 1 ? "role" : "roles"
}

function beWord(count: number): string {
  return count === 1 ? "is" : "are"
}
