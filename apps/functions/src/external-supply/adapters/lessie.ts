/**
 * Lessie adapter — parses Lessie's CSV export (header row + comma-separated
 * rows). Lessie publishes a fixed column set; we read by header name so the
 * adapter survives column reordering.
 *
 * Column mapping is fixed by Lessie's export format:
 *  - `LinkedIn URL` → canonicalLinkedInUrl
 *  - `Email` → emails[0]
 *  - `Name` → name
 *  - `Title` → currentTitle
 *  - `Company` → currentCompany
 *  - `Location` → location
 *  - `Phone` → phoneHash (optional)
 *  - `Skills` → sourceTags (semicolon-separated, optional)
 *
 * Adapter version: `lessie-2026-05-A`.
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
} from "@pa/external-supply"

export const LESSIE_ADAPTER_VERSION = "lessie-2026-05-A"

export type NormalizedRecordDraft = Omit<
  ExternalCandidateRecord,
  "recordId" | "batchId" | "createdAt"
>

type LessieRow = Record<string, string | undefined>

function nonEmpty(s: string | null | undefined): string | undefined {
  if (!s) return undefined
  const trimmed = String(s).trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Parse a Lessie CSV export. Accepts either a CSV string or an array of
 * already-parsed row records (for unit tests). Throws on malformed CSV.
 */
export function parseLessieExport(input: string | LessieRow[]): NormalizedRecordDraft[] {
  const rows: LessieRow[] = typeof input === "string"
    ? (csvParse(input, {
        columns: true,
        trim: true,
        skip_empty_lines: true,
        relax_column_count: true,
      }) as LessieRow[])
    : input

  return rows.map((row) => normalizeRow(row))
}

function normalizeRow(row: LessieRow): NormalizedRecordDraft {
  const errors: string[] = []

  const linkedinRaw = nonEmpty(row["LinkedIn URL"])
  const canonical = linkedinRaw ? canonicalizeLinkedInUrl(linkedinRaw) : null
  if (linkedinRaw && !canonical) errors.push("linkedin_url_invalid")

  const emailRaw = nonEmpty(row["Email"])
  const normalizedEmail = emailRaw ? normalizeEmail(emailRaw) : null
  if (emailRaw && !normalizedEmail) errors.push("email_invalid")

  const phoneRaw = nonEmpty(row["Phone"])
  let phoneE164: string | null = null
  if (phoneRaw) {
    const phoneResult = normalizePhoneE164(phoneRaw)
    if (phoneResult.ok) {
      phoneE164 = phoneResult.value
    } else {
      errors.push("phone_not_e164")
    }
  }

  const skillsCsv = nonEmpty(row["Skills"])
  const sourceTags = skillsCsv
    ? skillsCsv
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
    source: "lessie",
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
  if (nonEmpty(row["Name"])) draft.name = nonEmpty(row["Name"])
  if (nonEmpty(row["Title"])) draft.currentTitle = nonEmpty(row["Title"])
  if (nonEmpty(row["Company"])) draft.currentCompany = nonEmpty(row["Company"])
  if (nonEmpty(row["Location"])) draft.location = nonEmpty(row["Location"])
  if (errors.length > 0) draft.normalizationErrors = errors

  return draft
}
