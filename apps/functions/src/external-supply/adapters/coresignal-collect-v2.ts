/**
 * CoreSignal cdapi v2 `employee_multi_source/collect/{id}` adapter.
 *
 * Distinct from the V1 nested-shape `coresignal-2026-05-A` adapter
 * (`coresignal.ts`) — V1 parses the older CSV-style nested export
 * (`profile.url`, `contact.primary_email`, ...). V2 (this file) parses the
 * flat schema returned by the live cdapi v2 `collect/{id}` endpoints, which
 * is richer (per-experience company industry / size / HQ) and is what the
 * `paCoresignalFetchBatch` callable ingests.
 *
 * Adapter version: `coresignal-collect-2026-05-A`.
 *
 * Field map (per scripts/coresignal-employees-to-csv.mjs proven shape):
 *  - `linkedin_url`                       → canonicalLinkedInUrl
 *  - `primary_professional_email`         → emails[0]
 *  - `professional_emails_collection[].`  → emails[1..N]
 *  - `full_name`                          → name
 *  - `headline` or `active_experience_title` → currentTitle
 *  - `experience[0].company_name`         → currentCompany
 *  - `location_full` (fallback: country)  → location
 *  - `experience[]`                       → experience[]
 *  - `education[]`                        → education[]
 *  - `inferred_skills` + `historical_skills` (dedup) → sourceTags
 */
import type { ExternalCandidateRecord } from "@pa/core-types"
import {
  canonicalizeLinkedInUrl,
  type CoresignalEmployeeCollectV2,
  emailHash,
  linkedinHash,
  normalizeEmail,
  type AdapterSignature,
} from "@pa/external-supply"

export const CORESIGNAL_COLLECT_V2_ADAPTER_VERSION =
  "coresignal-collect-2026-05-A"

/**
 * Detection fingerprint for {@link detectAdapter}. JSON shape; required keys
 * are flat top-level fields.
 */
export const CORESIGNAL_COLLECT_V2_SIGNATURE: AdapterSignature = {
  source: "coresignal_collect_v2",
  requiredKeys: ["id", "linkedin_url", "full_name"],
  bonusKeys: [
    "primary_professional_email",
    "professional_emails_collection",
    "headline",
    "active_experience_title",
    "experience",
    "education",
    "inferred_skills",
    "historical_skills",
    "location_full",
  ],
  acceptedShapes: ["json"],
  adapterVersion: CORESIGNAL_COLLECT_V2_ADAPTER_VERSION,
}

export type NormalizedRecordDraft = Omit<
  ExternalCandidateRecord,
  "recordId" | "batchId" | "createdAt"
>

function nonEmpty(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

function mapExperience(
  items: CoresignalEmployeeCollectV2["experience"],
): NormalizedRecordDraft["experience"] {
  if (!items || !Array.isArray(items)) return []
  return items
    .filter(
      (it) =>
        nonEmpty(it.company_name) && nonEmpty(it.position_title),
    )
    .map((it) => {
      const out: NormalizedRecordDraft["experience"][number] = {
        company: nonEmpty(it.company_name)!,
        title: nonEmpty(it.position_title)!,
      }
      if (nonEmpty(it.date_from)) out.startDate = nonEmpty(it.date_from)!
      if (nonEmpty(it.date_to)) out.endDate = nonEmpty(it.date_to)!
      if (typeof it.duration_months === "number" && it.duration_months >= 0) {
        out.durationMonths = it.duration_months
      }
      return out
    })
}

function mapEducation(
  items: CoresignalEmployeeCollectV2["education"],
): NormalizedRecordDraft["education"] {
  if (!items || !Array.isArray(items)) return []
  return items
    .filter((it) => nonEmpty(it.institution_name))
    .map((it) => {
      const out: NormalizedRecordDraft["education"][number] = {
        school: nonEmpty(it.institution_name)!,
      }
      if (nonEmpty(it.degree)) out.degree = nonEmpty(it.degree)!
      if (typeof it.date_to_year === "number") {
        out.endYear = it.date_to_year
      }
      return out
    })
}

function dedupSkills(...lists: Array<string[] | null | undefined>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    if (!list || !Array.isArray(list)) continue
    for (const item of list) {
      const t = typeof item === "string" ? item.trim().toLowerCase() : ""
      if (!t || seen.has(t)) continue
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

function collectEmails(
  primary: string | null,
  collection: CoresignalEmployeeCollectV2["professional_emails_collection"],
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  if (primary) {
    const n = normalizeEmail(primary)
    if (n && !seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  if (collection && Array.isArray(collection)) {
    for (const item of collection) {
      const raw = nonEmpty(item.professional_email)
      if (!raw) continue
      const n = normalizeEmail(raw)
      if (n && !seen.has(n)) {
        seen.add(n)
        out.push(n)
      }
    }
  }
  return out
}

/**
 * Normalize a single `employee_multi_source/collect` v2 response into
 * `NormalizedRecordDraft` — the shape the existing identity-resolve worker
 * already consumes for `juicebox`, `lessie`, and V1 `coresignal`.
 */
export function normalizeCoresignalCollectV2(
  employee: CoresignalEmployeeCollectV2,
): NormalizedRecordDraft {
  const errors: string[] = []

  const linkedinRaw = nonEmpty(employee.linkedin_url)
  const canonical = linkedinRaw ? canonicalizeLinkedInUrl(linkedinRaw) : null
  if (linkedinRaw && !canonical) errors.push("linkedin_url_invalid")

  const emails = collectEmails(
    nonEmpty(employee.primary_professional_email),
    employee.professional_emails_collection ?? null,
  )

  const hasIdentitySignal = Boolean(canonical) || emails.length > 0
  const status: NormalizedRecordDraft["normalizationStatus"] = hasIdentitySignal
    ? errors.length > 0
      ? "partial"
      : "ok"
    : "failed"

  const sourceTags = dedupSkills(
    employee.inferred_skills ?? null,
    employee.historical_skills ?? null,
  )

  const draft: NormalizedRecordDraft = {
    source: "coresignal_collect_v2",
    rawPayload: { ...employee } as Record<string, unknown>,
    emails: emails.map((value) => ({ value, hash: emailHash(value) })),
    experience: mapExperience(employee.experience),
    education: mapEducation(employee.education),
    sourceTags,
    normalizationStatus: status,
    identityResolutionStatus: "pending",
    evidence: [],
  }

  if (canonical) {
    draft.canonicalLinkedInUrl = canonical
    draft.linkedinProfileHash = linkedinHash(canonical)
  }

  const fullName = nonEmpty(employee.full_name)
  if (fullName) draft.name = fullName

  const currentTitle =
    nonEmpty(employee.active_experience_title) ?? nonEmpty(employee.headline)
  if (currentTitle) draft.currentTitle = currentTitle

  const currentCompany = nonEmpty(employee.experience?.[0]?.company_name)
  if (currentCompany) draft.currentCompany = currentCompany

  const loc =
    nonEmpty(employee.location_full) ??
    [
      nonEmpty(employee.location_city),
      nonEmpty(employee.location_state),
      nonEmpty(employee.location_country),
    ]
      .filter(Boolean)
      .join(", ")
  if (loc) draft.location = loc

  if (errors.length > 0) draft.normalizationErrors = errors

  return draft
}

/**
 * Parse a CoreSignal collect-v2 JSON array (multiple employees) into drafts.
 * Used when batch import is given a JSON file of pre-fetched payloads.
 */
export function parseCoresignalCollectV2Export(
  input: unknown,
): NormalizedRecordDraft[] {
  const rows: CoresignalEmployeeCollectV2[] = Array.isArray(input)
    ? (input as CoresignalEmployeeCollectV2[])
    : typeof input === "string"
      ? (() => {
          const parsed: unknown = JSON.parse(input)
          if (!Array.isArray(parsed)) {
            throw new Error("coresignal_collect_v2_input_not_array")
          }
          return parsed as CoresignalEmployeeCollectV2[]
        })()
      : (() => {
          throw new Error("coresignal_collect_v2_input_not_array")
        })()

  return rows.map((row) => normalizeCoresignalCollectV2(row))
}
