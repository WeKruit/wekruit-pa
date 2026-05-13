/**
 * Coresignal adapter — parses Coresignal's nested JSON export.
 *
 * Column mapping is fixed by Coresignal's export shape:
 *  - `profile.url` → canonicalLinkedInUrl
 *  - `profile.full_name` → name
 *  - `profile.headline` → currentTitle
 *  - `profile.location.name` → location
 *  - `contact.primary_email` → emails[0]
 *  - `contact.phone` → phoneHash
 *  - `experience[]` → experience
 *  - `education[]` → education
 *  - `skills[]` → sourceTags
 *
 * Adapter version: `coresignal-2026-05-A`.
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

export const CORESIGNAL_ADAPTER_VERSION = "coresignal-2026-05-A"

export type NormalizedRecordDraft = Omit<
  ExternalCandidateRecord,
  "recordId" | "batchId" | "createdAt"
>

interface CoresignalRow {
  profile?: {
    url?: string | null
    full_name?: string | null
    headline?: string | null
    location?: { name?: string | null } | null
  } | null
  contact?: {
    primary_email?: string | null
    phone?: string | null
  } | null
  experience?: Array<{
    company_name?: string | null
    title?: string | null
    date_from?: string | null
    date_to?: string | null
    duration_months?: number | null
  }> | null
  education?: Array<{
    school?: string | null
    degree?: string | null
    field_of_study?: string | null
    date_to?: string | null
  }> | null
  skills?: string[] | null
}

function nonEmpty(s: string | null | undefined): string | undefined {
  if (!s) return undefined
  const trimmed = String(s).trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function mapExperience(items: CoresignalRow["experience"]): NormalizedRecordDraft["experience"] {
  if (!items || !Array.isArray(items)) return []
  return items
    .filter((it) => nonEmpty(it.company_name) && nonEmpty(it.title))
    .map((it) => {
      const out: NormalizedRecordDraft["experience"][number] = {
        company: nonEmpty(it.company_name)!,
        title: nonEmpty(it.title)!,
      }
      if (nonEmpty(it.date_from)) out.startDate = nonEmpty(it.date_from)
      if (nonEmpty(it.date_to)) out.endDate = nonEmpty(it.date_to)
      if (typeof it.duration_months === "number" && it.duration_months >= 0) {
        out.durationMonths = it.duration_months
      }
      return out
    })
}

function mapEducation(items: CoresignalRow["education"]): NormalizedRecordDraft["education"] {
  if (!items || !Array.isArray(items)) return []
  return items
    .filter((it) => nonEmpty(it.school))
    .map((it) => {
      const out: NormalizedRecordDraft["education"][number] = {
        school: nonEmpty(it.school)!,
      }
      if (nonEmpty(it.degree)) out.degree = nonEmpty(it.degree)
      if (nonEmpty(it.field_of_study)) out.field = nonEmpty(it.field_of_study)
      if (nonEmpty(it.date_to)) {
        const year = parseInt(nonEmpty(it.date_to)!.slice(0, 4), 10)
        if (Number.isFinite(year)) out.endYear = year
      }
      return out
    })
}

/**
 * Parse a Coresignal JSON array export into per-row drafts.
 */
export function parseCoresignalExport(input: unknown): NormalizedRecordDraft[] {
  const rows: CoresignalRow[] = Array.isArray(input)
    ? (input as CoresignalRow[])
    : (() => {
        if (typeof input === "string") {
          const parsed: unknown = JSON.parse(input)
          if (!Array.isArray(parsed)) throw new Error("coresignal_input_not_array")
          return parsed as CoresignalRow[]
        }
        throw new Error("coresignal_input_not_array")
      })()

  return rows.map((row) => normalizeRow(row))
}

function normalizeRow(row: CoresignalRow): NormalizedRecordDraft {
  const errors: string[] = []
  const profile = row.profile ?? {}
  const contact = row.contact ?? {}

  const linkedinRaw = nonEmpty(profile.url)
  const canonical = linkedinRaw ? canonicalizeLinkedInUrl(linkedinRaw) : null
  if (linkedinRaw && !canonical) errors.push("linkedin_url_invalid")

  const emailRaw = nonEmpty(contact.primary_email)
  const normalizedEmail = emailRaw ? normalizeEmail(emailRaw) : null
  if (emailRaw && !normalizedEmail) errors.push("email_invalid")

  const phoneRaw = nonEmpty(contact.phone)
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
    source: "coresignal",
    rawPayload: { ...row } as Record<string, unknown>,
    emails: normalizedEmail
      ? [{ value: normalizedEmail, hash: emailHash(normalizedEmail) }]
      : [],
    experience: mapExperience(row.experience),
    education: mapEducation(row.education),
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
  if (nonEmpty(profile.full_name)) draft.name = nonEmpty(profile.full_name)
  if (nonEmpty(profile.headline)) draft.currentTitle = nonEmpty(profile.headline)
  if (nonEmpty(profile.location?.name)) draft.location = nonEmpty(profile.location?.name)
  if (errors.length > 0) draft.normalizationErrors = errors

  return draft
}
