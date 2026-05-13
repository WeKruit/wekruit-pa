/**
 * Juicebox adapter — parses the JSON array shape Juicebox emits.
 *
 * Column mapping is fixed by Juicebox's export format:
 *  - `linkedin_url` → canonicalLinkedInUrl
 *  - `email_primary` → emails[0]
 *  - `full_name` → name
 *  - `current_position` → currentTitle
 *  - `current_company_name` → currentCompany
 *  - `location_string` → location
 *  - `experience_array` → experience
 *  - `education_array` → education
 *  - `skills` → sourceTags
 *
 * Adapter version: `juicebox-2026-05-A`. Each output draft carries
 * `rawPayload` verbatim so we can rerun parse with newer logic later.
 */
import type { ExternalCandidateRecord } from "@pa/core-types"
import {
  canonicalizeLinkedInUrl,
  emailHash,
  linkedinHash,
  normalizeEmail,
  normalizePhoneE164,
  phoneHash,
} from "@pa/external-supply"

export const JUICEBOX_ADAPTER_VERSION = "juicebox-2026-05-A"

export type NormalizedRecordDraft = Omit<
  ExternalCandidateRecord,
  "recordId" | "batchId" | "createdAt"
>

interface JuiceboxExperience {
  company?: string
  title?: string
  startDate?: string | null
  endDate?: string | null
  durationMonths?: number
}

interface JuiceboxEducation {
  school?: string
  degree?: string | null
  field?: string | null
  endYear?: number | null
}

interface JuiceboxRow {
  linkedin_url?: string | null
  email_primary?: string | null
  phone?: string | null
  full_name?: string | null
  current_position?: string | null
  current_company_name?: string | null
  location_string?: string | null
  experience_array?: JuiceboxExperience[] | null
  education_array?: JuiceboxEducation[] | null
  skills?: string[] | null
  enrichment?: Record<string, unknown> | null
}

function nonEmpty(s: string | null | undefined): string | undefined {
  if (!s) return undefined
  const trimmed = String(s).trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function mapExperience(items: JuiceboxExperience[] | null | undefined): NormalizedRecordDraft["experience"] {
  if (!items || !Array.isArray(items)) return []
  return items
    .filter((it) => nonEmpty(it.company) && nonEmpty(it.title))
    .map((it) => {
      const out: NormalizedRecordDraft["experience"][number] = {
        company: nonEmpty(it.company)!,
        title: nonEmpty(it.title)!,
      }
      if (nonEmpty(it.startDate)) out.startDate = nonEmpty(it.startDate)
      if (nonEmpty(it.endDate)) out.endDate = nonEmpty(it.endDate)
      if (typeof it.durationMonths === "number" && it.durationMonths >= 0) {
        out.durationMonths = it.durationMonths
      }
      return out
    })
}

function mapEducation(items: JuiceboxEducation[] | null | undefined): NormalizedRecordDraft["education"] {
  if (!items || !Array.isArray(items)) return []
  return items
    .filter((it) => nonEmpty(it.school))
    .map((it) => {
      const out: NormalizedRecordDraft["education"][number] = {
        school: nonEmpty(it.school)!,
      }
      if (nonEmpty(it.degree)) out.degree = nonEmpty(it.degree)
      if (nonEmpty(it.field)) out.field = nonEmpty(it.field)
      if (typeof it.endYear === "number" && Number.isFinite(it.endYear)) {
        out.endYear = it.endYear
      }
      return out
    })
}

/**
 * Parse a Juicebox JSON array export into per-row drafts. Accepts either
 * a parsed array or a string of JSON. Throws on malformed JSON; returns
 * an empty array if `input` is an empty array.
 */
export function parseJuiceboxExport(input: unknown): NormalizedRecordDraft[] {
  const rows: JuiceboxRow[] = Array.isArray(input)
    ? (input as JuiceboxRow[])
    : (() => {
        if (typeof input === "string") {
          const parsed: unknown = JSON.parse(input)
          if (!Array.isArray(parsed)) {
            throw new Error("juicebox_input_not_array")
          }
          return parsed as JuiceboxRow[]
        }
        throw new Error("juicebox_input_not_array")
      })()

  return rows.map((row) => normalizeRow(row))
}

function normalizeRow(row: JuiceboxRow): NormalizedRecordDraft {
  const errors: string[] = []

  // LinkedIn.
  const linkedinRaw = nonEmpty(row.linkedin_url)
  const canonical = linkedinRaw ? canonicalizeLinkedInUrl(linkedinRaw) : null
  if (linkedinRaw && !canonical) errors.push("linkedin_url_invalid")

  // Email.
  const emailRaw = nonEmpty(row.email_primary)
  const normalizedEmail = emailRaw ? normalizeEmail(emailRaw) : null
  if (emailRaw && !normalizedEmail) errors.push("email_invalid")

  // Phone (optional on Juicebox).
  const phoneRaw = nonEmpty(row.phone)
  let phoneE164: string | null = null
  if (phoneRaw) {
    const phoneResult = normalizePhoneE164(phoneRaw)
    if (phoneResult.ok) {
      phoneE164 = phoneResult.value
    } else {
      errors.push("phone_not_e164")
    }
  }

  const hasIdentitySignal = Boolean(canonical) || Boolean(normalizedEmail)
  const status: NormalizedRecordDraft["normalizationStatus"] = hasIdentitySignal
    ? errors.length > 0
      ? "partial"
      : "ok"
    : "failed"

  const draft: NormalizedRecordDraft = {
    source: "juicebox",
    rawPayload: { ...row } as Record<string, unknown>,
    emails: normalizedEmail
      ? [{ value: normalizedEmail, hash: emailHash(normalizedEmail) }]
      : [],
    experience: mapExperience(row.experience_array),
    education: mapEducation(row.education_array),
    sourceTags: Array.isArray(row.skills) ? row.skills.filter(Boolean).map(String) : [],
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
  if (nonEmpty(row.full_name)) draft.name = nonEmpty(row.full_name)
  if (nonEmpty(row.current_position)) draft.currentTitle = nonEmpty(row.current_position)
  if (nonEmpty(row.current_company_name)) draft.currentCompany = nonEmpty(row.current_company_name)
  if (nonEmpty(row.location_string)) draft.location = nonEmpty(row.location_string)
  if (errors.length > 0) draft.normalizationErrors = errors
  if (row.enrichment && typeof row.enrichment === "object") {
    draft.enrichment = row.enrichment as Record<string, unknown>
  }

  return draft
}
