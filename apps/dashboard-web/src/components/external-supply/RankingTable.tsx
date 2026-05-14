/**
 * v2.0 External Supply V2 — Wave D dashboard UX — agent-ranking review table.
 *
 * Bulk-select + bulk-approve UI over `RankingApprovalRow`. The table is
 * pure: parent owns rows + selection + busy flag + mutation callbacks.
 */
import type { EvaluationTier } from "@pa/core-types"
import { EmptyState, LoadingState } from "../ui.js"
import type { AgentRankingResult } from "../../lib/external-supply-client.js"
import { RankingApprovalRow } from "./RankingApprovalRow.js"

export function RankingTable({
  results,
  loading,
  selected,
  onToggleSelect,
  onToggleSelectAll,
  onApprove,
  onOverride,
  busyResultIds,
}: {
  results: AgentRankingResult[]
  loading?: boolean
  selected: Set<string>
  onToggleSelect: (resultId: string) => void
  onToggleSelectAll: (next: boolean) => void
  onApprove: (resultId: string) => void
  onOverride: (resultId: string, newTier: EvaluationTier, reason: string) => void
  busyResultIds?: Set<string>
}) {
  if (loading && results.length === 0) {
    return <LoadingState label="Loading agent ranking…" />
  }
  if (results.length === 0) {
    return (
      <EmptyState
        title="No agent ranking yet"
        body="Run agent ranking from the actions above. Dry-run is safe and writes nothing."
      />
    )
  }

  const allSelected = results.every((r) => selected.has(r.resultId))
  const someSelected = !allSelected && results.some((r) => selected.has(r.resultId))

  return (
    <div className="table-shell">
      <table style={tableStyle}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
            <th style={thStyle}>
              <input
                type="checkbox"
                aria-label="Select all"
                checked={allSelected}
                ref={(node) => {
                  if (node) node.indeterminate = someSelected
                }}
                onChange={(e) => onToggleSelectAll(e.target.checked)}
              />
            </th>
            <th style={thStyle}>Candidate</th>
            <th style={thStyle}>Deterministic tier</th>
            <th style={thStyle}>Proposed agent tier</th>
            <th style={thStyle}>Rationale</th>
            <th style={thStyle}>Risks</th>
            <th style={thStyle}>Action</th>
            <th style={thStyle}>Ensemble</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Approve</th>
            <th style={thStyle}>Override</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <RankingApprovalRow
              key={r.resultId}
              result={r}
              selected={selected.has(r.resultId)}
              onToggleSelect={onToggleSelect}
              onApprove={onApprove}
              onOverride={onOverride}
              busy={!!busyResultIds?.has(r.resultId)}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  fontSize: "0.85em",
  borderCollapse: "collapse",
}
const thStyle: React.CSSProperties = { padding: "0.5rem 0.3rem", fontSize: "0.78em" }
