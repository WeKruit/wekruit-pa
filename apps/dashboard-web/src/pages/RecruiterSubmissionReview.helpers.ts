export type SubmissionReviewTone = "ok" | "warn" | "info" | "muted"

export interface SubmissionReviewChecklistItem {
  id?: string
  text?: string
}

export interface SubmissionReviewChecklistGroup {
  kind?: string
  heading?: string
  items?: SubmissionReviewChecklistItem[]
}

export interface SubmissionReviewRole {
  recruiterBoard?: {
    checklist?: {
      groups?: SubmissionReviewChecklistGroup[]
    }
  }
}

export interface SubmissionReviewSubmission {
  checklist?: Record<string, boolean>
  candidateConsentStatus?: string
  status?: string
  recruiterFeedbackNote?: string | null
  recruiterFeedbackRating?: number | null
  recruiterFeedbackReasons?: string[]
}

export interface SubmissionChecklistReviewItem {
  id: string
  text: string
  checked: boolean
}

export interface SubmissionChecklistReviewGroup {
  kind: string
  heading: string
  checked: number
  total: number
  items: SubmissionChecklistReviewItem[]
}

export interface SubmissionChecklistReview {
  groups: SubmissionChecklistReviewGroup[]
  missingHard: SubmissionChecklistReviewItem[]
  antiFlags: SubmissionChecklistReviewItem[]
  orphanCheckedIds: string[]
  checkedTotal: number
  total: number
  hasReadableChecklist: boolean
}

export interface SubmissionAdminReviewSummary {
  title: string
  body: string
  tone: SubmissionReviewTone
}

function checklistItemKey(item: SubmissionReviewChecklistItem): string {
  return item.id?.trim() || item.text?.trim() || ""
}

export function buildSubmissionChecklistReview(
  submission: SubmissionReviewSubmission,
  role: SubmissionReviewRole | null | undefined,
): SubmissionChecklistReview {
  const checkedMap = submission.checklist ?? {}
  const known = new Set<string>()
  const groups = (role?.recruiterBoard?.checklist?.groups ?? [])
    .map((group): SubmissionChecklistReviewGroup | null => {
      const items = (group.items ?? [])
        .map((item): SubmissionChecklistReviewItem | null => {
          const id = checklistItemKey(item)
          const text = item.text?.trim() || item.id?.trim() || ""
          if (!id || !text) return null
          known.add(id)
          return { id, text, checked: checkedMap[id] === true }
        })
        .filter((item): item is SubmissionChecklistReviewItem => Boolean(item))
      if (!items.length) return null
      return {
        kind: group.kind?.trim() || "other",
        heading: group.heading?.trim() || group.kind?.trim() || "Checklist",
        checked: items.filter((item) => item.checked).length,
        total: items.length,
        items,
      }
    })
    .filter((group): group is SubmissionChecklistReviewGroup => Boolean(group))
  const missingHard = groups
    .filter((group) => group.kind === "hard")
    .flatMap((group) => group.items.filter((item) => !item.checked))
  const antiFlags = groups
    .filter((group) => group.kind === "anti")
    .flatMap((group) => group.items.filter((item) => item.checked))
  const orphanCheckedIds = Object.entries(checkedMap)
    .filter(([id, checked]) => checked === true && !known.has(id))
    .map(([id]) => id)
    .sort()
  const checkedTotal = groups.reduce((sum, group) => sum + group.checked, 0)
  const total = groups.reduce((sum, group) => sum + group.total, 0)
  return {
    groups,
    missingHard,
    antiFlags,
    orphanCheckedIds,
    checkedTotal,
    total,
    hasReadableChecklist: groups.length > 0,
  }
}

export function buildSubmissionAdminReviewSummary(
  submission: SubmissionReviewSubmission,
  checklistReview: SubmissionChecklistReview,
): SubmissionAdminReviewSummary {
  const status = submission.status ?? "submitted"
  if (submission.candidateConsentStatus === "pending_candidate_confirmation") {
    return {
      title: "Await candidate consent",
      body: "Do not advance until the candidate confirms the recruiter submission, unless WeKruit manually verifies consent.",
      tone: "info",
    }
  }
  if (submission.candidateConsentStatus === "confirmation_email_failed") {
    return {
      title: "Consent email failed",
      body: "Fix or resend candidate confirmation before treating the packet as review-ready.",
      tone: "warn",
    }
  }
  if (checklistReview.missingHard.length > 0) {
    return {
      title: "Hard proof missing",
      body: `${checklistReview.missingHard.length} hard requirement${checklistReview.missingHard.length === 1 ? "" : "s"} still need evidence before this should move forward.`,
      tone: "warn",
    }
  }
  if (checklistReview.antiFlags.length > 0) {
    return {
      title: "Anti-signal flagged",
      body: `${checklistReview.antiFlags.length} anti-signal${checklistReview.antiFlags.length === 1 ? "" : "s"} were marked. Add recruiter-visible feedback before closing or parking the candidate.`,
      tone: "warn",
    }
  }
  if (["advanced", "interviewing", "offer", "hired"].includes(status)) {
    return {
      title: "Candidate is moving",
      body: "Keep the recruiter tracker current with status and feedback so the recruiter can keep the candidate warm.",
      tone: "ok",
    }
  }
  if (["rejected", "duplicate"].includes(status)) {
    return {
      title: "Closed with feedback",
      body: "Make sure the recruiter-visible note explains what to adjust before they submit lookalikes.",
      tone: submission.recruiterFeedbackNote ? "muted" : "warn",
    }
  }
  if (submission.recruiterFeedbackNote || submission.recruiterFeedbackRating || submission.recruiterFeedbackReasons?.length) {
    return {
      title: "Feedback drafted",
      body: "Status and recruiter-visible feedback exist. Save any final note before moving this row out of review.",
      tone: "info",
    }
  }
  return {
    title: "Ready for WeKruit review",
    body: "The packet has readable evidence. Choose a status, rating, reasons, and a recruiter-visible note.",
    tone: "info",
  }
}
