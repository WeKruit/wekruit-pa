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

const bucketChips: Array<{
  value: Exclude<StrictReviewBucket, "all">
  label: string
  tone: "ok" | "warn" | "info" | "muted"
  count: (summary: PrescreenReviewSummary) => number
}> = [
  { value: "batch_reject", label: "likely reject", tone: "warn", count: (summary) => summary.batchReject },
  { value: "individual_review", label: "close review", tone: "info", count: (summary) => summary.individualReview },
  { value: "paused", label: "paused", tone: "muted", count: (summary) => summary.paused },
  { value: "top_five_pass", label: "top 5%", tone: "ok", count: (summary) => summary.topFivePass },
  { value: "hard_stop", label: "hard stop", tone: "warn", count: (summary) => summary.hardStop },
]

const queueSegments: Array<{ value: StrictReviewQueueFilter; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "committed", label: "Committed" },
  { value: "all", label: "All" },
]

const sortOptions: Array<{ value: StrictReviewSort; label: string }> = [
  { value: "strict_priority", label: "Strict priority" },
  { value: "score_desc", label: "Score high to low" },
  { value: "oldest", label: "Oldest first" },
  { value: "newest", label: "Newest first" },
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

export type PrescreenBulkAction = "reject" | "review"

const bulkActionOptions: Array<{ value: PrescreenBulkAction; label: string }> = [
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
  hasMore,
  visibleCount,
  selectedCount,
  pendingVisibleCount,
  onBucketChange,
  onQueueChange,
  onTerminalChange,
  onActionChange,
  onDraftChange,
  onSortChange,
  onSearchChange,
  onSelectVisible,
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
  hasMore: boolean
  visibleCount: number
  selectedCount: number
  pendingVisibleCount: number
  onBucketChange: (value: StrictReviewBucket) => void
  onQueueChange: (value: StrictReviewQueueFilter) => void
  onTerminalChange: (value: StrictReviewTerminalFilter) => void
  onActionChange: (value: StrictReviewActionFilter) => void
  onDraftChange: (value: StrictReviewDraftFilter) => void
  onSortChange: (value: StrictReviewSort) => void
  onSearchChange: (value: string) => void
  onSelectVisible: () => void
  onClearSelected: () => void
  onBulkActionChange: (value: PrescreenBulkAction) => void
  onRunBulkAction: () => void
}) {
  return (
    <div style={toolbarStyle}>
      <div style={summaryStyle} aria-label="Prescreen strict review summary">
        {bucketChips.map((chip) => {
          const active = bucket === chip.value
          return (
            <button
              key={chip.value}
              type="button"
              aria-pressed={active}
              onClick={() => onBucketChange(active ? "all" : chip.value)}
              style={chipStyle(active)}
            >
              <Badge tone={chip.tone}>{chip.count(summary)}{hasMore ? "+" : ""} {chip.label}</Badge>
            </button>
          )
        })}
        <span style={{ color: "#64748b", fontSize: "0.86em" }}>
          showing {visibleCount} of {summary.total}{hasMore ? "+" : ""} loaded · {selectedCount} selected
        </span>
        {hasMore ? (
          <span style={{ color: "#64748b", fontSize: "0.86em" }}>
            counts cover loaded rows — Load more to complete
          </span>
        ) : null}
      </div>
      <div style={controlsStyle}>
        <div role="group" aria-label="Filter review queue state" style={{ display: "inline-flex" }}>
          {queueSegments.map((segment, index) => (
            <button
              key={segment.value}
              type="button"
              aria-pressed={queue === segment.value}
              onClick={() => onQueueChange(segment.value)}
              style={segmentStyle(queue === segment.value, index, queueSegments.length)}
            >
              {segment.label}
            </button>
          ))}
        </div>
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
      <details>
        <summary style={advancedSummaryStyle}>Advanced filters</summary>
        <div style={{ ...controlsStyle, marginTop: 8 }}>
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
        </div>
      </details>
      {pendingVisibleCount > 0 ? (
        <div style={controlsStyle}>
          <button type="button" onClick={onSelectVisible} style={buttonStyle}>
            <CheckSquare size={14} aria-hidden />
            Select visible
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
      ) : null}
    </div>
  )
}

function chipStyle(active: boolean): CSSProperties {
  return {
    display: "inline-flex",
    border: active ? "1px solid #1e293b" : "1px solid transparent",
    borderRadius: 999,
    padding: 2,
    background: "none",
    cursor: "pointer",
  }
}

function segmentStyle(active: boolean, index: number, count: number): CSSProperties {
  return {
    padding: "0.35rem 0.8rem",
    fontSize: "0.85em",
    border: "1px solid #cbd5e1",
    borderRadius: index === 0 ? "6px 0 0 6px" : index === count - 1 ? "0 6px 6px 0" : 0,
    marginLeft: index === 0 ? 0 : -1,
    background: active ? "#1e293b" : "#fff",
    color: active ? "#fff" : "inherit",
    cursor: "pointer",
  }
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

const advancedSummaryStyle: CSSProperties = {
  color: "#64748b",
  fontSize: "0.86em",
  cursor: "pointer",
}

const buttonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
}
