/**
 * v2.0 External Supply V1 — Wave D — `/admin/external-supply/batches/new`.
 *
 * Operator picks the source adapter, file, and optional company/job context,
 * then we:
 *   1. SHA-256 the file in-browser.
 *   2. Call `createBatchUploadUrl` to get a signed PUT URL.
 *   3. PUT the file directly to that URL.
 *   4. Call `createBatch` with `storageUri` + adapter + (optional) column
 *      mapping for `manual_csv`.
 *   5. Navigate to the new batch's detail page.
 */
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import type { ExternalSource } from "@pa/core-types"
import { ErrorState, PageHeader, Panel } from "../../components/ui.js"
import {
  createBatch,
  createBatchUploadUrl,
  putToSignedUrl,
  sha256Hex,
  type ManualCsvColumnMapping,
} from "../../lib/external-supply-client.js"

const SOURCES: Array<{ value: ExternalSource; label: string; mimeHint: string }> = [
  { value: "juicebox", label: "Juicebox", mimeHint: "text/csv" },
  { value: "lessie", label: "Lessie", mimeHint: "text/csv" },
  { value: "coresignal", label: "Coresignal", mimeHint: "application/json" },
  { value: "manual_csv", label: "Manual CSV", mimeHint: "text/csv" },
]

type ProgressState = "idle" | "hashing" | "url" | "uploading" | "ingesting" | "done" | "error"

export function BatchNew() {
  const navigate = useNavigate()
  const [source, setSource] = useState<ExternalSource>("juicebox")
  const [file, setFile] = useState<File | null>(null)
  const [companyId, setCompanyId] = useState("")
  const [jobId, setJobId] = useState("")
  const [columnMapping, setColumnMapping] = useState<ManualCsvColumnMapping>({})
  const [progress, setProgress] = useState<ProgressState>("idle")
  const [error, setError] = useState<string | null>(null)

  const busy = progress !== "idle" && progress !== "error" && progress !== "done"

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) {
      setError("Pick a file to upload.")
      return
    }
    setError(null)
    setProgress("hashing")
    try {
      const buf = await file.arrayBuffer()
      const sha256 = await sha256Hex(buf)
      const mime = file.type || (source === "coresignal" ? "application/json" : "text/csv")
      setProgress("url")
      const upload = await createBatchUploadUrl({
        sha256,
        mime,
        sizeBytes: file.size,
        source,
      })
      setProgress("uploading")
      await putToSignedUrl(upload.signedUrl, buf, mime)
      setProgress("ingesting")
      const result = await createBatch({
        source,
        storageUri: upload.storageUri,
        sha256,
        mime,
        sizeBytes: file.size,
        ...(companyId.trim() ? { companyId: companyId.trim() } : {}),
        ...(jobId.trim() ? { jobId: jobId.trim() } : {}),
        ...(source === "manual_csv" ? { columnMapping } : {}),
      })
      setProgress("done")
      navigate(`/admin/external-supply/batches/${result.batchId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setProgress("error")
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="v2.0 External Supply V1 / Admin"
        title="New batch"
        description="Pick the source adapter, drop the export file, optionally pin to a company/job. The file is uploaded directly to Cloud Storage via a signed URL; only metadata flows through the callable."
      />

      <Panel title="Upload" eyebrow={SOURCES.find((s) => s.value === source)?.label}>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 720 }}>
          <label style={fieldStyle}>
            <span style={labelTextStyle}>Source adapter</span>
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
            <span style={labelTextStyle}>File</span>
            <input
              type="file"
              accept=".csv,.json,.xlsx,.tsv,application/json,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              style={inputStyle}
            />
            {file && (
              <span style={{ fontSize: "0.8em", color: "#64748b" }}>
                {file.name} · {(file.size / 1024).toFixed(1)} kB · {file.type || "(no type)"}
              </span>
            )}
          </label>

          <label style={fieldStyle}>
            <span style={labelTextStyle}>Company ID (optional)</span>
            <input
              type="text"
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              placeholder="company-uuid"
              style={inputStyle}
            />
          </label>

          <label style={fieldStyle}>
            <span style={labelTextStyle}>Job ID (optional)</span>
            <input
              type="text"
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
              placeholder="job-uuid"
              style={inputStyle}
            />
          </label>

          {source === "manual_csv" && (
            <ManualMappingEditor mapping={columnMapping} onChange={setColumnMapping} />
          )}

          {error && <ErrorState message={error} />}

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button type="submit" disabled={busy || !file} style={primaryBtnStyle}>
              {busy ? progressLabel(progress) : "Upload + normalize"}
            </button>
            {progress !== "idle" && progress !== "error" && (
              <span style={{ fontSize: "0.85em", color: "#64748b" }}>{progressLabel(progress)}</span>
            )}
          </div>
        </form>
      </Panel>
    </div>
  )
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
      <legend style={{ fontSize: "0.85em", fontWeight: 600 }}>Column mapping (manual CSV)</legend>
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

function progressLabel(state: ProgressState): string {
  switch (state) {
    case "hashing":
      return "Hashing file…"
    case "url":
      return "Requesting signed URL…"
    case "uploading":
      return "Uploading to storage…"
    case "ingesting":
      return "Normalizing batch…"
    case "done":
      return "Done"
    case "error":
      return "Failed"
    default:
      return ""
  }
}

const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
}

const labelTextStyle: React.CSSProperties = {
  fontSize: "0.8em",
  fontWeight: 600,
}

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
