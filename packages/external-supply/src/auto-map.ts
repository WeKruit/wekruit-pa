/**
 * Header → canonical-field auto-detection for the manual_csv adapter.
 *
 * Real-world Lessie / Juicebox-style exports share six stable columns
 * (`Name`, `Link`, `Email`, `Match`, `Company`, `Headline`) plus one title
 * alias (`Title` | `Job Title`) and one location field
 * (`Country/Region` | split `Country` / `State` / `City`). The remaining
 * columns are per-rubric criterion labels that vary per job. We infer the
 * six known mappings and treat every unknown header as a `rubric` column —
 * the loose adapter then preserves their values verbatim.
 *
 * Pure: no I/O, no async. Deterministic for the same header set.
 */

import type { ManualCsvColumnMappingShape } from "./types.js"

/** Canonical field names the loose adapter understands. */
export type AutoMapField =
  | "linkedinUrl"
  | "email"
  | "phone"
  | "name"
  | "currentTitle"
  | "currentCompany"
  | "location"
  | "skills"
  | "matchScore"

export interface InferColumnMappingResult {
  mapping: ManualCsvColumnMappingShape
  /** Source-order list of headers we did NOT map to a known field. */
  rubricColumns: string[]
  /** Headers that matched > 1 canonical field — caller may want to ask. */
  ambiguous: { field: AutoMapField; candidates: string[] }[]
  /** Optional score column (e.g. Lessie's "Match"). Surfaced for UI only. */
  matchScoreColumn?: string
  /** Split-location helper: column names of country / state / city when present. */
  locationParts?: { country?: string; state?: string; city?: string }
}

// Patterns are evaluated case-insensitively on the trimmed header. Earlier
// entries win when a header matches multiple patterns for different fields.
const FIELD_PATTERNS: { field: AutoMapField; tests: RegExp[] }[] = [
  {
    field: "linkedinUrl",
    tests: [
      /^link$/i,
      /^linkedin$/i,
      /^linkedin[\s_-]*url$/i,
      /^linkedin[\s_-]*profile$/i,
      /^profile[\s_-]*url$/i,
      /^profile$/i,
      /^url$/i,
    ],
  },
  {
    field: "email",
    tests: [/^email$/i, /^e-?mail$/i, /^email[\s_-]*address$/i, /^primary[\s_-]*email$/i],
  },
  {
    field: "phone",
    tests: [/^phone$/i, /^mobile$/i, /^phone[\s_-]*number$/i, /^cell$/i, /^tel$/i],
  },
  {
    field: "name",
    tests: [/^name$/i, /^full[\s_-]*name$/i, /^candidate[\s_-]*name?$/i, /^candidate$/i],
  },
  {
    field: "currentTitle",
    tests: [
      /^title$/i,
      /^job[\s_-]*title$/i,
      /^current[\s_-]*title$/i,
      /^current[\s_-]*role$/i,
      /^role$/i,
      /^position$/i,
    ],
  },
  {
    field: "currentCompany",
    tests: [
      /^company$/i,
      /^current[\s_-]*company$/i,
      /^employer$/i,
      /^organization$/i,
      /^current[\s_-]*employer$/i,
    ],
  },
  {
    field: "location",
    tests: [
      /^location$/i,
      /^country[\s/_-]*region$/i,
      /^region$/i,
      /^geo$/i,
      /^based[\s_-]*in$/i,
    ],
  },
  {
    field: "skills",
    tests: [/^skills$/i, /^tech[\s_-]*stack$/i, /^technologies$/i, /^stack$/i],
  },
  {
    field: "matchScore",
    tests: [/^match$/i, /^match[\s_-]*score$/i, /^score$/i, /^fit$/i, /^fit[\s_-]*score$/i],
  },
]

const SPLIT_LOCATION_HEADERS = [/^country$/i, /^state$/i, /^city$/i, /^province$/i]

function classifyHeader(header: string): AutoMapField | "split-location" | null {
  for (const { field, tests } of FIELD_PATTERNS) {
    if (tests.some((re) => re.test(header))) return field
  }
  if (SPLIT_LOCATION_HEADERS.some((re) => re.test(header))) return "split-location"
  return null
}

/**
 * Infer the column mapping from a list of header strings.
 *
 * Rules:
 *   - First match wins per field (deterministic, source-order).
 *   - `Country` / `State` / `City` siblings collapse into a single
 *     `location` mapping using the first present (caller can post-process).
 *   - Headers that don't match any canonical pattern → `rubricColumns`.
 *   - `Match` / `Score` is captured separately as `matchScoreColumn` and
 *     is NOT placed in `mapping` (the adapter doesn't have a canonical
 *     match-score field — preserved only as `rawPayload`).
 */
export function inferColumnMapping(headers: readonly string[]): InferColumnMappingResult {
  const mapping: ManualCsvColumnMappingShape = {}
  const taken = new Set<AutoMapField>()
  const rubricColumns: string[] = []
  const candidatesPerField: Record<AutoMapField, string[]> = {
    linkedinUrl: [],
    email: [],
    phone: [],
    name: [],
    currentTitle: [],
    currentCompany: [],
    location: [],
    skills: [],
    matchScore: [],
  }
  const locationParts: { country?: string; state?: string; city?: string } = {}
  let matchScoreColumn: string | undefined

  for (const rawHeader of headers) {
    const header = (rawHeader ?? "").trim()
    if (header.length === 0) continue
    const klass = classifyHeader(header)
    if (klass === null) {
      rubricColumns.push(header)
      continue
    }
    if (klass === "split-location") {
      if (/^country$/i.test(header) && !locationParts.country) locationParts.country = header
      else if (/^state$/i.test(header) && !locationParts.state) locationParts.state = header
      else if (/^city$/i.test(header) && !locationParts.city) locationParts.city = header
      else if (/^province$/i.test(header) && !locationParts.state) locationParts.state = header
      continue
    }
    candidatesPerField[klass].push(header)
    if (klass === "matchScore") {
      if (!matchScoreColumn) matchScoreColumn = header
      continue
    }
    if (!taken.has(klass)) {
      mapping[klass] = header
      taken.add(klass)
    }
  }

  // If we found split-location headers but no explicit `location` mapping,
  // synthesize a virtual location field. The adapter uses
  // `__locationParts__` as a sentinel so it knows to concat at row read.
  if (!mapping.location) {
    const parts = [locationParts.city, locationParts.state, locationParts.country].filter(
      Boolean,
    )
    if (parts.length > 0) {
      mapping.location = "__locationParts__"
    }
  }

  const ambiguous: { field: AutoMapField; candidates: string[] }[] = []
  for (const field of Object.keys(candidatesPerField) as AutoMapField[]) {
    if (candidatesPerField[field].length > 1 && field !== "matchScore") {
      ambiguous.push({ field, candidates: candidatesPerField[field] })
    }
  }

  const result: InferColumnMappingResult = {
    mapping,
    rubricColumns,
    ambiguous,
  }
  if (matchScoreColumn) result.matchScoreColumn = matchScoreColumn
  if (locationParts.country || locationParts.state || locationParts.city) {
    result.locationParts = locationParts
  }
  return result
}

/**
 * Recognized social/portfolio link kinds. Order matters — `classifyLink`
 * matches in this order, so list more specific hostnames first.
 */
export type LinkKind =
  | "linkedin"
  | "github"
  | "twitter"
  | "facebook"
  | "instagram"
  | "medium"
  | "youtube"
  | "tiktok"
  | "dribbble"
  | "behance"
  | "stackoverflow"
  | "personal"
  | "other"

export interface ClassifiedLink {
  url: string
  kind: LinkKind
  /** Hostname for grouping/display (e.g. "linkedin.com", "github.com"). */
  hostname: string
}

const LINK_HOST_PATTERNS: Array<{ kind: LinkKind; re: RegExp }> = [
  { kind: "linkedin", re: /^(www\.|m\.)?linkedin\.com$/i },
  { kind: "github", re: /^(www\.)?github\.com$/i },
  { kind: "twitter", re: /^(www\.)?(twitter|x)\.com$/i },
  { kind: "facebook", re: /^(www\.|m\.)?(facebook|fb)\.com$/i },
  { kind: "instagram", re: /^(www\.)?instagram\.com$/i },
  { kind: "medium", re: /^(www\.)?medium\.com$/i },
  { kind: "youtube", re: /^(www\.|m\.)?youtube\.com$/i },
  { kind: "tiktok", re: /^(www\.)?tiktok\.com$/i },
  { kind: "dribbble", re: /^(www\.)?dribbble\.com$/i },
  { kind: "behance", re: /^(www\.)?behance\.net$/i },
  { kind: "stackoverflow", re: /^(www\.)?stackoverflow\.com$/i },
]

/**
 * Classify a single URL into a LinkKind by hostname. Returns `other` /
 * `personal` when no social host matches; "personal" reserved for short
 * vanity domains (e.g. `alice.dev`), "other" for everything else.
 */
export function classifyLink(rawUrl: string): ClassifiedLink | null {
  const trimmed = (rawUrl ?? "").trim()
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed.match(/^https?:\/\//i) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  for (const { kind, re } of LINK_HOST_PATTERNS) {
    if (re.test(host)) {
      return { url: url.toString(), kind, hostname: host }
    }
  }
  // Heuristic — short vanity hosts (<= 30 chars, single dot) look like
  // personal portfolios. Anything else gets bucketed as "other".
  const isVanity = host.split(".").length <= 2 && host.length <= 30
  return { url: url.toString(), kind: isVanity ? "personal" : "other", hostname: host }
}

/**
 * Split a Lessie-style Link cell (which often packs multiple URLs separated
 * by newlines) into a deduped array of classified links. Order preserved:
 * the first link is the primary identity signal.
 */
export function parseLinkCell(rawCell: string | undefined | null): ClassifiedLink[] {
  if (!rawCell) return []
  const candidates = String(rawCell)
    .split(/[\r\n]+|\s{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /https?:\/\//i.test(s.length < 200 ? s : ""))
  const out: ClassifiedLink[] = []
  const seen = new Set<string>()
  for (const c of candidates) {
    const cls = classifyLink(c)
    if (!cls) continue
    if (seen.has(cls.url)) continue
    seen.add(cls.url)
    out.push(cls)
  }
  return out
}

/**
 * Classify a rubric cell as `passed=true/false/null`. PASS markers include
 * ✅ / ✓ / "pass" / "yes" / "true" / "✔"; FAIL markers ❌ / ✗ / "fail" / "no"
 * / "false". Anything else (e.g. reasoning prose) → `null`.
 *
 * Cell value is preserved verbatim regardless — `passed` is purely a hint
 * for UI tinting + weak-tag merge filtering.
 */
export function classifyRubricCell(value: string | undefined | null): {
  value: string
  passed: boolean | null
} {
  const v = (value ?? "").toString()
  const trimmed = v.trim()
  if (trimmed.length === 0) return { value: "", passed: null }
  const lower = trimmed.toLowerCase()
  const PASS = [
    /^✅/,
    /^✔/,
    /^✓/,
    /^pass\b/i,
    /^yes\b/i,
    /^true\b/i,
    /^strong\b/i,
    /^match\b/i,
  ]
  const FAIL = [/^❌/, /^✗/, /^✘/, /^fail\b/i, /^no\b/i, /^false\b/i, /^weak\b/i, /^missing\b/i]
  if (PASS.some((re) => re.test(trimmed))) return { value: v, passed: true }
  if (FAIL.some((re) => re.test(trimmed))) return { value: v, passed: false }
  // Some Lessie cells start with the criterion verdict followed by reasoning,
  // e.g. "Pass — 4+ yrs Solana ...". The /^pass\b/i regex above catches that.
  // Numeric score-like cells (e.g. "0.82") → null (preserved verbatim).
  if (/^-?\d+(\.\d+)?$/.test(lower)) return { value: v, passed: null }
  return { value: v, passed: null }
}
