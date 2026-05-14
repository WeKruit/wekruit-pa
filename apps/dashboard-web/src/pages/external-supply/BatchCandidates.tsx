/**
 * v2.0 External Supply V2.1 — Per-batch candidate browser.
 *
 * Lessie-style list (left) + detail drawer (right) for a single
 * `pa-external-sourcing-batches/{batchId}`. Powers the
 * "Browse candidates →" link on BatchDetail.
 *
 * Reads:
 *   - `paExternalSupplyListBatchCandidates({ batchId })`
 *   - `paExternalSupplyGetCandidateDetail({ recordId })`
 *
 * Layout mirrors `Outreach.tsx`'s `320px 1fr` grid. List rows show the
 * candidate's verbatim Lessie rubric labels as colored chips (green =
 * passed, red = failed, grey = neutral). Click a row → right panel
 * loads detail (record / candidate profile / resume / handles).
 */
import { useEffect, useMemo, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import {
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
} from "../../components/ui.js"
import {
  getCandidateDetail,
  listBatchCandidates,
  type BatchCandidateRow,
  type CandidateDetail,
  type ListBatchCandidatesResult,
} from "../../lib/external-supply-client.js"

export function BatchCandidates() {
  const { batchId = "" } = useParams<{ batchId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedRecordId = searchParams.get("record") ?? ""

  const [result, setResult] = useState<ListBatchCandidatesResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const [detail, setDetail] = useState<CandidateDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  useEffect(() => {
    if (!batchId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    listBatchCandidates({ batchId })
      .then((r) => {
        if (cancelled) return
        setResult(r)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [batchId])

  useEffect(() => {
    if (!selectedRecordId) {
      setDetail(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    setDetailError(null)
    getCandidateDetail({ recordId: selectedRecordId })
      .then((d) => {
        if (cancelled) return
        setDetail(d)
      })
      .catch((err) => {
        if (cancelled) return
        setDetailError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (cancelled) return
        setDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedRecordId])

  const rows = result?.rows ?? []
  const [filter, setFilter] = useState("")
  const filteredRows = useMemo(() => {
    if (!filter.trim()) return rows
    const q = filter.trim().toLowerCase()
    return rows.filter((r) =>
      [
        r.name,
        r.currentTitle,
        r.currentCompany,
        r.location,
        r.linkedinUrl,
        r.email,
        r.headline,
      ]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q)),
    )
  }, [rows, filter])

  function selectRecord(recordId: string) {
    const next = new URLSearchParams(searchParams)
    next.set("record", recordId)
    setSearchParams(next, { replace: false })
  }

  const view = (searchParams.get("view") === "table" ? "table" : "list") as "list" | "table"
  function setView(v: "list" | "table") {
    const next = new URLSearchParams(searchParams)
    next.set("view", v)
    if (v === "table") next.delete("record")
    setSearchParams(next, { replace: false })
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="External Supply / Batch"
        title="Candidates"
        description={`Batch ${batchId} — ${view === "table" ? "table view" : "click a row to open detail"}`}
      />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.85em" }}>
        <Link to={`/admin/external-supply/batches/${batchId}`}>← back to batch detail</Link>
        <div role="tablist" style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            onClick={() => setView("list")}
            style={{ ...viewToggleStyle, ...(view === "list" ? viewToggleActiveStyle : {}) }}
          >
            List + drawer
          </button>
          <button
            type="button"
            onClick={() => setView("table")}
            style={{ ...viewToggleStyle, ...(view === "table" ? viewToggleActiveStyle : {}) }}
          >
            Table view
          </button>
        </div>
      </div>

      {error && <ErrorState message={error} />}
      {loading && !result && <LoadingState label="Loading candidates…" />}

      {result && view === "list" && (
        <div style={twoColStyle}>
          <div>
            <Panel
              title={`Matches (${filteredRows.length})`}
              eyebrow={result.jobId ? `job ${result.jobId.slice(0, 12)}…` : "no bound job"}
            >
              <input
                type="text"
                placeholder="Filter by name / company / role…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={filterStyle}
              />
              <div style={listStyle}>
                {filteredRows.map((row) => (
                  <CandidateListRow
                    key={row.recordId}
                    row={row}
                    selected={row.recordId === selectedRecordId}
                    onClick={() => selectRecord(row.recordId)}
                  />
                ))}
                {filteredRows.length === 0 && (
                  <p style={{ color: "#94a3b8", fontSize: "0.85em" }}>No candidates yet.</p>
                )}
              </div>
            </Panel>
          </div>

          <div>
            {!selectedRecordId && (
              <Panel title="Pick a candidate" eyebrow="left list">
                <p style={{ color: "#64748b", fontSize: "0.9em" }}>
                  Click a row on the left to see resume / rubric reasoning / contact handles.
                </p>
              </Panel>
            )}
            {selectedRecordId && detailLoading && <LoadingState label="Loading detail…" />}
            {selectedRecordId && detailError && <ErrorState message={detailError} />}
            {selectedRecordId && detail && <CandidateDetailPanel detail={detail} />}
          </div>
        </div>
      )}

      {result && view === "table" && (
        <Panel
          title={`Matches (${filteredRows.length})`}
          eyebrow={result.jobId ? `job ${result.jobId.slice(0, 12)}…` : "no bound job"}
        >
          <input
            type="text"
            placeholder="Filter by name / company / role…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ ...filterStyle, marginBottom: 12 }}
          />
          <CandidateTable rows={filteredRows} onSelect={(id) => { setView("list"); selectRecord(id) }} />
        </Panel>
      )}
    </div>
  )
}

function CandidateTable({
  rows,
  onSelect,
}: {
  rows: BatchCandidateRow[]
  onSelect: (recordId: string) => void
}) {
  // Build the union of rubric column labels so the table has consistent
  // columns even when individual candidates differ.
  const rubricLabels = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) {
      if (r.rubric) for (const k of Object.keys(r.rubric)) set.add(k)
    }
    return Array.from(set).slice(0, 12)
  }, [rows])

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82em" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #cbd5e1", textAlign: "left" }}>
            <th style={tableTh}>Name</th>
            <th style={tableTh}>Title @ Company</th>
            <th style={tableTh}>Location</th>
            <th style={tableTh}>Links</th>
            <th style={tableTh}>Match</th>
            <th style={tableTh}>Rubric</th>
            {rubricLabels.map((l) => (
              <th key={l} style={{ ...tableTh, fontSize: "0.7em", color: "#475569" }}>{l}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const rubricEntries = r.rubric ? Object.entries(r.rubric) : []
            const passed = rubricEntries.filter(([, c]) => c.passed === true).length
            const total = rubricEntries.length
            return (
              <tr
                key={r.recordId}
                style={{ borderBottom: "1px solid #f1f5f9", cursor: "pointer" }}
                onClick={() => onSelect(r.recordId)}
              >
                <td style={tableTd}><strong>{r.name ?? "—"}</strong></td>
                <td style={tableTd}>
                  {r.currentTitle ?? "—"}
                  {r.currentCompany ? <span style={{ color: "#64748b" }}> @ {r.currentCompany}</span> : null}
                </td>
                <td style={tableTd}>{r.location ?? "—"}</td>
                <td style={tableTd}>
                  {Array.isArray(r.links) && r.links.length > 0 ? (
                    <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                      {r.links.map((l, i) => (
                        <a
                          key={`${l.url}-${i}`}
                          href={l.url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          title={l.url}
                          style={{
                            fontSize: "0.7em",
                            padding: "1px 5px",
                            borderRadius: 3,
                            background: LINK_KIND_BG[l.kind] ?? "#f1f5f9",
                            color: LINK_KIND_FG[l.kind] ?? "#475569",
                            textDecoration: "none",
                            fontWeight: 600,
                          }}
                        >
                          {LINK_KIND_LABEL[l.kind] ?? l.hostname}
                        </a>
                      ))}
                    </div>
                  ) : (
                    "—"
                  )}
                </td>
                <td style={tableTd}>
                  {r.matchScore === "1" ? (
                    <span style={{ color: "#16a34a", fontWeight: 600 }}>✓</span>
                  ) : (
                    r.matchScore ?? "—"
                  )}
                </td>
                <td style={tableTd}>
                  {total > 0 ? `${passed}/${total}` : "—"}
                </td>
                {rubricLabels.map((label) => {
                  const cell = r.rubric?.[label]
                  if (!cell) return <td key={label} style={{ ...tableTd, color: "#cbd5e1" }}>—</td>
                  const tone = cell.passed === true ? "#16a34a" : cell.passed === false ? "#dc2626" : "#64748b"
                  return (
                    <td key={label} style={{ ...tableTd, color: tone }} title={cell.value}>
                      {cell.passed === true ? "✓" : cell.passed === false ? "✗" : "·"}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function CandidateListRow({
  row,
  selected,
  onClick,
}: {
  row: BatchCandidateRow
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...rowStyle,
        ...(selected ? rowSelectedStyle : {}),
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontWeight: 600, color: "#0f172a" }}>{row.name ?? "—"}</span>
        <div style={{ display: "flex", gap: 4, alignItems: "baseline" }}>
          {row.matchScore && (
            <span
              style={{
                fontSize: "0.7em",
                fontWeight: 600,
                color: row.matchScore === "1" ? "#16a34a" : "#475569",
                background: row.matchScore === "1" ? "#dcfce7" : "#f1f5f9",
                padding: "1px 6px",
                borderRadius: 4,
              }}
              title="Lessie Match column — 1 = passed all rubric gates"
            >
              {row.matchScore === "1" ? "✓ Match" : `Match ${row.matchScore}`}
            </span>
          )}
        </div>
      </div>
      <div style={{ fontSize: "0.8em", color: "#475569", marginTop: 2 }}>
        {row.currentTitle ?? "—"}
        {row.currentCompany ? ` @ ${row.currentCompany}` : ""}
      </div>
      {row.location && (
        <div style={{ fontSize: "0.75em", color: "#64748b", marginTop: 2 }}>
          {row.location}
        </div>
      )}
      {Array.isArray(row.links) && row.links.length > 0 && (
        <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
          {row.links.map((l, i) => (
            <a
              key={`${l.url}-${i}`}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={l.url}
              style={{
                fontSize: "0.65em",
                fontWeight: 600,
                padding: "1px 6px",
                borderRadius: 4,
                background: LINK_KIND_BG[l.kind] ?? "#f1f5f9",
                color: LINK_KIND_FG[l.kind] ?? "#475569",
                textDecoration: "none",
              }}
            >
              {LINK_KIND_LABEL[l.kind] ?? l.hostname}
            </a>
          ))}
        </div>
      )}
      <div style={chipRowStyle}>
        {row.evaluation?.tier && (
          <span
            style={{
              ...chipStyle,
              background: "#dbeafe",
              color: "#1e3a8a",
              fontWeight: 600,
            }}
          >
            {row.evaluation.tier.replace(/^tier_/, "T")}
          </span>
        )}
        {row.rubric &&
          Object.entries(row.rubric)
            .slice(0, 5)
            .map(([label, cell]) => (
              <span
                key={label}
                title={cell.value}
                style={{
                  ...chipStyle,
                  background:
                    cell.passed === true
                      ? "#dcfce7"
                      : cell.passed === false
                        ? "#fee2e2"
                        : "#f1f5f9",
                  color:
                    cell.passed === true
                      ? "#166534"
                      : cell.passed === false
                        ? "#991b1b"
                        : "#475569",
                }}
              >
                {label}
              </span>
            ))}
      </div>
    </button>
  )
}

function CandidateDetailPanel({ detail }: { detail: CandidateDetail }) {
  const record = detail.record as Record<string, unknown>
  const candidate = detail.candidate ?? null
  const enrichment = (record.enrichment ?? {}) as Record<string, unknown>
  const rubric = (enrichment.rubric ?? {}) as Record<string, { value: string; passed: boolean | null }>
  const headline = enrichment.headline as string | undefined
  const matchScore = enrichment.matchScore as string | undefined
  const tags = ((candidate as Record<string, unknown> | null)?.tags ?? {}) as Record<string, unknown>
  const skills = Array.isArray(tags.skills)
    ? (tags.skills as Array<{ value?: string } | string>)
    : []

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel
        title={(record.name as string) ?? "Candidate"}
        eyebrow={
          detail.candidateId
            ? `pa-users/${detail.candidateId.slice(0, 12)}…`
            : "no resolved candidate"
        }
      >
        <div style={detailHeaderStyle}>
          {typeof record.canonicalLinkedInUrl === "string" && (
            <a
              href={record.canonicalLinkedInUrl}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: "0.85em" }}
            >
              {record.canonicalLinkedInUrl}
            </a>
          )}
          <div style={{ fontSize: "0.85em", color: "#475569" }}>
            {typeof record.currentTitle === "string" ? record.currentTitle : ""}
            {typeof record.currentCompany === "string" ? ` · ${record.currentCompany}` : ""}
          </div>
          {typeof record.location === "string" && (
            <div style={{ fontSize: "0.8em", color: "#64748b" }}>
              {record.location}
            </div>
          )}
          {headline && (
            <div
              style={{
                fontSize: "0.85em",
                marginTop: 6,
                padding: 8,
                background: "#f8fafc",
                borderLeft: "3px solid #94a3b8",
                fontStyle: "italic",
              }}
            >
              {headline}
            </div>
          )}
          {matchScore && (
            <div style={{ fontSize: "0.8em", color: "#475569" }}>
              Lessie match score: <strong>{matchScore}</strong>
            </div>
          )}
        </div>
      </Panel>

      {Object.keys(rubric).length > 0 && (
        <Panel title="Rubric reasoning" eyebrow="source-of-truth, verbatim">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {Object.entries(rubric).map(([label, cell]) => (
              <div
                key={label}
                style={{
                  display: "grid",
                  gridTemplateColumns: "180px 1fr",
                  gap: 12,
                  alignItems: "start",
                  fontSize: "0.85em",
                }}
              >
                <span
                  style={{
                    ...chipStyle,
                    background:
                      cell.passed === true
                        ? "#dcfce7"
                        : cell.passed === false
                          ? "#fee2e2"
                          : "#f1f5f9",
                    color:
                      cell.passed === true
                        ? "#166534"
                        : cell.passed === false
                          ? "#991b1b"
                          : "#475569",
                    fontWeight: 600,
                    height: "fit-content",
                  }}
                >
                  {label}
                </span>
                <span style={{ color: "#0f172a" }}>{cell.value}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {detail.evaluation && (
        <Panel title="Evaluation" eyebrow={detail.evaluation.evaluationId.slice(0, 16)}>
          <dl style={{ fontSize: "0.85em", margin: 0 }}>
            <dt style={dtStyle}>Tier</dt>
            <dd style={ddStyle}>{detail.evaluation.proposedTier ?? "—"}</dd>
            {typeof detail.evaluation.generalRubricScore === "number" && (
              <>
                <dt style={dtStyle}>Score</dt>
                <dd style={ddStyle}>{detail.evaluation.generalRubricScore.toFixed(2)}</dd>
              </>
            )}
            {detail.evaluation.explanation && (
              <>
                <dt style={dtStyle}>Explanation</dt>
                <dd style={ddStyle}>{detail.evaluation.explanation}</dd>
              </>
            )}
          </dl>
        </Panel>
      )}

      {(detail.resume || skills.length > 0) && (
        <Panel title="Profile" eyebrow={detail.candidateId ? "from pa-users" : "no resolved profile"}>
          {detail.resume?.candidateProfileSummary && (
            <div style={{ fontSize: "0.85em", whiteSpace: "pre-wrap" }}>
              {detail.resume.candidateProfileSummary}
            </div>
          )}
          {skills.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: "0.75em", color: "#64748b", marginBottom: 4 }}>
                Skills
              </div>
              <div style={chipRowStyle}>
                {skills.slice(0, 30).map((s, i) => {
                  const label = typeof s === "string" ? s : (s.value ?? "")
                  if (!label) return null
                  return (
                    <span key={`${label}-${i}`} style={chipStyle}>
                      {label}
                    </span>
                  )
                })}
              </div>
            </div>
          )}
        </Panel>
      )}

      {detail.handles && detail.handles.length > 0 && (
        <Panel title="Contact handles" eyebrow="redacted">
          <ul style={{ fontSize: "0.85em", paddingLeft: 18 }}>
            {detail.handles.map((h, i) => (
              <li key={`${h.kind}-${i}`}>
                <strong>{h.kind}:</strong> {h.redactedValue}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  )
}

const viewToggleStyle: React.CSSProperties = {
  padding: "4px 12px",
  fontSize: "0.8em",
  background: "white",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  cursor: "pointer",
  fontWeight: 500,
  color: "#475569",
}
const viewToggleActiveStyle: React.CSSProperties = {
  background: "#1a73e8",
  borderColor: "#1a73e8",
  color: "white",
}
const tableTh: React.CSSProperties = {
  padding: "6px 8px",
  fontWeight: 600,
  whiteSpace: "nowrap",
  fontSize: "0.78em",
  color: "#0f172a",
}
const tableTd: React.CSSProperties = {
  padding: "6px 8px",
  verticalAlign: "top",
}

const LINK_KIND_LABEL: Record<string, string> = {
  linkedin: "in",
  github: "GH",
  twitter: "X",
  facebook: "fb",
  instagram: "IG",
  medium: "M",
  youtube: "YT",
  tiktok: "TT",
  dribbble: "Drbl",
  behance: "Bhnc",
  stackoverflow: "SO",
  personal: "site",
  other: "link",
}
const LINK_KIND_BG: Record<string, string> = {
  linkedin: "#dbeafe",
  github: "#1f2937",
  twitter: "#0f172a",
  facebook: "#dbeafe",
  instagram: "#fce7f3",
  medium: "#dcfce7",
  youtube: "#fee2e2",
  tiktok: "#0f172a",
  dribbble: "#fce7f3",
  behance: "#dbeafe",
  stackoverflow: "#fef3c7",
  personal: "#f1f5f9",
  other: "#f1f5f9",
}
const LINK_KIND_FG: Record<string, string> = {
  linkedin: "#1e3a8a",
  github: "#f8fafc",
  twitter: "#f8fafc",
  facebook: "#1e3a8a",
  instagram: "#9d174d",
  medium: "#166534",
  youtube: "#991b1b",
  tiktok: "#f8fafc",
  dribbble: "#9d174d",
  behance: "#1e3a8a",
  stackoverflow: "#92400e",
  personal: "#475569",
  other: "#475569",
}

const twoColStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "360px 1fr",
  gap: 16,
  alignItems: "start",
}

const listStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  maxHeight: "calc(100vh - 280px)",
  overflowY: "auto",
}

const rowStyle: React.CSSProperties = {
  textAlign: "left",
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  padding: 10,
  cursor: "pointer",
  font: "inherit",
}

const rowSelectedStyle: React.CSSProperties = {
  borderColor: "#1a73e8",
  background: "#eff6ff",
}

const chipStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 12,
  fontSize: "0.7em",
  background: "#f1f5f9",
  color: "#475569",
}

const chipRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  marginTop: 6,
}

const filterStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.4rem 0.6rem",
  marginBottom: 8,
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  fontSize: "0.85em",
}

const detailHeaderStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
}

const dtStyle: React.CSSProperties = {
  fontWeight: 600,
  marginTop: 6,
  color: "#475569",
}

const ddStyle: React.CSSProperties = {
  margin: "2px 0 0 0",
  color: "#0f172a",
}
