/**
 * Phase 49 (v1.5 / Stream-H / D9) — pure helpers for MatchCandidates.tsx.
 *
 * Why split? The dashboard test scaffolding is node:test pure-logic only
 * (no JSDOM, no React Testing Library — see toolCallSummary.test.ts
 * precedent). All testable logic lives here so __tests__/MatchCandidates
 * .test.ts can exercise it without bringing in a browser env.
 *
 * Exports:
 *   - parseTagsInput : "react, python; ts" → ["react","python","ts"]
 *   - validateMatchForm : returns null on ok, error string otherwise
 *   - formatMatchScore : 0.4234 → "0.42"
 *   - filterOptedInOnly : drop rows where hasOptedIn !== true
 *   - INDUSTRY_OPTIONS : whitelist for the dropdown (matches CF whitelist)
 *
 * No React imports, no Firestore, no fetch — keeps the test file's
 * surface tiny and predictable.
 */

/** Mirror of the 6-enum industry whitelist on the CF side. Stays in lockstep. */
export const INDUSTRY_OPTIONS = [
  { value: "any", label: "Any" },
  { value: "tech", label: "Tech" },
  { value: "fintech", label: "Fintech" },
  { value: "healthtech", label: "Healthtech" },
  { value: "consumer", label: "Consumer" },
  { value: "b2b", label: "B2B" },
] as const

export type IndustryValue = (typeof INDUSTRY_OPTIONS)[number]["value"]

/** Per-row shape returned by paReverseMatch action="match". */
export type CandidateRow = {
  userId: string
  displayName: string
  matchScore: number
  topMatchedReasons: string[]
  hasOptedIn: boolean
  preferredLanguage: "zh" | "en"
}

/**
 * Split a free-text tag input into a deduplicated tag array.
 * Accepts comma, semicolon, or newline separators. Trims whitespace,
 * lower-cases, drops empties. Cap 20 tags to keep payload small.
 */
export function parseTagsInput(raw: string): string[] {
  if (typeof raw !== "string" || raw.length === 0) return []
  const parts = raw
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of parts) {
    const k = p.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(p)
    if (out.length >= 20) break
  }
  return out
}

/**
 * Validate the operator form before fetching. Returns null when ok,
 * otherwise a user-facing error string.
 *
 * Rules:
 *   - JD must be at least 30 chars (avoid empty/typo submissions)
 *   - industry must be one of INDUSTRY_OPTIONS
 *   - topK is optional; when present must be 1..1000
 */
export function validateMatchForm(input: {
  jobDescription: string
  industry: string
  topK?: number
}): string | null {
  const jd = (input.jobDescription ?? "").trim()
  if (jd.length < 30) {
    return "Job description too short — paste at least 30 chars."
  }
  if (!INDUSTRY_OPTIONS.some((o) => o.value === input.industry)) {
    return "Pick an industry from the dropdown."
  }
  if (typeof input.topK === "number") {
    if (!Number.isFinite(input.topK) || input.topK < 1 || input.topK > 1000) {
      return "topK must be between 1 and 1000."
    }
  }
  return null
}

/** Format a numeric match score for table display. */
export function formatMatchScore(score: number | null | undefined): string {
  if (typeof score !== "number" || !Number.isFinite(score)) return "—"
  return score.toFixed(2)
}

/**
 * Filter a candidate list down to opted-in users only. Used by the
 * "Notify Top 5" button per Adam directive ("gated: only sends to users
 * with hasOptedIn === true").
 */
export function filterOptedInOnly(rows: readonly CandidateRow[]): CandidateRow[] {
  return rows.filter((r) => r.hasOptedIn === true)
}
