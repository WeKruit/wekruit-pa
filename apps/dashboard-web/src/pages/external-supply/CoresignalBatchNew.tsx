/**
 * v2.1 — `/admin/external-supply/batches/new-coresignal` —
 * paste-CoreSignal-IDs operator surface.
 *
 * Distinct from `BatchNew.tsx` (the file-upload 3-step wizard). This page
 * is the dedicated paste-list flow because the input shape is different:
 *  - no file upload, no sha256 preflight
 *  - JSON array OR newline-separated integers in a textarea
 *  - direct call to `paCoresignalFetchBatch` callable which fans out to the
 *    CoreSignal API server-side and routes through `runCreateBatch`
 *
 * On success → navigate to existing batch detail page.
 *
 * Per L-E1: only `apps/dashboard-web/src/components/ui.tsx` primitives are
 * used. No new design tokens / Tailwind / Radix.
 */
import { useState, type ReactElement } from "react"
import { useNavigate } from "react-router-dom"
import {
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
} from "../../components/ui.js"

const primaryBtnStyle: React.CSSProperties = {
  padding: "8px 16px",
  background: "var(--color-primary, #2563eb)",
  color: "white",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 14,
}

const disabledBtnStyle: React.CSSProperties = {
  ...primaryBtnStyle,
  background: "var(--color-disabled, #9ca3af)",
  cursor: "not-allowed",
}
import {
  coresignalFetchBatch,
  type CoresignalFetchBatchResult,
} from "../../lib/external-supply-client.js"
import { parseIdList } from "./CoresignalBatchNew.helpers.js"

const MAX_IDS = 500

export function CoresignalBatchNew(): ReactElement {
  const navigate = useNavigate()
  const [rawInput, setRawInput] = useState("")
  const [companyId, setCompanyId] = useState("")
  const [jobId, setJobId] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CoresignalFetchBatchResult | null>(null)

  const parsed = parseIdList(rawInput)
  const uniqueIds = Array.from(new Set(parsed.ids))
  const duplicateCount = parsed.ids.length - uniqueIds.length
  const tooMany = uniqueIds.length > MAX_IDS
  const submitDisabled =
    submitting || uniqueIds.length === 0 || tooMany

  async function handleSubmit(): Promise<void> {
    if (submitDisabled) return
    setSubmitting(true)
    setError(null)
    setResult(null)
    try {
      const res = await coresignalFetchBatch({
        candidateIds: uniqueIds,
        companyId: companyId.trim() || undefined,
        jobId: jobId.trim() || undefined,
      })
      setResult(res)
    } catch (err) {
      setError((err as Error).message ?? String(err))
    } finally {
      setSubmitting(false)
    }
  }

  function goToBatch(): void {
    if (result?.batchId) {
      navigate(`/admin/external-supply/batches/${result.batchId}`)
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="v2.1 External Supply — CoreSignal"
        title="New CoreSignal batch (paste IDs)"
        description="Paste a list of CoreSignal candidate IDs from Playground or saved search. The pipeline fetches via cdapi v2 /employee_multi_source/collect/{id}, normalizes through the same tagging + identity-resolve workers as the file-upload flow, and creates a pa-external-sourcing-batches doc you can review."
      />

      <Panel
        title="Candidate IDs"
        eyebrow={`Up to ${MAX_IDS} per batch. JSON array [123, 456] or newline-separated.`}
      >
        <textarea
          value={rawInput}
          onChange={(e) => setRawInput(e.target.value)}
          rows={10}
          placeholder={"[725992096, 757303208, ...]\nor\n725992096\n757303208\n..."}
          style={{
            width: "100%",
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            fontSize: 13,
            padding: 8,
            boxSizing: "border-box",
          }}
          disabled={submitting}
        />
        <div style={{ marginTop: 8, fontSize: 13, color: "var(--color-text-secondary, #666)" }}>
          Parsed: <strong>{uniqueIds.length}</strong> unique
          {duplicateCount > 0 && ` (${duplicateCount} duplicates dropped)`}
          {parsed.invalidLines.length > 0 && `, ${parsed.invalidLines.length} unparseable`}
          {tooMany && (
            <div style={{ color: "var(--color-danger, #c00)", marginTop: 4 }}>
              Exceeds max {MAX_IDS} per batch — split into multiple submissions.
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Optional context (binds to batch metadata)">
        <label style={{ display: "block", marginBottom: 8 }}>
          <div style={{ fontSize: 13, marginBottom: 4 }}>companyId (optional)</div>
          <input
            type="text"
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            placeholder="pa-companies/{id}"
            disabled={submitting}
            style={{ width: "100%", padding: 6, boxSizing: "border-box" }}
          />
        </label>
        <label style={{ display: "block" }}>
          <div style={{ fontSize: 13, marginBottom: 4 }}>jobId (optional)</div>
          <input
            type="text"
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
            placeholder="matching-jobs/{id}"
            disabled={submitting}
            style={{ width: "100%", padding: 6, boxSizing: "border-box" }}
          />
        </label>
      </Panel>

      <div style={{ marginTop: 16, display: "flex", gap: 12 }}>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitDisabled}
          style={submitDisabled ? disabledBtnStyle : primaryBtnStyle}
        >
          {submitting ? "Fetching from CoreSignal…" : `Fetch ${uniqueIds.length} candidate${uniqueIds.length === 1 ? "" : "s"}`}
        </button>
      </div>

      {submitting && <LoadingState label="Fetching CoreSignal payloads + normalizing — can take up to 5 min for 500 IDs" />}

      {error && <ErrorState message={`Fetch failed: ${error}`} />}

      {result && (
        <Panel title="Batch created" eyebrow={`batchId: ${result.batchId}`}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <tbody>
              <tr><td><strong>Fetched</strong></td><td>{result.fetchedCount}</td></tr>
              <tr><td><strong>Failed</strong></td><td>{result.failedCount}</td></tr>
              <tr><td><strong>Row count (normalized)</strong></td><td>{result.rowCount}</td></tr>
              <tr><td><strong>Valid LinkedIn</strong></td><td>{result.validLinkedInCount}</td></tr>
              <tr><td><strong>Valid email</strong></td><td>{result.validEmailCount}</td></tr>
              <tr><td><strong>Duplicates dropped</strong></td><td>{result.duplicateCount}</td></tr>
              <tr><td><strong>Ready to profile</strong></td><td>{result.readyToProfileCount}</td></tr>
              <tr><td><strong>Status</strong></td><td>{result.status}</td></tr>
            </tbody>
          </table>
          {result.failures.length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary>Failures ({result.failures.length})</summary>
              <ul style={{ fontSize: 12, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
                {result.failures.slice(0, 20).map((f) => (
                  <li key={f.id}>id={f.id} status={f.status ?? "n/a"} — {f.error}</li>
                ))}
                {result.failures.length > 20 && <li>… {result.failures.length - 20} more</li>}
              </ul>
            </details>
          )}
          <div style={{ marginTop: 16 }}>
            <button type="button" onClick={goToBatch} style={primaryBtnStyle}>
              View batch → run identity resolve
            </button>
          </div>
        </Panel>
      )}
    </div>
  )
}
