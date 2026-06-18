import type {
  BulkResumeBatch,
  BulkResumeBatchCounts,
  BulkResumeItem,
  BulkResumeItemStatus,
} from "@pa/core-types"

export const BULK_RESUME_BATCHES_COLLECTION = "pa-bulk-upload-batches"
export const BULK_RESUME_ITEMS_SUBCOLLECTION = "items"
export const MAX_RESUME_BYTES = 6 * 1024 * 1024
export const MAX_RESUME_PDF_BYTES = MAX_RESUME_BYTES

export type StatusTone = "ok" | "warn" | "info" | "muted"

export type BulkResumeBatchRow = BulkResumeBatch & { id: string }
export type BulkResumeItemRow = BulkResumeItem & { id: string }

export type BulkResumeItemLike = {
  status?: string | null
}

export type BulkResumeSummary = {
  total: number
  queued: number
  parsing: number
  parsed: number
  review: number
  failed: number
  retryReady: number
}

export type ResumeUploadPayload = {
  fileName: string
  resumeBase64: string
  employerEmailHint?: string
}

export type AddBulkResumeItemPayload = {
  fileName: string
  mimeType: string
  fileSizeBytes: number
  resumeBase64: string
  employerEmailHint?: string
}

export const BULK_RESUME_RETRYABLE_STATUSES: BulkResumeItemStatus[] = [
  "missing_email_review",
  "identity_conflict",
  "parse_failed",
  "failed",
]

export function sanitizeResumeFileName(name: string): string {
  const leaf = name.split(/[\\/]/).pop() ?? "resume.pdf"
  const cleaned = leaf
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned.slice(0, 160) || "resume.pdf"
}

export function sanitizePdfFileName(name: string): string {
  return sanitizeResumeFileName(name)
}

function resumeExtension(fileName: string): "pdf" | "docx" | null {
  const lower = fileName.toLowerCase()
  if (lower.endsWith(".pdf")) return "pdf"
  if (lower.endsWith(".docx")) return "docx"
  return null
}

export function validateResumeFile(file: Pick<File, "name" | "size" | "type">): string | null {
  const fileName = sanitizeResumeFileName(file.name)
  const ext = resumeExtension(fileName)
  if (!ext) return "PDF or DOCX only"
  if (file.size <= 0) return "Empty file"
  if (file.size > MAX_RESUME_BYTES) {
    return `Max ${(MAX_RESUME_BYTES / 1024 / 1024).toFixed(0)}MB`
  }
  if (ext === "pdf" && file.type && file.type !== "application/pdf") return "PDF MIME required"
  if (
    ext === "docx" &&
    file.type &&
    file.type !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document" &&
    file.type !== "application/octet-stream"
  ) {
    return "DOCX MIME required"
  }
  return null
}

export function validatePdfFile(file: Pick<File, "name" | "size" | "type">): string | null {
  return validateResumeFile(file)
}

export function validatePdfFiles(files: readonly Pick<File, "name" | "size" | "type">[]): string | null {
  const invalid = files
    .map((file) => ({ file, error: validateResumeFile(file) }))
    .find((result) => result.error)
  return invalid ? `${sanitizeResumeFileName(invalid.file.name)}: ${invalid.error}` : null
}

export async function fileToResumeUploadPayload(
  file: File,
  employerEmailHint?: string
): Promise<ResumeUploadPayload> {
  const validationError = validateResumeFile(file)
  if (validationError) throw new Error(`${sanitizeResumeFileName(file.name)}: ${validationError}`)
  const resumeBase64 = arrayBufferToBase64(await file.arrayBuffer())
  const trimmedHint = employerEmailHint?.trim()
  return {
    fileName: sanitizeResumeFileName(file.name),
    resumeBase64,
    ...(trimmedHint ? { employerEmailHint: trimmedHint } : {}),
  }
}

export async function buildAddItemPayload(
  file: File,
  employerEmailHint?: string
): Promise<AddBulkResumeItemPayload> {
  const validationError = validateResumeFile(file)
  if (validationError) throw new Error(`${sanitizeResumeFileName(file.name)}: ${validationError}`)
  const trimmedHint = employerEmailHint?.trim()
  const fileName = sanitizeResumeFileName(file.name)
  const ext = resumeExtension(fileName)
  return {
    fileName,
    mimeType: file.type || (ext === "docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/pdf"),
    fileSizeBytes: file.size,
    resumeBase64: arrayBufferToBase64(await file.arrayBuffer()),
    ...(trimmedHint ? { employerEmailHint: trimmedHint } : {}),
  }
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

export function maskEmailForDisplay(email: string | null | undefined): string {
  const value = email?.trim()
  if (!value) return "-"
  const at = value.indexOf("@")
  if (at <= 0) return "***"
  const local = value.slice(0, at)
  const domain = value.slice(at + 1)
  const maskedLocal = local.length <= 2 ? `${local[0] ?? "*"}***` : `${local.slice(0, 2)}***`
  const domainParts = domain.split(".")
  const root = domainParts[0] ?? ""
  const suffix = domainParts.slice(1).join(".")
  const maskedRoot = root.length <= 1 ? "*" : `${root[0]}***`
  return suffix ? `${maskedLocal}@${maskedRoot}.${suffix}` : `${maskedLocal}@${maskedRoot}`
}

export function maskEmail(email: string | null | undefined): string {
  return maskEmailForDisplay(email)
}

export function displayMaskedEmail(masked?: string | null, raw?: string | null): string {
  const trimmedMasked = masked?.trim()
  if (trimmedMasked) return trimmedMasked
  return maskEmailForDisplay(raw)
}

export function statusTone(status: string | null | undefined): StatusTone {
  const normalized = String(status ?? "").toLowerCase()
  if (["completed", "processed", "success", "linked", "done"].includes(normalized)) return "ok"
  if (["failed", "error", "review", "needs_review", "conflict", "identity_conflict"].includes(normalized)) return "warn"
  if (["queued", "pending", "uploaded", "processing", "parsing", "retry_queued"].includes(normalized)) return "info"
  return "muted"
}

export function bulkResumeStatusTone(status: string | null | undefined): StatusTone {
  const normalized = String(status ?? "").toLowerCase()
  if (normalized === "parsed" || normalized === "completed") return "ok"
  if (
    normalized === "missing_email_review" ||
    normalized === "identity_conflict" ||
    normalized === "parse_failed" ||
    normalized === "failed" ||
    normalized === "completed_with_errors"
  ) {
    return "warn"
  }
  if (normalized === "queued" || normalized === "parsing" || normalized === "processing" || normalized === "retry_ready") {
    return "info"
  }
  return "muted"
}

export function canRetryStatus(status: string | null | undefined): boolean {
  const normalized = String(status ?? "").toLowerCase()
  return ["failed", "error", "review", "needs_review", "conflict", "identity_conflict"].includes(normalized)
}

export function canRetryBulkResumeItem(status: string | null | undefined): boolean {
  return BULK_RESUME_RETRYABLE_STATUSES.includes(status as BulkResumeItemStatus)
}

export function summarizeItems(items: readonly BulkResumeItemLike[]): BulkResumeSummary {
  const summary: BulkResumeSummary = {
    total: items.length,
    queued: 0,
    parsing: 0,
    parsed: 0,
    review: 0,
    failed: 0,
    retryReady: 0,
  }
  for (const item of items) {
    const status = String(item.status ?? "").toLowerCase()
    if (status === "queued") summary.queued += 1
    else if (status === "parsing") summary.parsing += 1
    else if (status === "parsed") summary.parsed += 1
    else if (status === "missing_email_review" || status === "identity_conflict") summary.review += 1
    else if (status === "parse_failed" || status === "failed") summary.failed += 1
    else if (status === "retry_ready") summary.retryReady += 1
    else summary.queued += 1
  }
  return summary
}

export function pickCounts(batch: BulkResumeBatchRow | null, items: readonly BulkResumeItemRow[]): BulkResumeBatchCounts {
  if (batch?.counts?.total) return batch.counts
  return summarizeItems(items)
}

export function summarizeProcessResults(results: readonly { status?: string | null; ok?: boolean | null }[]): string {
  if (results.length === 0) return "No results"
  const completed = results.filter((result) => result.ok === true || bulkResumeStatusTone(result.status) === "ok").length
  const review = results.filter((result) => bulkResumeStatusTone(result.status) === "warn" && !["failed", "parse_failed", "error"].includes(String(result.status ?? "").toLowerCase())).length
  const failed = results.filter((result) => ["failed", "parse_failed", "error"].includes(String(result.status ?? "").toLowerCase()) || result.ok === false).length
  return `${completed} completed / ${review} review / ${failed} failed`
}

export function timestampToIso(value: unknown): string | null {
  if (!value) return null
  if (typeof value === "string") return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "object") {
    const candidate = value as { toDate?: () => Date; seconds?: unknown }
    if (typeof candidate.toDate === "function") return candidate.toDate().toISOString()
    if (typeof candidate.seconds === "number" && Number.isFinite(candidate.seconds)) {
      return new Date(candidate.seconds * 1000).toISOString()
    }
  }
  return null
}

export function formatBulkTimestamp(value: unknown): string {
  return timestampToIso(value)?.slice(0, 16) ?? "-"
}
