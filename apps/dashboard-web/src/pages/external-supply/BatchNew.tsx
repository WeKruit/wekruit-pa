/**
 * v2.0 External Supply V2 — Wave D dashboard UX —
 * `/admin/external-supply/batches/new`.
 *
 * Three-step drag-drop wizard:
 *   pick → previewing → committing → done    ( + error fallback )
 *
 * Flow:
 *   1. PICK
 *      - Drag/drop or browse file (`Dropzone`).
 *      - Optional adapter override (top-3 detection candidates surfaced after
 *        preview, but operator can also pin manually).
 *      - Optional companyId / jobId so the tier forecast renders.
 *      - Optional manual-CSV column mapping when adapter = `manual_csv`.
 *   2. PREVIEWING
 *      - SHA-256 the file, request a signed upload URL, PUT the file to
 *        Cloud Storage, then call `paExternalSupplyPreviewBatch` with the
 *        storage URI + override.
 *      - Render `PreviewPane` (detection / identity / tag / tier /
 *        warnings) and let the operator either Commit or Cancel.
 *   3. COMMITTING
 *      - Call the existing V1 `paExternalSupplyCreateBatch` callable with
 *        the SAME storageUri (we don't re-upload) plus the final override.
 *      - On success, navigate to the new batch detail page.
 *
 * 5 MB raw file cap enforced in both `Dropzone` (advisory) and this page
 * (hard gate before hashing).
 *
 * Per L-E1: only `apps/dashboard-web/src/components/ui.tsx` primitives are
 * used. No Tailwind / Radix / MUI primitives are introduced.
 */
import { useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import type { ExternalSource } from "@pa/core-types"
import { ErrorState, LoadingState, PageHeader, Panel } from "../../components/ui.js"
import { Dropzone, DROPZONE_MAX_BYTES } from "../../components/external-supply/Dropzone.js"
import { PreviewPane } from "../../components/external-supply/PreviewPane.js"
import { StepIndicator, type BatchNewStep } from "./BatchNew.helpers.js"
import {
  createBatch,
  createBatchUploadUrl,
  previewBatch,
  putToSignedUrl,
  sha256Hex,
  type ManualCsvColumnMapping,
  type PreviewBatchResult,
  type PreviewInferredMapping,
} from "../../lib/external-supply-client.js"

const SOURCES: Array<{ value: ExternalSource; label: string }> = [
  { value: "juicebox", label: "Juicebox" },
  { value: "lessie", label: "Lessie" },
  { value: "coresignal", label: "Coresignal" },
  { value: "manual_csv", label: "Manual CSV" },
]

const ACCEPT = ".csv,.json,.xlsx,.tsv,application/json,text/csv,text/tab-separated-values"

interface UploadedFileState {
  file: File
  sha256: string
  storageUri: string
  mime: string
}

export function BatchNew() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // Per-job upload entry: a JobsList row links here with
  // `?companyId=rain-xyz&jobId=rain-...` so the tier forecast + downstream
  // evaluation run pre-bind to the job without operator re-typing.
  const prefillCompanyId = (searchParams.get("companyId") ?? "").trim()
  const prefillJobId = (searchParams.get("jobId") ?? "").trim()
  const [step, setStep] = useState<BatchNewStep>("pick")
  const [source, setSource] = useState<ExternalSource>("juicebox")
  const [adapterOverride, setAdapterOverride] = useState<ExternalSource | "">("")
  const [file, setFile] = useState<File | null>(null)
  const [companyId, setCompanyId] = useState(prefillCompanyId)
  const [jobId, setJobId] = useState(prefillJobId)
  const [columnMapping, setColumnMapping] = useState<ManualCsvColumnMapping>({})
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewBatchResult | null>(null)
  const [uploaded, setUploaded] = useState<UploadedFileState | null>(null)

  const finalSource: ExternalSource = (adapterOverride || source) as ExternalSource

  async function handlePreview() {
    if (!file) {
      setError("Pick a file to upload.")
      return
    }
    if (file.size > DROPZONE_MAX_BYTES) {
      setError(
        `File is ${(file.size / 1024 / 1024).toFixed(2)} MB; max is ${(DROPZONE_MAX_BYTES / 1024 / 1024).toFixed(0)} MB.`,
      )
      return
    }
    setError(null)
    setStep("previewing")
    try {
      const buf = await file.arrayBuffer()
      const sha256 = await sha256Hex(buf)
      const mime = file.type || (finalSource === "coresignal" ? "application/json" : "text/csv")
      const upload = await createBatchUploadUrl({
        sha256,
        mime,
        sizeBytes: file.size,
        source: finalSource,
      })
      await putToSignedUrl(upload.signedUrl, buf, mime)
      const result = await previewBatch({
        source: finalSource,
        storageUri: upload.storageUri,
        sha256,
        mime,
        sizeBytes: file.size,
        ...(companyId.trim() ? { companyId: companyId.trim() } : {}),
        ...(jobId.trim() ? { jobId: jobId.trim() } : {}),
        ...(finalSource === "manual_csv" ? { columnMapping } : {}),
        ...(adapterOverride ? { adapterOverride: adapterOverride as ExternalSource } : {}),
      })
      setPreview(result)
      setUploaded({ file, sha256, storageUri: upload.storageUri, mime })
      // Seed the override columnMapping with the auto-detected mapping when
      // the operator hasn't typed anything yet. Lets them commit immediately
      // for the common Lessie / Juicebox case without filling in fields.
      if (
        result.inferredMapping &&
        Object.keys(columnMapping).filter((k) => columnMapping[k as keyof ManualCsvColumnMapping]).length === 0
      ) {
        setColumnMapping({ ...result.inferredMapping.mapping })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStep("error")
    }
  }

  async function handleCommit() {
    if (!uploaded) {
      setError("No uploaded file. Re-run preview.")
      setStep("error")
      return
    }
    setError(null)
    setStep("committing")
    try {
      const result = await createBatch({
        source: finalSource,
        storageUri: uploaded.storageUri,
        sha256: uploaded.sha256,
        mime: uploaded.mime,
        sizeBytes: uploaded.file.size,
        ...(companyId.trim() ? { companyId: companyId.trim() } : {}),
        ...(jobId.trim() ? { jobId: jobId.trim() } : {}),
        ...(finalSource === "manual_csv" ? { columnMapping } : {}),
      })
      setStep("done")
      navigate(`/admin/external-supply/batches/${result.batchId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStep("error")
    }
  }

  function handleReset() {
    setStep("pick")
    setError(null)
    setPreview(null)
    setUploaded(null)
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="v2.0 External Supply V2 / Admin"
        title="New batch"
        description="Drag-drop a Juicebox / Lessie / Coresignal / manual-CSV export. We auto-detect the adapter, preview identity + tag + tier forecasts, then you commit."
      />

      <StepIndicator step={step} />

      {step === "pick" && (
        <PickPanel
          source={source}
          setSource={setSource}
          adapterOverride={adapterOverride}
          setAdapterOverride={setAdapterOverride}
          file={file}
          onFile={(f) => {
            setFile(f)
            setError(null)
          }}
          companyId={companyId}
          setCompanyId={setCompanyId}
          jobId={jobId}
          setJobId={setJobId}
          columnMapping={columnMapping}
          setColumnMapping={setColumnMapping}
          finalSource={finalSource}
          error={error}
          onPreview={handlePreview}
        />
      )}

      {step === "previewing" && (
        <Panel title="Previewing batch" eyebrow="hashing → signed upload → preview callable">
          {preview ? (
            <PreviewPanelWithActions
              preview={preview}
              finalSource={finalSource}
              adapterOverride={adapterOverride}
              setAdapterOverride={setAdapterOverride}
              columnMapping={columnMapping}
              setColumnMapping={setColumnMapping}
              onCommit={handleCommit}
              onReset={handleReset}
              error={error}
            />
          ) : (
            <LoadingState label="Hashing + uploading + previewing…" />
          )}
        </Panel>
      )}

      {step === "committing" && (
        <Panel title="Committing batch" eyebrow="paExternalSupplyCreateBatch">
          <LoadingState label="Normalizing batch…" />
        </Panel>
      )}

      {step === "done" && (
        <Panel title="Done" eyebrow="redirecting to batch detail">
          <p style={{ fontSize: "0.9em" }}>Batch created. Redirecting…</p>
        </Panel>
      )}

      {step === "error" && (
        <Panel title="Error" eyebrow="batch preview / commit failed">
          {error && <ErrorState message={error} />}
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={handleReset} style={secondaryBtnStyle}>
              Reset
            </button>
          </div>
        </Panel>
      )}
    </div>
  )
}

function PickPanel({
  source,
  setSource,
  adapterOverride,
  setAdapterOverride,
  file,
  onFile,
  companyId,
  setCompanyId,
  jobId,
  setJobId,
  columnMapping,
  setColumnMapping,
  finalSource,
  error,
  onPreview,
}: {
  source: ExternalSource
  setSource: (s: ExternalSource) => void
  adapterOverride: ExternalSource | ""
  setAdapterOverride: (s: ExternalSource | "") => void
  file: File | null
  onFile: (f: File) => void
  companyId: string
  setCompanyId: (v: string) => void
  jobId: string
  setJobId: (v: string) => void
  columnMapping: ManualCsvColumnMapping
  setColumnMapping: (m: ManualCsvColumnMapping) => void
  finalSource: ExternalSource
  error: string | null
  onPreview: () => void
}) {
  return (
    <Panel
      title="1. Pick source + file"
      eyebrow={SOURCES.find((s) => s.value === finalSource)?.label ?? finalSource}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 760 }}>
        <Dropzone file={file} onFile={onFile} accept={ACCEPT} error={null} />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={fieldStyle}>
            <span style={labelTextStyle}>Source adapter (initial guess)</span>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as ExternalSource)}
              style={inputStyle}
            >
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label style={fieldStyle}>
            <span style={labelTextStyle}>Adapter override (optional)</span>
            <select
              value={adapterOverride}
              onChange={(e) => setAdapterOverride(e.target.value as ExternalSource | "")}
              style={inputStyle}
            >
              <option value="">— no override —</option>
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label style={fieldStyle}>
            <span style={labelTextStyle}>Company ID (optional, for tier forecast)</span>
            <input
              type="text"
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              placeholder="company-uuid"
              style={inputStyle}
            />
          </label>
          <label style={fieldStyle}>
            <span style={labelTextStyle}>Job ID (optional, for tier forecast)</span>
            <input
              type="text"
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
              placeholder="job-uuid"
              style={inputStyle}
            />
          </label>
        </div>

        {finalSource === "manual_csv" && (
          <ManualMappingEditor mapping={columnMapping} onChange={setColumnMapping} />
        )}

        {error && <ErrorState message={error} />}

        <div>
          <button
            type="button"
            onClick={onPreview}
            disabled={!file}
            style={primaryBtnStyle}
          >
            Preview batch →
          </button>
        </div>
      </div>
    </Panel>
  )
}

function PreviewPanelWithActions({
  preview,
  finalSource,
  adapterOverride,
  setAdapterOverride,
  columnMapping,
  setColumnMapping,
  onCommit,
  onReset,
  error,
}: {
  preview: PreviewBatchResult
  finalSource: ExternalSource
  adapterOverride: ExternalSource | ""
  setAdapterOverride: (s: ExternalSource | "") => void
  columnMapping: ManualCsvColumnMapping
  setColumnMapping: (m: ManualCsvColumnMapping) => void
  onCommit: () => void
  onReset: () => void
  error: string | null
}) {
  const top3 = preview.detection.candidates.slice(0, 3)
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          fontSize: "0.85em",
        }}
      >
        <strong>Adapter override</strong>
        <select
          value={adapterOverride}
          onChange={(e) => setAdapterOverride(e.target.value as ExternalSource | "")}
          style={inputStyle}
        >
          <option value="">use detected ({preview.detection.top.source})</option>
          {top3.map((c) => (
            <option key={c.source} value={c.source}>
              {c.source} · {(c.confidence * 100).toFixed(0)}%
            </option>
          ))}
        </select>
        <span style={{ color: "#64748b" }}>final adapter: {finalSource}</span>
      </div>

      {preview.inferredMapping && finalSource === "manual_csv" && (
        <AutoMappingTable
          inferred={preview.inferredMapping}
          sampleRows={preview.sampleRows ?? []}
          mapping={columnMapping}
          onChange={setColumnMapping}
        />
      )}

      <PreviewPane preview={preview} />

      {error && <ErrorState message={error} />}

      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={onCommit} style={primaryBtnStyle}>
          Commit batch
        </button>
        <button type="button" onClick={onReset} style={secondaryBtnStyle}>
          Reset
        </button>
      </div>
    </div>
  )
}

const FIELD_OPTIONS: Array<{ value: keyof ManualCsvColumnMapping | "rubric" | "ignore"; label: string }> = [
  { value: "ignore", label: "— ignore —" },
  { value: "rubric", label: "Rubric criterion" },
  { value: "linkedinUrl", label: "LinkedIn URL" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "name", label: "Name" },
  { value: "currentTitle", label: "Title" },
  { value: "currentCompany", label: "Company" },
  { value: "location", label: "Location" },
  { value: "skills", label: "Skills" },
]

function currentFieldForHeader(
  header: string,
  mapping: ManualCsvColumnMapping,
  rubricColumns: string[],
): (typeof FIELD_OPTIONS)[number]["value"] {
  for (const [field, mapped] of Object.entries(mapping) as [keyof ManualCsvColumnMapping, string | undefined][]) {
    if (mapped === header) return field
  }
  if (rubricColumns.includes(header)) return "rubric"
  return "ignore"
}

/**
 * Post-preview override surface. Each source column gets a dropdown to
 * remap to a canonical field, mark as rubric (preserved verbatim), or
 * ignore. Sample-row values stay visible so the operator can sanity-check.
 */
function AutoMappingTable({
  inferred,
  sampleRows,
  mapping,
  onChange,
}: {
  inferred: PreviewInferredMapping
  sampleRows: Record<string, string>[]
  mapping: ManualCsvColumnMapping
  onChange: (next: ManualCsvColumnMapping) => void
}) {
  const headers = [
    ...new Set([
      ...Object.values(inferred.mapping).filter((v): v is string => Boolean(v)),
      ...inferred.rubricColumns,
      ...(inferred.matchScoreColumn ? [inferred.matchScoreColumn] : []),
      ...sampleRows.flatMap((r) => Object.keys(r)),
    ]),
  ]
  function setField(header: string, field: (typeof FIELD_OPTIONS)[number]["value"]) {
    const next: ManualCsvColumnMapping = { ...mapping }
    // Clear any previous assignment to this header.
    for (const [k, v] of Object.entries(next) as [keyof ManualCsvColumnMapping, string | undefined][]) {
      if (v === header) delete next[k]
    }
    if (field !== "ignore" && field !== "rubric") {
      next[field] = header
    }
    onChange(next)
  }
  return (
    <fieldset
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 6,
        padding: 12,
        background: "#fafbfc",
      }}
    >
      <legend style={{ fontSize: "0.85em", fontWeight: 600 }}>
        Detected column mapping ({headers.length} columns)
      </legend>
      <p style={{ fontSize: "0.75em", color: "#64748b", margin: "0 0 8px 0" }}>
        Auto-detected from headers. Override any column below before committing.
        Columns marked "Rubric criterion" are preserved verbatim and shown as
        candidate badges in the browser.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8em" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #cbd5e1" }}>
              <th style={cellStyle}>Source column</th>
              <th style={cellStyle}>Mapped to</th>
              <th style={cellStyle}>Sample value</th>
            </tr>
          </thead>
          <tbody>
            {headers.map((h) => {
              const sample = sampleRows[0]?.[h] ?? ""
              const truncated = sample.length > 80 ? `${sample.slice(0, 80)}…` : sample
              const current = currentFieldForHeader(h, mapping, inferred.rubricColumns)
              return (
                <tr key={h} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ ...cellStyle, fontWeight: 500 }}>{h}</td>
                  <td style={cellStyle}>
                    <select
                      value={current}
                      onChange={(e) =>
                        setField(h, e.target.value as (typeof FIELD_OPTIONS)[number]["value"])
                      }
                      style={{ ...inputStyle, padding: "0.2rem 0.4rem", fontSize: "0.85em" }}
                    >
                      {FIELD_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={{ ...cellStyle, color: "#64748b", fontFamily: "monospace" }}>
                    {truncated}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </fieldset>
  )
}

const cellStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  textAlign: "left",
  verticalAlign: "top",
}

function ManualMappingEditor({
  mapping,
  onChange,
}: {
  mapping: ManualCsvColumnMapping
  onChange: (next: ManualCsvColumnMapping) => void
}) {
  const fields: Array<{ key: keyof ManualCsvColumnMapping; label: string }> = [
    { key: "linkedinUrl", label: "LinkedIn URL column" },
    { key: "email", label: "Email column" },
    { key: "phone", label: "Phone column" },
    { key: "name", label: "Name column" },
    { key: "currentTitle", label: "Title column" },
    { key: "currentCompany", label: "Company column" },
    { key: "location", label: "Location column" },
    { key: "skills", label: "Skills column" },
  ]
  return (
    <fieldset style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: 12 }}>
      <legend style={{ fontSize: "0.85em", fontWeight: 600 }}>
        Column mapping (manual CSV)
      </legend>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
        {fields.map((f) => (
          <label key={f.key} style={fieldStyle}>
            <span style={labelTextStyle}>{f.label}</span>
            <input
              type="text"
              value={mapping[f.key] ?? ""}
              onChange={(e) => onChange({ ...mapping, [f.key]: e.target.value })}
              placeholder={f.label}
              style={inputStyle}
            />
          </label>
        ))}
      </div>
    </fieldset>
  )
}

const fieldStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 }
const labelTextStyle: React.CSSProperties = { fontSize: "0.8em", fontWeight: 600 }
const inputStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  fontSize: "0.9em",
}
const primaryBtnStyle: React.CSSProperties = {
  background: "#1a73e8",
  color: "white",
  border: "none",
  padding: "0.6rem 1.2rem",
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
