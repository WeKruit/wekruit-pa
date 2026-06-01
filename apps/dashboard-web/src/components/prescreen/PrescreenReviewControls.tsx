import type { CSSProperties } from "react"
import { ArrowDownUp, CheckSquare, Filter, Search } from "lucide-react"
import { Badge } from "../ui.js"
import type {
  PrescreenReviewClassification,
  PrescreenReviewSummary,
  StrictReviewActionFilter,
  StrictReviewBucket,
  StrictReviewDraftFilter,
  StrictReviewQueueFilter,
  StrictReviewSort,
  StrictReviewTerminalFilter,
} from "../../lib/prescreen-review-ranking.js"

const bucketOptions: Array<{ value: StrictReviewBucket; label: string }> = [
  { value: "all", label: "All review rows" },
  { value: "batch_reject", label: "Likely rejects" },
  { value: "individual_review", label: "Needs close review" },
  { value: "paused", label: "Paused low confidence" },
  { value: "top_five_pass", label: "Top 5% pass" },
  { value: "hard_stop", label: "Hard stops" },
]

const sortOptions: Array<{ value: StrictReviewSort; label: string }> = [
  { value: "strict_priority", label: "Strict priority" },
  { value: "score_desc", label: "Score high to low" },
  { value: "oldest", label: "Oldest first" },
  { value: "newest", label: "Newest first" },
]

const queueOptions: Array<{ value: StrictReviewQueueFilter; label: string }> = [
  { value: "pending", label: "Pending review" },
  { value: "committed", label: "Committed" },
  { value: "all", label: "All sessions" },
]

const terminalOptions: Array<{ value: StrictReviewTerminalFilter; label: string }> = [
  { value: "all", label: "Any Claire terminal" },
  { value: "PASS", label: "Claire PASS" },
  { value: "FAIL", label: "Claire FAIL" },
  { value: "HARD_STOP", label: "Claire HARD_STOP" },
  { value: "PAUSE", label: "Claire PAUSE" },
  { value: "IN_PROGRESS", label: "In progress" },
]

const actionOptions: Array<{ value: StrictReviewActionFilter; label: string }> = [
  { value: "all", label: "Any final target" },
  { value: "PASS", label: "Final PASS target" },
  { value: "FAIL", label: "Final FAIL target" },
  { value: "HARD_STOP", label: "Final HARD_STOP target" },
]

const draftOptions: Array<{ value: StrictReviewDraftFilter; label: string }> = [
  { value: "all", label: "Any draft status" },
  { value: "has_decision", label: "Has decision" },
  { value: "missing_decision", label: "Missing decision" },
]

export type PrescreenBulkAction = "draft" | "reject" | "review"

const bulkActionOptions: Array<{ value: PrescreenBulkAction; label: string }> = [
  { value: "draft", label: "Draft selected" },
  { value: "reject", label: "Reject selected" },
  { value: "review", label: "Review individually" },
]

export function StrictReviewBadge({ classification }: { classification: PrescreenReviewClassification }) {
  return <Badge tone={classification.tone}>{classification.label}</Badge>
}

export function PrescreenReviewToolbar({
  bucket,
  queue,
  terminal,
  action,
  draft,
  sort,
  search,
  bulkAction,
  summary,
  visibleCount,
  selectedCount,
  onBucketChange,
  onQueueChange,
  onTerminalChange,
  onActionChange,
  onDraftChange,
  onSortChange,
  onSearchChange,
  onSelectVisible,
  onSelectLikelyRejects,
  onSelectHardStops,
  onSelectCloseReview,
  onClearSelected,
  onBulkActionChange,
  onRunBulkAction,
}: {
  bucket: StrictReviewBucket
  queue: StrictReviewQueueFilter
  terminal: StrictReviewTerminalFilter
  action: StrictReviewActionFilter
  draft: StrictReviewDraftFilter
  sort: StrictReviewSort
  search: string
  bulkAction: PrescreenBulkAction
  summary: PrescreenReviewSummary
  visibleCount: number
  selectedCount: number
  onBucketChange: (value: StrictReviewBucket) => void
  onQueueChange: (value: StrictReviewQueueFilter) => void
  onTerminalChange: (value: StrictReviewTerminalFilter) => void
  onActionChange: (value: StrictReviewActionFilter) => void
  onDraftChange: (value: StrictReviewDraftFilter) => void
  onSortChange: (value: StrictReviewSort) => void
  onSearchChange: (value: string) => void
  onSelectVisible: () => void
  onSelectLikelyRejects: () => void
  onSelectHardStops: () => void
  onSelectCloseReview: () => void
  onClearSelected: () => void
  onBulkActionChange: (value: PrescreenBulkAction) => void
  onRunBulkAction: () => void
}) {
  return (
    <div style={toolbarStyle}>
      <div style={summaryStyle} aria-label="Prescreen strict review summary">
        <Badge tone="warn">{summary.batchReject} likely reject</Badge>
        <Badge tone="info">{summary.individualReview} close review</Badge>
        <Badge tone="muted">{summary.paused} paused</Badge>
        <Badge tone="ok">{summary.topFivePass} top 5%</Badge>
        <Badge tone="warn">{summary.hardStop} hard stop</Badge>
        <span style={{ color: "#64748b", fontSize: "0.86em" }}>
          showing {visibleCount}/{summary.total} · {selectedCount} selected
        </span>
      </div>
      <div style={controlsStyle}>
        <label style={fieldStyle}>
          <Filter size={14} aria-hidden />
          <select
            value={queue}
            onChange={(event) => onQueueChange(event.target.value as StrictReviewQueueFilter)}
            style={inputStyle}
            aria-label="Filter review queue state"
          >
            {queueOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label style={fieldStyle}>
          <Filter size={14} aria-hidden />
          <select
            value={bucket}
            onChange={(event) => onBucketChange(event.target.value as StrictReviewBucket)}
            style={inputStyle}
            aria-label="Filter prescreen rows"
          >
            {bucketOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label style={fieldStyle}>
          <Filter size={14} aria-hidden />
          <select
            value={terminal}
            onChange={(event) => onTerminalChange(event.target.value as StrictReviewTerminalFilter)}
            style={inputStyle}
            aria-label="Filter Claire terminal"
          >
            {terminalOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label style={fieldStyle}>
          <Filter size={14} aria-hidden />
          <select
            value={action}
            onChange={(event) => onActionChange(event.target.value as StrictReviewActionFilter)}
            style={inputStyle}
            aria-label="Filter final action target"
          >
            {actionOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label style={fieldStyle}>
          <Filter size={14} aria-hidden />
          <select
            value={draft}
            onChange={(event) => onDraftChange(event.target.value as StrictReviewDraftFilter)}
            style={inputStyle}
            aria-label="Filter draft status"
          >
            {draftOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label style={fieldStyle}>
          <ArrowDownUp size={14} aria-hidden />
          <select
            value={sort}
            onChange={(event) => onSortChange(event.target.value as StrictReviewSort)}
            style={inputStyle}
            aria-label="Sort prescreen rows"
          >
            {sortOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label style={{ ...fieldStyle, minWidth: 220, flex: 1 }}>
          <Search size={14} aria-hidden />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search session, user, job, reason"
            style={inputStyle}
            aria-label="Search prescreen rows"
          />
        </label>
      </div>
      <div style={controlsStyle}>
        <button type="button" onClick={onSelectVisible} style={buttonStyle}>
          <CheckSquare size={14} aria-hidden />
          Select visible
        </button>
        <button type="button" onClick={onSelectLikelyRejects} style={buttonStyle}>
          <CheckSquare size={14} aria-hidden />
          Select likely rejects
        </button>
        <button type="button" onClick={onSelectHardStops} style={buttonStyle}>
          <CheckSquare size={14} aria-hidden />
          Select hard stops
        </button>
        <button type="button" onClick={onSelectCloseReview} style={buttonStyle}>
          <CheckSquare size={14} aria-hidden />
          Select close-review
        </button>
        <button type="button" onClick={onClearSelected} style={buttonStyle}>
          Clear selected
        </button>
        <label style={fieldStyle}>
          Bulk action
          <select
            value={bulkAction}
            onChange={(event) => onBulkActionChange(event.target.value as PrescreenBulkAction)}
            style={inputStyle}
            aria-label="Bulk action"
          >
            {bulkActionOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={onRunBulkAction} disabled={selectedCount === 0} style={buttonStyle}>
          Run bulk action
        </button>
      </div>
    </div>
  )
}

const toolbarStyle: CSSProperties = {
  display: "grid",
  gap: 10,
  marginBottom: 14,
}

const summaryStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  alignItems: "center",
}

const controlsStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  alignItems: "center",
}

const fieldStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  minWidth: 170,
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  padding: "0.35rem 0.45rem",
  background: "#fff",
  color: "#64748b",
}

const inputStyle: CSSProperties = {
  border: 0,
  outline: "none",
  width: "100%",
  background: "transparent",
  fontSize: "0.9em",
  color: "#1f2937",
}

const buttonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
}
