/**
 * v2.0 External Supply V1 — Wave D — `/admin/external-supply/batches/:batchId`.
 *
 * Stats header + records table + two bulk actions:
 *   - "Resolve identity" → calls `resolveBatchIdentity({ batchId })`.
 *   - "Run evaluation" → opens an inline dialog for companyId + jobId, then
 *     calls `runEvaluation({ batchId, companyId, jobId })`.
 *
 * Per-row actions are stubbed via `RecordRow.onAction` (view audit / view
 * conflict).
 */
import { useEffect, useMemo, useState } from "react"
import { Link, useParams, useNavigate } from "react-router-dom"
import type { ExternalCandidateRecord, ExternalSourcingBatch } from "@pa/core-types"
import { ErrorState, LoadingState, PageHeader, Panel } from "../../components/ui.js"
import { BatchTable } from "../../components/external-supply/BatchTable.js"
import {
  getBatch,
  listBatchRecords,
  resolveBatchIdentity,
  runEvaluation,
} from "../../lib/external-supply-client.js"
// P2.5b — CSV export of batch records, client-side download.
import { downloadBatchCsv, type ExternalCandidateRecordRowWithRaw } from "./batch-csv-export.js"

export function BatchDetail() {
  const { batchId } = useParams<{ batchId: string }>()
  const navigate = useNavigate()
  const [batch, setBatch] = useState<ExternalSourcingBatch | null>(null)
  const [records, setRecords] = useState<ExternalCandidateRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState<"resolve" | "evaluate" | null>(null)
  const [showEvalDialog, setShowEvalDialog] = useState(false)
  const [evalCompanyId, setEvalCompanyId] = useState("")
  const [evalJobId, setEvalJobId] = useState("")

  useEffect(() => {
    if (!batchId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([getBatch(batchId), listBatchRecords({ batchId, limit: 500 })])
      .then(([b, recs]) => {
        if (cancelled) return
        setBatch(b)
        setRecords(recs.rows)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [batchId, refreshKey])

  const counts = useMemo(() => groupCounts(records), [records])

  async function doResolve() {
    if (!batchId) return
    setActionBusy("resolve")
    setActionMsg(null)
    try {
      const res = await resolveBatchIdentity({ batchId })
      setActionMsg(
        `Resolved · processed=${res.processed} created=${res.created} merged=${res.merged} pending=${res.pending} blocked=${res.blocked} skipped=${res.skipped}`,
      )
      setRefreshKey((n) => n + 1)
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setActionBusy(null)
    }
  }

  async function doEvaluate() {
    if (!batchId) return
    if (!evalCompanyId.trim() || !evalJobId.trim()) {
      setActionMsg("companyId and jobId are required")
      return
    }
    setActionBusy("evaluate")
    setActionMsg(null)
    try {
      const res = await runEvaluation({
        batchId,
        companyId: evalCompanyId.trim(),
        jobId: evalJobId.trim(),
      })
      setActionMsg(`Evaluation queued · runId=${res.runId}`)
      setShowEvalDialog(false)
      navigate(`/admin/external-supply/evaluations/${res.runId}`)
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setActionBusy(null)
    }
  }

  if (!batchId) return <ErrorState message="Missing batchId param." />

  return (
    <div className="page-stack">
      {batch?.companyId && (
        <div style={{ fontSize: "0.85em", marginBottom: 4 }}>
          <Link to={`/admin/external-supply/jobs/${encodeURIComponent(batch.companyId)}`}>
            ← back to {batch.companyId} jobs
          </Link>
          <Link
            to={`/admin/external-supply/batches/${batchId}/candidates`}
            style={{ marginLeft: 12, color: "#1a73e8" }}
          >
            Browse candidates →
          </Link>
        </div>
      )}
      <PageHeader
        eyebrow="v2.0 External Supply V1 / Admin"
        title={batch ? `Batch ${batchId.slice(0, 8)}…` : "Batch"}
        description={batch ? `${batch.source} · status=${batch.status} · imported by ${batch.importedBy}` : ""}
        actions={
          <div style={{ display: "flex", gap: 8 }}>
            <Link
              to={`/admin/external-supply/batches/${batchId}/candidates`}
              style={{ ...secondaryBtnStyle, textDecoration: "none" } as React.CSSProperties}
            >
              Browse candidates →
            </Link>
            <button
              type="button"
              disabled={actionBusy !== null}
              onClick={doResolve}
              style={secondaryBtnStyle}
            >
              {actionBusy === "resolve" ? "Resolving…" : "Resolve identity"}
            </button>
            <button
              type="button"
              disabled={actionBusy !== null}
              onClick={() => setShowEvalDialog((v) => !v)}
              style={primaryBtnStyle}
            >
              {showEvalDialog ? "Cancel" : "Run evaluation"}
            </button>
            <button
              type="button"
              disabled={records.length === 0}
              onClick={() => {
                const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
                downloadBatchCsv(
                  records as unknown as ExternalCandidateRecordRowWithRaw[],
                  `batch-${batchId}-${stamp}.csv`,
                )
              }}
              style={secondaryBtnStyle}
              title={records.length === 0 ? "No records to export" : `Download ${records.length} rows as CSV`}
            >
              {`Download CSV (${records.length})`}
            </button>
            <button
              type="button"
              onClick={() => setRefreshKey((n) => n + 1)}
              style={secondaryBtnStyle}
            >
              Refresh
            </button>
          </div>
        }
      />

      {error && <ErrorState message={error} />}
      {actionMsg && (
        <Panel title="Action result" eyebrow="last admin action">
          <code style={{ fontSize: "0.85em" }}>{actionMsg}</code>
        </Panel>
      )}

      {showEvalDialog && (
        <Panel title="Run evaluation" eyebrow="paExternalSupplyRunEvaluation">
          <div style={{ display: "flex", gap: 8, flexDirection: "column", maxWidth: 480 }}>
            <label style={dialogFieldStyle}>
              <span>Company ID</span>
              <input
                type="text"
                value={evalCompanyId}
                onChange={(e) => setEvalCompanyId(e.target.value)}
                style={dialogInputStyle}
              />
            </label>
            <label style={dialogFieldStyle}>
              <span>Job ID</span>
              <input
                type="text"
                value={evalJobId}
                onChange={(e) => setEvalJobId(e.target.value)}
                style={dialogInputStyle}
              />
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={() => setShowEvalDialog(false)}
                disabled={actionBusy === "evaluate"}
                style={secondaryBtnStyle}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={doEvaluate}
                disabled={actionBusy === "evaluate"}
                style={primaryBtnStyle}
              >
                {actionBusy === "evaluate" ? "Starting…" : "Start"}
              </button>
            </div>
          </div>
        </Panel>
      )}

      {loading && !batch ? (
        <LoadingState label="Loading batch…" />
      ) : batch ? (
        <Panel title="Batch stats" eyebrow="pa-external-sourcing-batches">
          <div style={statGridStyle}>
            <Stat label="Rows" value={batch.rowCount} />
            <Stat label="Valid LinkedIn" value={batch.validLinkedInCount} />
            <Stat label="Valid email" value={batch.validEmailCount} />
            <Stat label="Duplicates" value={batch.duplicateCount} />
            <Stat label="Needs review" value={batch.needsReviewCount} />
            <Stat label="Ready to profile" value={batch.readyToProfileCount} />
          </div>
          <div style={{ fontSize: "0.8em", color: "#64748b", marginTop: 8 }}>
            normalizer={batch.normalizerVersion} · created={batch.createdAt.slice(0, 19).replace("T", " ")} · sha256={batch.rawFileRef.sha256.slice(0, 12)}…
          </div>
        </Panel>
      ) : null}

      {batch && (
        <Panel
          title={`Records (${records.length})`}
          eyebrow={`pa-external-candidate-records · status counts: ${formatStatusCounts(counts)}`}
        >
          <BatchTable
            records={records}
            loading={loading}
            error={error}
            onAction={(recordId, action) => {
              if (action === "view_conflict") {
                navigate(`/admin/external-supply/review?recordId=${encodeURIComponent(recordId)}`)
              } else {
                navigate(`/admin/external-supply/audit?recordId=${encodeURIComponent(recordId)}`)
              }
            }}
          />
        </Panel>
      )}
    </div>
  )
}

function groupCounts(records: ExternalCandidateRecord[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of records) {
    out[r.identityResolutionStatus] = (out[r.identityResolutionStatus] ?? 0) + 1
  }
  return out
}

function formatStatusCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts)
  if (entries.length === 0) return "none"
  return entries.map(([k, v]) => `${k}=${v}`).join(" · ")
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={statCardStyle}>
      <div style={{ fontSize: "1.4em", fontWeight: 600 }}>{value}</div>
      <div style={{ fontSize: "0.8em", color: "#64748b" }}>{label}</div>
    </div>
  )
}

const primaryBtnStyle: React.CSSProperties = {
  background: "#1a73e8",
  color: "white",
  border: "none",
  padding: "0.5rem 1rem",
  borderRadius: 4,
  fontWeight: 500,
  cursor: "pointer",
}

const secondaryBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #cbd5e1",
  color: "#1f2937",
  padding: "0.5rem 1rem",
  borderRadius: 4,
  cursor: "pointer",
}

const statGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
  gap: 8,
}

const statCardStyle: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  textAlign: "center",
  background: "#fff",
}

const dialogFieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: "0.85em",
}

const dialogInputStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  fontSize: "0.9em",
}
