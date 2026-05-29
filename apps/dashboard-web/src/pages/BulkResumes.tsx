import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react"
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore"
import { httpsCallable } from "firebase/functions"
import { FileText, Play, Plus, RefreshCw, Upload } from "lucide-react"
import { AdminJobLink, AdminUserLink } from "../components/AdminEntityLink.js"
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  type DataTableColumn,
} from "../components/ui.js"
import { db, functions } from "../lib/firebase.js"
import {
  BULK_RESUME_BATCHES_COLLECTION,
  BULK_RESUME_ITEMS_SUBCOLLECTION,
  bulkResumeStatusTone,
  canRetryBulkResumeItem,
  fileToResumeUploadPayload,
  maskEmailForDisplay,
  sanitizePdfFileName,
  summarizeItems,
  summarizeProcessResults,
  timestampToIso,
  validatePdfFile,
  type ResumeUploadPayload,
} from "./BulkResumes.helpers.js"

type BulkResumeBatch = {
  id: string
  batchId: string
  label: string
  source?: string
  jobId?: string
  createdBy?: string
  status?: string
  counts?: Record<string, number>
  createdAt?: string | null
  updatedAt?: string | null
}

type BulkResumeItem = {
  id: string
  itemId: string
  batchId?: string
  fileName?: string
  fileSha256?: string
  fileSizeBytes?: number
  storageUri?: string
  employerEmailHintMasked?: string
  extractedEmailMasked?: string
  status?: string
  candidateId?: string
  resumeArtifactId?: string
  parsedCandidateResumeId?: string
  conflictId?: string
  retryCount?: number
  errorReason?: string
  createdAt?: string | null
  updatedAt?: string | null
  lastProcessedAt?: string | null
}

type PendingFile = {
  id: string
  file: File
  fileName: string
  fileSizeBytes: number
  validationError: string | null
  employerEmailHint: string
}

type ActionKey = "create" | "upload" | "process" | `retry:${string}`

type CreateBatchInput = { label: string; jobId?: string }
type CreateBatchResult = { ok: true; batch: BulkResumeBatch }
type AddItemsInput = { batchId: string; items: ResumeUploadPayload[] }
type AddItemsResult = { ok: true; items: BulkResumeItem[]; batch: BulkResumeBatch }
type ProcessBatchInput = { batchId: string; limit?: number }
type ProcessBatchResult = { ok: true; results: { status?: string | null; ok?: boolean | null }[]; batch: BulkResumeBatch }
type RetryItemInput = { batchId: string; itemId: string }
type RetryItemResult = { ok: true; item: BulkResumeItem; batch: BulkResumeBatch }

const iconStyle = { width: 15, height: 15, verticalAlign: "-2px", marginRight: 6 }

export default function BulkResumes() {
  const [batches, setBatches] = useState<BulkResumeBatch[]>([])
  const [items, setItems] = useState<BulkResumeItem[]>([])
  const [selectedBatchId, setSelectedBatchId] = useState("")
  const [label, setLabel] = useState("")
  const [jobId, setJobId] = useState("")
  const [processLimit, setProcessLimit] = useState("25")
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [loadingBatches, setLoadingBatches] = useState(true)
  const [loadingItems, setLoadingItems] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<ActionKey | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setLoadingBatches(true)
    setError(null)
    const q = query(collection(db(), BULK_RESUME_BATCHES_COLLECTION), orderBy("updatedAt", "desc"), limit(50))
    return onSnapshot(
      q,
      (snap) => {
        setBatches(snap.docs.map((docSnap) => normalizeBatch(docSnap.id, docSnap.data())))
        setLoadingBatches(false)
      },
      (e) => {
        setError(e.message)
        setLoadingBatches(false)
      }
    )
  }, [])

  useEffect(() => {
    if (selectedBatchId || batches.length === 0) return
    setSelectedBatchId(batches[0]!.batchId)
  }, [batches, selectedBatchId])

  useEffect(() => {
    if (!selectedBatchId) {
      setItems([])
      return
    }
    setLoadingItems(true)
    const q = query(
      collection(db(), BULK_RESUME_BATCHES_COLLECTION, selectedBatchId, BULK_RESUME_ITEMS_SUBCOLLECTION),
      orderBy("updatedAt", "desc"),
      limit(250)
    )
    return onSnapshot(
      q,
      (snap) => {
        setItems(snap.docs.map((docSnap) => normalizeItem(docSnap.id, docSnap.data())))
        setLoadingItems(false)
      },
      (e) => {
        setError(e.message)
        setLoadingItems(false)
      }
    )
  }, [selectedBatchId])

  const selectedBatch = useMemo(
    () => batches.find((batch) => batch.batchId === selectedBatchId) ?? null,
    [batches, selectedBatchId]
  )
  const visibleSummary = useMemo(() => summarizeItems(items), [items])
  const invalidPendingCount = pendingFiles.filter((row) => row.validationError).length

  async function createBatch(): Promise<void> {
    const trimmedLabel = label.trim()
    if (!trimmedLabel) return
    setBusy("create")
    setError(null)
    setNotice(null)
    try {
      const fn = httpsCallable<CreateBatchInput, CreateBatchResult>(functions(), "paBulkResumeCreateBatch")
      const res = await fn({
        label: trimmedLabel,
        ...(jobId.trim() ? { jobId: jobId.trim() } : {}),
      })
      setSelectedBatchId(res.data.batch.batchId)
      setLabel("")
      setJobId("")
      setNotice("Batch created")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  function selectFiles(files: FileList | null): void {
    const next = Array.from(files ?? []).map((file, index) => ({
      id: `${file.name}:${file.size}:${file.lastModified}:${index}`,
      file,
      fileName: sanitizePdfFileName(file.name),
      fileSizeBytes: file.size,
      validationError: validatePdfFile(file),
      employerEmailHint: "",
    }))
    setPendingFiles(next)
    setNotice(null)
    setError(null)
  }

  async function uploadItems(): Promise<void> {
    if (!selectedBatchId || pendingFiles.length === 0 || invalidPendingCount > 0) return
    setBusy("upload")
    setError(null)
    setNotice(null)
    try {
      const fn = httpsCallable<AddItemsInput, AddItemsResult>(functions(), "paBulkResumeAddItems")
      let uploaded = 0
      for (const row of pendingFiles) {
        const payload = await fileToResumeUploadPayload(row.file, row.employerEmailHint)
        const res = await fn({ batchId: selectedBatchId, items: [payload] })
        uploaded += res.data.items.length
      }
      setPendingFiles([])
      if (fileInputRef.current) fileInputRef.current.value = ""
      setNotice(`${uploaded} item(s) uploaded`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function processBatch(): Promise<void> {
    if (!selectedBatchId) return
    const parsedLimit = Number.parseInt(processLimit, 10)
    setBusy("process")
    setError(null)
    setNotice(null)
    try {
      const fn = httpsCallable<ProcessBatchInput, ProcessBatchResult>(functions(), "paBulkResumeProcessBatch")
      const res = await fn({
        batchId: selectedBatchId,
        ...(Number.isFinite(parsedLimit) && parsedLimit > 0 ? { limit: parsedLimit } : {}),
      })
      setNotice(summarizeProcessResults(res.data.results))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function retryItem(itemId: string): Promise<void> {
    if (!selectedBatchId) return
    setBusy(`retry:${itemId}`)
    setError(null)
    setNotice(null)
    try {
      const fn = httpsCallable<RetryItemInput, RetryItemResult>(functions(), "paBulkResumeRetryItem")
      await fn({ batchId: selectedBatchId, itemId })
      setNotice("Retry queued")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  if (loadingBatches) return <LoadingState label="Loading bulk resume batches..." />

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Admin" title="Bulk Resumes" />
      {error ? <ErrorState message={error} /> : null}
      {notice ? <div className="notice notice-good">{notice}</div> : null}

      <div className="split-grid">
        <Panel title="Batch" eyebrow={BULK_RESUME_BATCHES_COLLECTION}>
          <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Batch label"
              disabled={busy !== null}
              style={{ minWidth: "14rem" }}
            />
            <input
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
              placeholder="jobId"
              disabled={busy !== null}
              style={{ minWidth: "10rem", maxWidth: "16rem" }}
            />
            <input value="admin_upload" placeholder="source" disabled style={{ minWidth: "10rem", maxWidth: "16rem" }} />
            <button type="button" onClick={() => void createBatch()} disabled={busy !== null || !label.trim()}>
              <Plus style={iconStyle} />
              {busy === "create" ? "Creating..." : "Create"}
            </button>
          </div>

          <select
            value={selectedBatchId}
            onChange={(e) => setSelectedBatchId(e.target.value)}
            disabled={busy !== null || batches.length === 0}
            style={{ width: "100%", marginBottom: "0.75rem" }}
          >
            {batches.length === 0 ? <option value="">No batches</option> : null}
            {batches.map((batch) => (
              <option key={batch.batchId} value={batch.batchId}>
                {batch.label || batch.batchId} · {batch.status ?? "unknown"} · {formatTime(batch.updatedAt)}
              </option>
            ))}
          </select>

          {selectedBatch ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.45rem" }}>
              <CountBadge label="total" value={batchCount(selectedBatch, "total", visibleSummary.total)} tone="muted" />
              <CountBadge label="queued" value={batchCount(selectedBatch, "queued", visibleSummary.queued)} tone="info" />
              <CountBadge label="parsing" value={batchCount(selectedBatch, "parsing", visibleSummary.parsing)} tone="info" />
              <CountBadge label="parsed" value={batchCount(selectedBatch, "parsed", visibleSummary.parsed)} tone="ok" />
              <CountBadge
                label="retry ready"
                value={batchCount(selectedBatch, "retryReady", visibleSummary.retryReady)}
                tone="info"
              />
              <CountBadge label="review" value={batchCount(selectedBatch, "review", visibleSummary.review)} tone="warn" />
              <CountBadge label="failed" value={batchCount(selectedBatch, "failed", visibleSummary.failed)} tone="warn" />
            </div>
          ) : null}
        </Panel>

        <Panel title="Process" eyebrow={selectedBatch?.status ?? "no batch"}>
          <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
            <input
              type="number"
              min={1}
              max={100}
              value={processLimit}
              onChange={(e) => setProcessLimit(e.target.value)}
              disabled={busy !== null || !selectedBatchId}
              style={{ minWidth: "6rem", maxWidth: "9rem" }}
            />
            <button type="button" onClick={() => void processBatch()} disabled={busy !== null || !selectedBatchId}>
              <Play style={iconStyle} />
              {busy === "process" ? "Processing..." : "Process"}
            </button>
          </div>
          <BatchMeta batch={selectedBatch} />
        </Panel>
      </div>

      <Panel title="Upload" eyebrow={selectedBatchId || "select batch"}>
        <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            onChange={(e) => selectFiles(e.currentTarget.files)}
            disabled={busy !== null || !selectedBatchId}
          />
          <button
            type="button"
            onClick={() => void uploadItems()}
            disabled={busy !== null || !selectedBatchId || pendingFiles.length === 0 || invalidPendingCount > 0}
          >
            <Upload style={iconStyle} />
            {busy === "upload" ? "Uploading..." : `Upload ${pendingFiles.length || ""}`.trim()}
          </button>
        </div>
        <PendingFilesTable rows={pendingFiles} setRows={setPendingFiles} />
      </Panel>

      <Panel title={`${items.length} item(s)`} eyebrow={selectedBatchId || "items"}>
        {loadingItems ? (
          <LoadingState label="Loading items..." />
        ) : (
          <DataTable<BulkResumeItem>
            rows={items}
            empty={<EmptyState title="No items" body="No PDFs uploaded for this batch." />}
            columns={itemColumns(busy, retryItem)}
          />
        )}
      </Panel>
    </div>
  )
}

function normalizeBatch(id: string, data: Record<string, unknown>): BulkResumeBatch {
  return {
    id,
    batchId: String(data.batchId ?? id),
    label: String(data.label ?? id),
    source: stringOrUndefined(data.source),
    jobId: stringOrUndefined(data.jobId),
    createdBy: stringOrUndefined(data.createdBy),
    status: stringOrUndefined(data.status),
    counts: typeof data.counts === "object" && data.counts ? (data.counts as Record<string, number>) : undefined,
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  }
}

function normalizeItem(id: string, data: Record<string, unknown>): BulkResumeItem {
  return {
    id,
    itemId: String(data.itemId ?? id),
    batchId: stringOrUndefined(data.batchId),
    fileName: stringOrUndefined(data.fileName),
    fileSha256: stringOrUndefined(data.fileSha256),
    fileSizeBytes: numberOrUndefined(data.fileSizeBytes),
    storageUri: stringOrUndefined(data.storageUri),
    employerEmailHintMasked: stringOrUndefined(data.employerEmailHintMasked),
    extractedEmailMasked: stringOrUndefined(data.extractedEmailMasked),
    status: stringOrUndefined(data.status),
    candidateId: stringOrUndefined(data.candidateId),
    resumeArtifactId: stringOrUndefined(data.resumeArtifactId),
    parsedCandidateResumeId: stringOrUndefined(data.parsedCandidateResumeId),
    conflictId: stringOrUndefined(data.conflictId),
    retryCount: numberOrUndefined(data.retryCount),
    errorReason: stringOrUndefined(data.errorReason),
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
    lastProcessedAt: timestampToIso(data.lastProcessedAt),
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function batchCount(batch: BulkResumeBatch, key: string, fallback: number): number {
  const direct = batch.counts?.[key]
  if (typeof direct === "number" && Number.isFinite(direct)) return direct
  if (key === "parsed") {
    const processed = batch.counts?.processed
    if (typeof processed === "number" && Number.isFinite(processed)) return processed
  }
  return fallback
}

function CountBadge({ label, value, tone }: { label: string; value: number; tone: "ok" | "warn" | "info" | "muted" }) {
  return (
    <Badge tone={tone}>
      {label} {value}
    </Badge>
  )
}

function BatchMeta({ batch }: { batch: BulkResumeBatch | null }) {
  if (!batch) return <EmptyState title="No batch selected" body="Create or select a batch." />
  return (
    <div style={{ display: "grid", gap: "0.35rem", fontSize: "0.86rem" }}>
      <MetaRow label="batchId" value={batch.batchId} />
      <MetaRow label="source" value={batch.source ?? "-"} />
      <MetaRow label="jobId" value={batch.jobId ? <AdminJobLink jobId={batch.jobId} /> : "-"} />
      <MetaRow label="createdBy" value={batch.createdBy ?? "-"} />
      <MetaRow label="updated" value={formatTime(batch.updatedAt)} />
    </div>
  )
}

function MetaRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "7rem minmax(0, 1fr)", gap: "0.5rem" }}>
      <span className="muted-copy">{label}</span>
      <code style={{ overflowWrap: "anywhere" }}>{value}</code>
    </div>
  )
}

function PendingFilesTable({
  rows,
  setRows,
}: {
  rows: PendingFile[]
  setRows: Dispatch<SetStateAction<PendingFile[]>>
}) {
  if (rows.length === 0) return <EmptyState title="No pending files" body="Choose one or more PDFs." />
  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Size</th>
            <th>Employer hint</th>
            <th>Preview</th>
            <th>Validation</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td style={{ minWidth: "14rem", overflowWrap: "anywhere" }}>
                <FileText style={iconStyle} />
                {row.fileName}
              </td>
              <td>{formatBytes(row.fileSizeBytes)}</td>
              <td>
                <input
                  type="password"
                  autoComplete="off"
                  value={row.employerEmailHint}
                  placeholder="email hint"
                  onChange={(e) =>
                    setRows((current) =>
                      current.map((entry) =>
                        entry.id === row.id ? { ...entry, employerEmailHint: e.target.value } : entry
                      )
                    )
                  }
                  style={{ width: "100%", minWidth: "12rem" }}
                />
              </td>
              <td>{maskEmailForDisplay(row.employerEmailHint)}</td>
              <td>
                {row.validationError ? (
                  <Badge tone="warn">{row.validationError}</Badge>
                ) : (
                  <Badge tone="ok">ready</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function itemColumns(
  busy: ActionKey | null,
  retryItem: (itemId: string) => Promise<void>
): DataTableColumn<BulkResumeItem>[] {
  return [
    {
      key: "fileName",
      header: "File",
      render: (row) => (
        <span style={{ overflowWrap: "anywhere" }}>
          <FileText style={iconStyle} />
          {row.fileName ?? row.itemId}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => <Badge tone={bulkResumeStatusTone(row.status)}>{row.status ?? "unknown"}</Badge>,
    },
    { key: "hint", header: "Hint", render: (row) => row.employerEmailHintMasked ?? "-" },
    { key: "extracted", header: "Extracted", render: (row) => row.extractedEmailMasked ?? "-" },
    { key: "candidate", header: "Candidate", render: (row) => renderCandidateLink(row.candidateId) },
    { key: "resume", header: "Resume", render: (row) => renderResumeLink(row) },
    { key: "conflict", header: "Conflict", render: (row) => compactCell(row.conflictId) },
    { key: "retryCount", header: "Retry", render: (row) => String(row.retryCount ?? 0) },
    { key: "error", header: "Error", render: (row) => compactCell(row.errorReason, 180) },
    { key: "updated", header: "Updated", render: (row) => formatTime(row.updatedAt ?? row.lastProcessedAt) },
    {
      key: "actions",
      header: "",
      render: (row) =>
        canRetryBulkResumeItem(row.status) ? (
          <button
            type="button"
            onClick={() => void retryItem(row.itemId)}
            disabled={busy !== null}
            title="Retry item"
          >
            <RefreshCw style={iconStyle} />
            {busy === `retry:${row.itemId}` ? "Retrying..." : "Retry"}
          </button>
        ) : (
          "-"
        ),
    },
  ]
}

function compactCell(value: string | undefined, max = 18): string {
  if (!value) return "-"
  return value.length > max ? `${value.slice(0, max)}...` : value
}

function renderCandidateLink(candidateId: string | undefined) {
  if (!candidateId) return "-"
  return <AdminUserLink userId={candidateId}>{compactCell(candidateId)}</AdminUserLink>
}

function renderResumeLink(item: BulkResumeItem) {
  const resumeId = item.resumeArtifactId ?? item.parsedCandidateResumeId
  if (!resumeId) return "-"
  if (!item.candidateId) return compactCell(resumeId)
  return (
    <AdminUserLink userId={item.candidateId} fragment={resumeId}>
      {compactCell(resumeId)}
    </AdminUserLink>
  )
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "-"
  return value.slice(0, 19).replace("T", " ")
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
