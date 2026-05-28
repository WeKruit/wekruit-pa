const CANDIDATE_HOST = "https://wekruit.com"

export type JobLifecycleLike = {
  jobId: string
  publicVisible?: boolean
  candidatePageStatus?: "draft" | "ready" | "published"
  wekruitCollaborationStatus?: "collaborated" | "not_collaborated"
}

export type JobLifecycleDisplay = {
  pageLabel: string
  pageTone: "public" | "review" | "draft"
  candidateHref: string | null
  collaborationLabel: "WeKruit collaborated" | null
}

export function candidateJobPageUrl(jobId: string): string {
  return `${CANDIDATE_HOST}/j/${encodeURIComponent(jobId)}`
}

export function deriveJobLifecycleDisplay(job: JobLifecycleLike): JobLifecycleDisplay {
  const isPublished = job.publicVisible === true && job.candidatePageStatus === "published"
  const isReview = job.publicVisible === true || job.candidatePageStatus === "ready"
  return {
    pageLabel: isPublished ? "Live candidate page" : isReview ? "Ready for review" : "Draft",
    pageTone: isPublished ? "public" : isReview ? "review" : "draft",
    candidateHref: isPublished ? candidateJobPageUrl(job.jobId) : null,
    collaborationLabel:
      job.wekruitCollaborationStatus === "collaborated" ? "WeKruit collaborated" : null,
  }
}
