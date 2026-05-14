/**
 * Manual CSV adapter — loose-schema operator-defined CSV / XLSX import.
 *
 * v2 (2026-05-14) — `manual-csv-2026-05-B`:
 *   - When no `columnMapping` arrives, `inferColumnMapping` runs against the
 *     header row and synthesizes a best-effort mapping. The 6 stable Lessie
 *     headers (Name / Link / Email / Company / Headline / Title|Job Title)
 *     plus location variants get bound automatically. Operator override
 *     still wins on conflict.
 *   - XLSX shape now parses through `@pa/external-supply/sheet`. CSV / TSV
 *     parse via `parseSheetToRows` so all three shapes share one helper.
 *   - Headers that don't match a canonical field become rubric criteria.
 *     Each cell preserves the original value, plus a `passed: true | false
 *     | null` hint classified from the cell prefix (✅ / ❌ / "Pass" / "Fail").
 *     Stored in `enrichment.rubric` + `rawPayload` for downstream tag merge
 *     and dashboard rendering.
 *   - `Match` / `Score` headers feed `enrichment.matchScore` for the list-
 *     view sort. Not promoted to a canonical record field — preserved
 *     verbatim as a string.
 *
 * Adapter version: `manual-csv-2026-05-B`.
 */
import type { ExternalCandidateRecord } from "@pa/core-types"
import {
  canonicalizeLinkedInUrl,
  classifyRubricCell,
  emailHash,
  inferColumnMapping,
  linkedinHash,
  normalizeEmail,
  normalizePhoneE164,
  parseSheetToRows,
  phoneHash,
  sniffSheetKind,
  VIRTUAL_LOCATION_PARTS_HEADER,
  type AdapterSignature,
  type InferColumnMappingResult,
  type ManualCsvColumnMappingShape,
  type RubricCellValue,
  type SheetKind,
} from "@pa/external-supply"

export const MANUAL_CSV_ADAPTER_VERSION = "manual-csv-2026-05-B"

/**
 * Detection fingerprint for {@link detectAdapter}. Fallback adapter — empty
 * `requiredKeys` means it always wins the floor when nothing else clears
 * the 0.6 lock threshold (L-B4). v2 adds `xlsx` to accepted shapes.
 */
export const MANUAL_CSV_SIGNATURE: AdapterSignature = {
  source: "manual_csv",
  requiredKeys: [],
  bonusKeys: [],
  acceptedShapes: ["csv", "tsv", "xlsx"],
  adapterVersion: MANUAL_CSV_ADAPTER_VERSION,
}

export type NormalizedRecordDraft = Omit<
  ExternalCandidateRecord,
  "recordId" | "batchId" | "createdAt"
>

/**
 * Operator-supplied mapping from canonical field → CSV header. The keys
 * are the canonical names; the values are header strings from the CSV.
 *
 * v2 — every field is optional. If none are supplied, the adapter calls
 * {@link inferColumnMapping} against the header row and proceeds with the
 * inferred mapping. At least one of `linkedinUrl` / `email` must be
 * resolvable (mapped + present in a row) for that row to clear the
 * identity gate.
 */
export type ManualCsvColumnMapping = ManualCsvColumnMappingShape

type ManualCsvRow = Record<string, string | undefined>

function nonEmpty(s: string | null | undefined): string | undefined {
  if (!s) return undefined
  const trimmed = String(s).trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function readCol(row: ManualCsvRow, header: string | undefined): string | undefined {
  if (!header) return undefined
  return nonEmpty(row[header])
}

/**
 * Pull a virtual location string from split `Country`/`State`/`City` columns
 * when `columnMapping.location` is the `__locationParts__` sentinel.
 */
function readLocation(
  row: ManualCsvRow,
  columnMapping: ManualCsvColumnMapping,
  inferred: InferColumnMappingResult | null,
): string | undefined {
  const mapped = columnMapping.location
  if (!mapped) return undefined
  if (mapped !== VIRTUAL_LOCATION_PARTS_HEADER) return readCol(row, mapped)
  const parts = inferred?.locationParts ?? {}
  const segments = [
    readCol(row, parts.city),
    readCol(row, parts.state),
    readCol(row, parts.country),
  ].filter((s): s is string => Boolean(s))
  if (segments.length === 0) return undefined
  return segments.join(", ")
}

function extractRubric(
  row: ManualCsvRow,
  rubricColumns: string[],
): Record<string, RubricCellValue> {
  const out: Record<string, RubricCellValue> = {}
  for (const col of rubricColumns) {
    const raw = row[col]
    const cell = classifyRubricCell(raw)
    if (cell.value.length === 0 && cell.passed === null) continue
    out[col] = cell
  }
  return out
}

/**
 * Merge operator-supplied mapping over auto-inferred mapping. Operator
 * wins. Empty / undefined operator values fall through to the inference.
 */
function mergeMappings(
  inferred: ManualCsvColumnMapping,
  override: ManualCsvColumnMapping | undefined,
): ManualCsvColumnMapping {
  if (!override) return { ...inferred }
  const out: ManualCsvColumnMapping = { ...inferred }
  for (const [k, v] of Object.entries(override) as [keyof ManualCsvColumnMapping, string][]) {
    if (v && v.length > 0) out[k] = v
  }
  return out
}

export interface ParseManualSheetOptions {
  /** Inferred mapping result so caller can read split-location helpers. */
  inferred?: InferColumnMappingResult | null
}

/**
 * Parse an operator-defined CSV string (existing call-site shape). Kept
 * for backwards-compat with V1 callers / tests; new callers should prefer
 * {@link parseManualSheetBuffer} which handles xlsx + auto-infer too.
 */
export function parseManualCsvExport(
  input: string | ManualCsvRow[],
  columnMapping: ManualCsvColumnMapping,
  options: ParseManualSheetOptions = {},
): NormalizedRecordDraft[] {
  let rows: ManualCsvRow[]
  let inferred: InferColumnMappingResult | null = options.inferred ?? null
  if (typeof input === "string") {
    const parsed = parseSheetToRows(Buffer.from(input, "utf8"), "csv")
    rows = parsed.rows
    if (!inferred) inferred = inferColumnMapping(parsed.headers)
  } else {
    rows = input
    if (!inferred && rows.length > 0) {
      inferred = inferColumnMapping(Object.keys(rows[0] ?? {}))
    }
  }
  const effectiveMapping = mergeMappings(inferred?.mapping ?? {}, columnMapping)
  if (!effectiveMapping.linkedinUrl && !effectiveMapping.email) {
    throw new Error("manual_csv_requires_linkedin_or_email_mapping")
  }
  return rows.map((row) =>
    normalizeRow(row, effectiveMapping, inferred?.rubricColumns ?? [], inferred),
  )
}

/**
 * Parse a raw buffer (csv / tsv / xlsx). Auto-detects sheet kind from the
 * filename (falls back to magic bytes). Returns drafts plus the inferred
 * mapping + rubric column list for the caller to surface in the UI.
 */
export function parseManualSheetBuffer(
  raw: Buffer,
  filename: string,
  columnMapping: ManualCsvColumnMapping | undefined,
): {
  drafts: NormalizedRecordDraft[]
  inferred: InferColumnMappingResult
  effectiveMapping: ManualCsvColumnMapping
  sheetKind: SheetKind
} {
  const sheetKind = sniffSheetKind(filename, raw)
  const parsed = parseSheetToRows(raw, sheetKind)
  const inferred = inferColumnMapping(parsed.headers)
  const effectiveMapping = mergeMappings(inferred.mapping, columnMapping)
  if (!effectiveMapping.linkedinUrl && !effectiveMapping.email) {
    throw new Error("manual_csv_requires_linkedin_or_email_mapping")
  }
  const drafts = parsed.rows.map((row) =>
    normalizeRow(row, effectiveMapping, inferred.rubricColumns, inferred),
  )
  return { drafts, inferred, effectiveMapping, sheetKind }
}

function normalizeRow(
  row: ManualCsvRow,
  columnMapping: ManualCsvColumnMapping,
  rubricColumns: string[],
  inferred: InferColumnMappingResult | null,
): NormalizedRecordDraft {
  const errors: string[] = []

  const linkedinRaw = readCol(row, columnMapping.linkedinUrl)
  const canonical = linkedinRaw ? canonicalizeLinkedInUrl(linkedinRaw) : null
  if (linkedinRaw && !canonical) errors.push("linkedin_url_invalid")

  const emailRaw = readCol(row, columnMapping.email)
  const normalizedEmail = emailRaw ? normalizeEmail(emailRaw) : null
  if (emailRaw && !normalizedEmail) errors.push("email_invalid")

  const phoneRaw = readCol(row, columnMapping.phone)
  let phoneE164: string | null = null
  if (phoneRaw) {
    const phoneResult = normalizePhoneE164(phoneRaw)
    if (phoneResult.ok) {
      phoneE164 = phoneResult.value
    } else {
      errors.push("phone_not_e164")
    }
  }

  const skillsRaw = readCol(row, columnMapping.skills)
  const sourceTags = skillsRaw
    ? skillsRaw
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : []

  const hasIdentitySignal = Boolean(canonical) || Boolean(normalizedEmail)
  const status: NormalizedRecordDraft["normalizationStatus"] = hasIdentitySignal
    ? errors.length > 0
      ? "partial"
      : "ok"
    : "failed"

  const rubric = extractRubric(row, rubricColumns)
  const matchScoreRaw = inferred?.matchScoreColumn
    ? readCol(row, inferred.matchScoreColumn)
    : undefined

  const enrichment: Record<string, unknown> = {}
  if (Object.keys(rubric).length > 0) enrichment.rubric = rubric
  if (matchScoreRaw) enrichment.matchScore = matchScoreRaw
  // Stash the headline (Lessie's free-text profile blurb) as a top-level
  // enrichment field so the candidate browser can show it without parsing
  // rubric chips.
  const headline = readCol(row, "Headline")
  if (headline) enrichment.headline = headline

  const draft: NormalizedRecordDraft = {
    source: "manual_csv",
    rawPayload: { ...row } as Record<string, unknown>,
    emails: normalizedEmail
      ? [{ value: normalizedEmail, hash: emailHash(normalizedEmail) }]
      : [],
    experience: [],
    education: [],
    sourceTags,
    normalizationStatus: status,
    identityResolutionStatus: "pending",
    evidence: [],
  }
  if (Object.keys(enrichment).length > 0) draft.enrichment = enrichment
  if (canonical) {
    draft.canonicalLinkedInUrl = canonical
    draft.linkedinProfileHash = linkedinHash(canonical)
  }
  if (phoneE164) {
    draft.phoneHash = phoneHash(phoneE164)
  }
  const name = readCol(row, columnMapping.name)
  if (name) draft.name = name
  const title = readCol(row, columnMapping.currentTitle)
  if (title) draft.currentTitle = title
  const company = readCol(row, columnMapping.currentCompany)
  if (company) draft.currentCompany = company
  const location = readLocation(row, columnMapping, inferred)
  if (location) draft.location = location
  if (errors.length > 0) draft.normalizationErrors = errors

  return draft
}
