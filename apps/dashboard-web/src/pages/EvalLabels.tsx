import * as React from "react"
import { useEffect, useState, type CSSProperties } from "react"

import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import { ERROR_CATEGORY_LABEL } from "../components/prescreen/EvalLabelForm.helpers.js"
import {
  exportEvaluationLabels,
  type EvaluationLabelExportAggregate,
  type ExportEvaluationLabelsInput,
  type ExportEvaluationLabelsResult,
} from "../lib/external-supply-client.js"

export const EVAL_LABELS_ROUTE = "/admin/eval-labels"

type ExportLoader = (input: ExportEvaluationLabelsInput) => Promise<ExportEvaluationLabelsResult>

const SOURCE_OPTIONS: ReadonlyArray<{ value: ExportEvaluationLabelsInput["source"] | ""; label: string }> = [
  { value: "", label: "All sources" },
  { value: "prescreen", label: "Prescreen" },
  { value: "recruiter_submission", label: "Recruiter submission" },
  { value: "external_supply", label: "External supply" },
  { value: "practice_question", label: "Practice question" },
]

/**
 * P4 — AI-vs-human agreement dashboard + labeled-dataset JSONL export.
 *
 * Read-only summary of every human eval LABEL captured by the data-labeling
 * surface: total labeled, AI-vs-human agree rate (overall + per source), a
 * quality histogram, top error categories, and a one-click JSONL download. The
 * export callable never mutates an AI verdict and never messages a candidate.
 */
export default function EvalLabels({
  loadExport = exportEvaluationLabels,
}: {
  loadExport?: ExportLoader
}) {
  const [source, setSource] = useState<ExportEvaluationLabelsInput["source"] | "">("")
  const [jobId, setJobId] = useState("")
  const [since, setSince] = useState("")
  const [goldOnly, setGoldOnly] = useState(false)

  const [result, setResult] = useState<ExportEvaluationLabelsResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)

  function buildFilters(): ExportEvaluationLabelsInput {
    const filters: ExportEvaluationLabelsInput = {}
    if (source) filters.source = source
    if (jobId.trim()) filters.jobId = jobId.trim()
    if (since.trim()) filters.since = since.trim()
    if (goldOnly) filters.goldOnly = true
    return filters
  }

  async function refresh(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      setResult(await loadExport(buildFilters()))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // Initial load only; explicit Apply / Refresh below re-queries with current filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadExport])

  async function downloadJsonl(): Promise<void> {
    setDownloading(true)
    setError(null)
    try {
      // Re-fetch with the current filters so the download is always fresh.
      const fresh = await loadExport(buildFilters())
      setResult(fresh)
      const blob = new Blob([fresh.jsonl], { type: "application/x-ndjson" })
      const url = URL.createObjectURL(blob)
      const stamp = (fresh.generatedAt || new Date().toISOString()).slice(0, 19).replace(/[:T]/g, "-")
      const suffix = fresh.filters.source ? `-${fresh.filters.source}` : ""
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `eval-labels${suffix}-${stamp}.jsonl`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDownloading(false)
    }
  }

  const aggregate = result?.aggregate

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="P4 / Eval"
        title="Eval labels"
        description="AI-vs-human agreement on every captured eval label, plus a labeled-dataset JSONL export. Read-only — never messages a candidate."
        actions={
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => void refresh()} disabled={loading} style={buttonStyle(loading, true)}>
              {loading ? "Loading" : "Refresh"}
            </button>
            <button
              type="button"
              onClick={() => void downloadJsonl()}
              disabled={downloading || !aggregate || aggregate.totalLabeled === 0}
              style={buttonStyle(downloading || !aggregate || aggregate.totalLabeled === 0, false)}
            >
              {downloading ? "Exporting" : "Export JSONL"}
            </button>
          </div>
        }
      />

      <Panel title="Filters" eyebrow={EVAL_LABELS_ROUTE}>
        <div style={filtersStyle}>
          <label style={labelStyle}>
            <span>Source</span>
            <select
              value={source ?? ""}
              onChange={(event) => setSource((event.target.value || "") as ExportEvaluationLabelsInput["source"] | "")}
              style={inputStyle}
            >
              {SOURCE_OPTIONS.map((option) => (
                <option key={option.value || "all"} value={option.value ?? ""}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            <span>Job id</span>
            <input
              type="text"
              value={jobId}
              placeholder="(any)"
              onChange={(event) => setJobId(event.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            <span>Labeled since (ISO)</span>
            <input
              type="text"
              value={since}
              placeholder="2026-06-01"
              onChange={(event) => setSince(event.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={{ ...labelStyle, alignSelf: "end" }}>
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={goldOnly} onChange={(event) => setGoldOnly(event.target.checked)} />
              Gold samples only
            </span>
          </label>
          <button type="button" onClick={() => void refresh()} disabled={loading} style={{ ...buttonStyle(loading, true), alignSelf: "end" }}>
            Apply
          </button>
        </div>
      </Panel>

      {error ? (
        <Panel title="Export error" eyebrow="callable failure">
          <ErrorState message={error} />
        </Panel>
      ) : null}

      {loading && !result ? (
        <Panel title="Loading">
          <LoadingState label="Loading eval label summary..." />
        </Panel>
      ) : null}

      {result && aggregate ? (
        <>
          {result.truncated ? (
            <Panel title="Truncated" eyebrow="row ceiling hit">
              <p style={mutedStyle}>
                The export hit the row ceiling — narrow the filters (source / job / since) for a complete dataset.
              </p>
            </Panel>
          ) : null}

          <Panel
            title="Agreement summary"
            eyebrow={`${aggregate.totalLabeled} labeled · generated ${formatTimestamp(result.generatedAt)}`}
          >
            {aggregate.totalLabeled === 0 ? (
              <EmptyState
                title="No labels yet"
                body="No eval attempts carry a human label for the current filters. Label records from the prescreen, recruiter, or external-supply review surfaces to populate this dataset."
              />
            ) : (
              <div style={statGridStyle}>
                <Stat label="Total labeled" value={formatCount(aggregate.totalLabeled)} />
                <Stat label="Agreed" value={`${formatCount(aggregate.agreeCount)} / ${formatCount(aggregate.totalLabeled)}`} />
                <Stat label="AI agree rate" value={formatPct(aggregate.agreeRate)} emphasize />
                <Stat label="Gold samples" value={formatCount(aggregate.goldCount)} />
              </div>
            )}
          </Panel>

          {aggregate.totalLabeled > 0 ? (
            <>
              <Panel title="Agree rate by source" eyebrow="AI vs human">
                <div style={sourceGridStyle}>
                  {Object.entries(aggregate.perSource)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([src, stats]) => (
                      <section key={src} style={sourceCardStyle}>
                        <div style={sourceHeaderStyle}>
                          <strong>{formatSourceLabel(src)}</strong>
                          <Badge tone={rateTone(stats.agreeRate)}>{formatPct(stats.agreeRate)}</Badge>
                        </div>
                        <p style={mutedStyle}>
                          {formatCount(stats.agreeCount)} / {formatCount(stats.total)} agreed
                        </p>
                      </section>
                    ))}
                </div>
              </Panel>

              <Panel title="Quality histogram" eyebrow="reviewer rating 1-5">
                <div style={histogramStyle}>
                  {[1, 2, 3, 4, 5].map((rating) => {
                    const count = aggregate.qualityHistogram[String(rating)] ?? 0
                    const max = Math.max(1, ...Object.values(aggregate.qualityHistogram))
                    return (
                      <div key={rating} style={histRowStyle}>
                        <span style={histLabelStyle}>{rating} star</span>
                        <span style={histBarTrackStyle}>
                          <span style={{ ...histBarFillStyle, width: `${(count / max) * 100}%` }} />
                        </span>
                        <strong style={histCountStyle}>{formatCount(count)}</strong>
                      </div>
                    )
                  })}
                </div>
              </Panel>

              <Panel title="Top error categories" eyebrow="why the AI diverged">
                {aggregate.topErrorCategories.length === 0 ? (
                  <p style={mutedStyle}>No error categories recorded (all labels agreed or none flagged a category).</p>
                ) : (
                  <div style={errorListStyle}>
                    {aggregate.topErrorCategories.map((entry) => (
                      <div key={entry.category} style={errorRowStyle}>
                        <span>{ERROR_CATEGORY_LABEL[entry.category] ?? entry.category}</span>
                        <strong>{formatCount(entry.count)}</strong>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function Stat({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <section style={statCardStyle}>
      <span style={statLabelStyle}>{label}</span>
      <strong style={{ ...statValueStyle, ...(emphasize ? { color: "#0f172a", fontSize: 28 } : {}) }}>{value}</strong>
    </section>
  )
}

function formatSourceLabel(source: string): string {
  const found = SOURCE_OPTIONS.find((option) => option.value === source)
  return found?.label ?? source
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value)
}

function rateTone(rate: number): "ok" | "warn" | "info" | "muted" {
  if (rate >= 0.8) return "ok"
  if (rate >= 0.5) return "info"
  return "warn"
}

function formatTimestamp(value?: string): string {
  if (!value) return "unknown"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 19)
  return date.toISOString().slice(0, 16).replace("T", " ")
}

const buttonStyle = (disabled: boolean, primary: boolean): CSSProperties => ({
  padding: "10px 14px",
  border: 0,
  borderRadius: 6,
  background: disabled ? "#94a3b8" : primary ? "#0f172a" : "#2563eb",
  color: "white",
  fontWeight: 700,
  cursor: disabled ? "not-allowed" : "pointer",
})
const filtersStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 12, alignItems: "end" }
const labelStyle: CSSProperties = { display: "grid", gap: 6, fontSize: 13, color: "#475569" }
const inputStyle: CSSProperties = { padding: "10px 12px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 14, minWidth: 180 }
const mutedStyle: CSSProperties = { margin: 0, color: "#64748b", fontSize: 13 }
const statGridStyle: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }
const statCardStyle: CSSProperties = { display: "grid", gap: 4, border: "1px solid #e2e8f0", borderRadius: 8, padding: 14, background: "#f8fafc" }
const statLabelStyle: CSSProperties = { fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, color: "#64748b" }
const statValueStyle: CSSProperties = { fontSize: 22, color: "#0f172a" }
const sourceGridStyle: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }
const sourceCardStyle: CSSProperties = { display: "grid", gap: 6, border: "1px solid #e2e8f0", borderRadius: 8, padding: 12 }
const sourceHeaderStyle: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }
const histogramStyle: CSSProperties = { display: "grid", gap: 8 }
const histRowStyle: CSSProperties = { display: "grid", gridTemplateColumns: "70px 1fr 48px", gap: 10, alignItems: "center" }
const histLabelStyle: CSSProperties = { fontSize: 13, color: "#475569" }
const histBarTrackStyle: CSSProperties = { height: 12, borderRadius: 6, background: "#e2e8f0", overflow: "hidden" }
const histBarFillStyle: CSSProperties = { display: "block", height: "100%", background: "#2563eb", borderRadius: 6 }
const histCountStyle: CSSProperties = { textAlign: "right", fontSize: 14 }
const errorListStyle: CSSProperties = { display: "grid", gap: 6 }
const errorRowStyle: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 14, padding: "6px 10px", background: "#f8fafc", borderRadius: 6 }
