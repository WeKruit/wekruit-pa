/**
 * P2.5b — Build CSV export of a batch's external candidate records, then
 * trigger client-side download. No server round-trip — operates on the
 * records already loaded by BatchDetail.
 *
 * Column set mirrors the recruiter-facing fields from
 * scripts/coresignal-employees-to-csv.mjs (proven shape from offline
 * exports), adapted to the ExternalCandidateRecord schema.
 */
import type { ExternalCandidateRecord } from "@pa/core-types"

export type ExternalCandidateRecordRowWithRaw = ExternalCandidateRecord & {
  // `rawPayload` is required on ExternalCandidateRecord, but client-side
  // we tolerate a deserialized shape where it may be missing or partial.
  rawPayload?: Record<string, unknown>
}

type Cell = string | number | boolean | null | undefined

function cleanCell(v: Cell): string {
  if (v === null || v === undefined) return ""
  return String(v)
    .replace(/\r\n|\r|\n|\t/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function csvEscape(v: Cell): string {
  const s = cleanCell(v)
  if (/[",]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

const COLUMNS: ReadonlyArray<readonly [string, (r: ExternalCandidateRecordRowWithRaw) => Cell]> = [
  ["record_id", (r) => r.recordId],
  ["coresignal_id", (r) => (r.rawPayload?.id as number | string | undefined) ?? null],
  ["source", (r) => r.source],
  ["resolved_user_id", (r) => r.resolvedUserId ?? null],
  ["identity_status", (r) => r.identityResolutionStatus],
  ["normalization_status", (r) => r.normalizationStatus],
  ["full_name", (r) => r.name ?? null],
  ["headline", (r) => (r.rawPayload?.headline as string | undefined) ?? null],
  ["current_title", (r) => r.currentTitle ?? null],
  ["current_company", (r) => r.currentCompany ?? null],
  ["location", (r) => r.location ?? null],
  ["linkedin_url", (r) => r.canonicalLinkedInUrl ?? null],
  ["github_url", (r) => (r.rawPayload?.github_url as string | undefined) ?? null],
  ["primary_email", (r) => r.emails?.[0]?.value ?? null],
  ["all_emails", (r) => (r.emails ?? []).map((e) => e.value).join("; ")],
  ["experience_count", (r) => (r.experience ?? []).length],
  ["education_count", (r) => (r.education ?? []).length],
  ["top_skills", (r) => (r.sourceTags ?? []).slice(0, 12).join("; ")],
  ["all_skills", (r) => (r.sourceTags ?? []).join("; ")],
  ["experience_summary", (r) =>
    (r.experience ?? [])
      .slice(0, 5)
      .map((e) => `${e.title} @ ${e.company}${e.durationMonths ? ` (${e.durationMonths}mo)` : ""}`)
      .join("; "),
  ],
  ["education_summary", (r) =>
    (r.education ?? [])
      .map((e) => `${e.degree ?? "—"} @ ${e.school}`)
      .join("; "),
  ],
  ["created_at", (r) => r.createdAt],
]

export function buildBatchCsv(records: ExternalCandidateRecordRowWithRaw[]): string {
  const rows: string[] = []
  rows.push(COLUMNS.map(([h]) => h).join(","))
  for (const r of records) {
    rows.push(COLUMNS.map(([, fn]) => csvEscape(fn(r))).join(","))
  }
  return rows.join("\n") + "\n"
}

export function downloadBatchCsv(
  records: ExternalCandidateRecordRowWithRaw[],
  filename: string,
): void {
  const csv = buildBatchCsv(records)
  // BOM so Excel recognizes UTF-8 correctly.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Release the object URL on next tick to let the download initiate.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
