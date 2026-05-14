/**
 * Manual CSV adapter — operator-defined CSV import.
 *
 * Differs from `lessie.ts` in one way: the operator supplies a
 * `columnMapping` that names which CSV header maps to each canonical field.
 * At least one of `linkedinUrl` / `email` is required so the row has an
 * identity signal.
 *
 * Adapter version: `manual-csv-2026-05-A`.
 */
import { parse as csvParse } from "csv-parse/sync"
import type { ExternalCandidateRecord } from "@pa/core-types"
import {
  canonicalizeLinkedInUrl,
  emailHash,
  linkedinHash,
  normalizeEmail,
  normalizePhoneE164,
  phoneHash,
  type AdapterSignature,
} from "@pa/external-supply"

export const MANUAL_CSV_ADAPTER_VERSION = "manual-csv-2026-05-A"

/**
 * Detection fingerprint for {@link detectAdapter}. Fallback adapter — empty
 * `requiredKeys` means it always wins the floor when nothing else clears
 * the 0.6 lock threshold (L-B4).
 */
export const MANUAL_CSV_SIGNATURE: AdapterSignature = {
  source: "manual_csv",
  requiredKeys: [],
  bonusKeys: [],
  acceptedShapes: ["csv", "tsv"],
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
 * At least one of `linkedinUrl` or `email` must be provided.
 */
export interface ManualCsvColumnMapping {
  linkedinUrl?: string
  email?: string
  phone?: string
  name?: string
  currentTitle?: string
  currentCompany?: string
  location?: string
  skills?: string
}

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
 * Parse an operator-defined CSV. Accepts a CSV string or pre-parsed rows.
 */
export function parseManualCsvExport(
  input: string | ManualCsvRow[],
  columnMapping: ManualCsvColumnMapping,
): NormalizedRecordDraft[] {
  if (!columnMapping.linkedinUrl && !columnMapping.email) {
    throw new Error("manual_csv_requires_linkedin_or_email_mapping")
  }
  const rows: ManualCsvRow[] = typeof input === "string"
    ? (csvParse(input, {
        columns: true,
        trim: true,
        skip_empty_lines: true,
        relax_column_count: true,
      }) as ManualCsvRow[])
    : input

  return rows.map((row) => normalizeRow(row, columnMapping))
}

function normalizeRow(
  row: ManualCsvRow,
  columnMapping: ManualCsvColumnMapping,
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
  const location = readCol(row, columnMapping.location)
  if (location) draft.location = location
  if (errors.length > 0) draft.normalizationErrors = errors

  return draft
}
