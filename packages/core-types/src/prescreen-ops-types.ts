import type {
  PrescreenReviewQuestion,
  StrictReviewBucket,
} from "./prescreen-review-classification.js"
import type { PrescreenEngagementSignal } from "./prescreen-engagement.js"

/**
 * Shared contract for the `paAdminPrescreenOpsSnapshot` admin callable
 * (apps/functions/src/admin-prescreen-ops.ts). Both the Cloud Function and
 * the dashboard client import these types so the wire shape stays in sync.
 */

export type PrescreenOpsSessionCursor = {
  createdAt: string
  docId: string
}

export type PrescreenOpsQueueFilter = "pending" | "committed" | "all"

export type PrescreenOpsSnapshotInput =
  | { mode: "ops"; includeTest?: boolean }
  | {
    mode: "sessions"
    jobId?: string
    queue?: PrescreenOpsQueueFilter
    bucket?: string
    includeTest?: boolean
    limit?: number
    cursor?: PrescreenOpsSessionCursor
  }

export type PrescreenOpsTerminalCounts = {
  PASS: number
  FAIL: number
  HARD_STOP: number
  PAUSE: number
  IN_PROGRESS: number
}

export type PrescreenOpsCommittedCounts = {
  PASS: number
  FAIL: number
  HARD_STOP: number
}

export type PrescreenOpsBucketCounts = {
  top_five_pass: number
  batch_reject: number
  individual_review: number
  hard_stop: number
  paused: number
}

export type PrescreenOpsTotals = {
  /** Exact collection count() aggregate — never limited by the scan cap. */
  sessions: number
  realSessions: number
  testSessions: number
  inProgress: number
  byTerminal: PrescreenOpsTerminalCounts
  pendingHumanReview: number
  committed: PrescreenOpsCommittedCounts
  autoFinalizedNoReview: number
  strandedNoReview: number
  byBucket: PrescreenOpsBucketCounts
}

export type PrescreenOpsJobRollup = {
  jobId: string
  title: string
  company: string
  jobStatus: string
  sessionCount: number
  realSessionCount: number
  testSessionCount: number
  byTerminal: PrescreenOpsTerminalCounts
  pendingReview: number
  committed: PrescreenOpsCommittedCounts
  autoFinalized: number
  stranded: number
  byBucket: PrescreenOpsBucketCounts
  lastSessionAt: string
}

export type PrescreenOpsReviewState =
  | "pending"
  | "committed"
  | "auto_finalized"
  | "stranded"
  | "in_progress"
  | "paused"

export type PrescreenOpsSessionReview = {
  status?: string
  evaluationAttemptId?: string
  proposedTerminal?: string
  finalTerminal?: string
  pendingAckOutboundId?: string
  decisionOutboundId?: string
  candidateDecision?: Record<string, unknown>
  /** Advisory effort/engagement signal (review.engagementSignal). Never a gate. */
  engagementSignal?: PrescreenEngagementSignal
  [key: string]: unknown
}

export type PrescreenOpsSessionRow = {
  id: string
  userId: string
  jobId: string
  jobTitle?: string
  jobCompany?: string
  terminal: string | null
  terminalReason?: string
  score: number
  scoreMax: number
  threshold?: number
  createdAt: string
  updatedAt?: string
  terminalActionPendingReview?: boolean
  terminalActionFiredAt?: string
  evaluationAttemptId?: string
  review?: PrescreenOpsSessionReview
  questions?: Record<string, PrescreenReviewQuestion>
  classification: {
    bucket: Exclude<StrictReviewBucket, "all">
    label: string
    reasons: string[]
  }
  reviewState: PrescreenOpsReviewState
  candidateClass: string
}

export type PrescreenOpsSnapshotOpsResponse = {
  generatedAt: string
  scanned: number
  truncated: boolean
  totals: PrescreenOpsTotals
  jobs: PrescreenOpsJobRollup[]
}

export type PrescreenOpsSnapshotSessionsResponse = {
  rows: PrescreenOpsSessionRow[]
  nextCursor?: PrescreenOpsSessionCursor
}

export type PrescreenOpsSnapshotResponse =
  | PrescreenOpsSnapshotOpsResponse
  | PrescreenOpsSnapshotSessionsResponse
