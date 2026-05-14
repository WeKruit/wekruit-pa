/**
 * v2.0 External Supply V1 — Wave D — Per-batch records table.
 *
 * Renders one row per `ExternalCandidateRecord`. Supports loading / empty /
 * error / populated states. Header row + per-row delegating to `RecordRow`.
 */
import type { ExternalCandidateRecord } from "@pa/core-types"
import { EmptyState, ErrorState, LoadingState } from "../ui.js"
import { RecordRow, type RecordRowAction } from "./RecordRow.js"

export function BatchTable({
  records,
  loading,
  error,
  onAction,
}: {
  records: ExternalCandidateRecord[]
  loading?: boolean
  error?: string | null
  onAction?: (recordId: string, action: RecordRowAction) => void
}) {
  if (loading) return <LoadingState label="Loading records…" />
  if (error) return <ErrorState message={error} />
  if (records.length === 0) {
    return (
      <EmptyState
        title="No records"
        body="The batch normalized but no records were created. Re-upload or pick a different adapter."
      />
    )
  }

  return (
    <table style={{ width: "100%", fontSize: "0.85em", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
          <th style={{ padding: "0.5rem 0" }}>Record</th>
          <th style={{ padding: "0.5rem 0" }}>Name</th>
          <th style={{ padding: "0.5rem 0" }}>Current</th>
          <th style={{ padding: "0.5rem 0" }}>Email</th>
          <th style={{ padding: "0.5rem 0" }}>Links</th>
          <th style={{ padding: "0.5rem 0" }}>Status</th>
          <th style={{ padding: "0.5rem 0" }}>Candidate</th>
          <th style={{ padding: "0.5rem 0" }} />
        </tr>
      </thead>
      <tbody>
        {records.map((r) => (
          <RecordRow key={r.recordId} record={r} onAction={onAction} />
        ))}
      </tbody>
    </table>
  )
}
