import type { CSSProperties } from "react"
import { ArrowDownUp, CheckSquare, Filter, Search } from "lucide-react"
import { Badge } from "../ui.js"
import type {
  PrescreenReviewClassification,
  PrescreenReviewSummary,
  StrictReviewBucket,
  StrictReviewSort,
} from "../../lib/prescreen-review-ranking.js"

const bucketOptions: Array<{ value: StrictReviewBucket; label: string }> = [
  { value: "all", label: "All review rows" },
  { value: "batch_reject", label: "Likely rejects" },
  { value: "individual_review", label: "Needs close review" },
  { value: "top_five_pass", label: "Top 5% pass" },
  { value: "hard_stop", label: "Hard stops" },
]

const sortOptions: Array<{ value: StrictReviewSort; label: string }> = [
  { value: "strict_priority", label: "Strict priority" },
  { value: "score_desc", label: "Score high to low" },
  { value: "oldest", label: "Oldest first" },
  { value: "newest", label: "Newest first" },
]

export function StrictReviewBadge({ classification }: { classification: PrescreenReviewClassification }) {
  return <Badge tone={classification.tone}>{classification.label}</Badge>
}

export function PrescreenReviewToolbar({
  bucket,
  sort,
  search,
  summary,
  visibleCount,
  selectedCount,
  onBucketChange,
  onSortChange,
  onSearchChange,
  onSelectLikelyRejects,
}: {
  bucket: StrictReviewBucket
  sort: StrictReviewSort
  search: string
  summary: PrescreenReviewSummary
  visibleCount: number
  selectedCount: number
  onBucketChange: (value: StrictReviewBucket) => void
  onSortChange: (value: StrictReviewSort) => void
  onSearchChange: (value: string) => void
  onSelectLikelyRejects: () => void
}) {
  return (
    <div style={toolbarStyle}>
      <div style={summaryStyle} aria-label="Prescreen strict review summary">
        <Badge tone="warn">{summary.batchReject} likely reject</Badge>
        <Badge tone="info">{summary.individualReview} close review</Badge>
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
        <button type="button" onClick={onSelectLikelyRejects} style={buttonStyle}>
          <CheckSquare size={14} aria-hidden />
          Select likely rejects
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
