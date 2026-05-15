/**
 * Phase A3 (post-v1.7) — `pa-companies/{id}` document schema.
 *
 * Centralized company directory. Two writer paths:
 *  1. Phase A5 `paEnrichCompaniesNightly` CF — cascade YC → Wikidata →
 *     Clearbit → LLM. Writes stage/tags/funding/logo/etc.
 *  2. v2.0 external-supply `loadCompanyContext` — employer-owned fields
 *     (competitorCompanies, schoolPreferences, size, industrySector).
 *
 * Coexists by additive field set. Phase A5 NEVER overwrites docs where
 * `lastReviewedBy != null` (Adam manual takes precedence).
 *
 * Doc ID = normalized company name (lowercased, punctuation stripped).
 */

import type {
  CompanyStage,
  CompanyTag,
} from "@wekruit/shared-tags"

/** Source the enrichment cascade attributes the final stage/tags to. */
export type CompanyEnrichmentSource =
  | "yc"
  | "wikidata"
  | "clearbit"
  | "llm"
  | "manual"

export interface CompanyFundingRound {
  /** e.g. "seed", "series_a", "series_b". Free-form for now. */
  round: string
  /** USD millions. `null` if not disclosed. */
  amount: number | null
  /** ISO date. */
  date: string
  /** Lowercased investor names. */
  investors: string[]
}

/**
 * `pa-companies/{id}` doc. Field set is intentionally a superset of the
 * v2.0 external-supply employer-pref shape (`coerceCompanyContext` reads
 * `name, industrySector, size, competitorCompanies, schoolPreferences`)
 * — those fields remain untouched by Phase A5 enrichment.
 */
export interface PaCompany {
  /** Normalized lowercase no-punct name; doubles as document ID. */
  id: string
  /** Canonical capitalized display name, e.g. "Anthropic". */
  displayName: string
  /** Mirrors `id`. Stored explicitly so queries can compare without ID parse. */
  normalizedName: string
  domain: string | null
  /** Clearbit logo URL (e.g. `https://logo.clearbit.com/anthropic.com`). */
  logoUrl: string | null
  hqLocation: string | null
  /** Free-form employee range string (e.g. `"501-1000"`). */
  employeeRange: string | null
  /** Free-form industry label (separate from canonical `industrySector` array). */
  industry: string | null
  /** Phase A2 canonical enum; `unknown` for un-enriched docs. */
  companyStage: CompanyStage
  /** Phase A2 open-vocab seed list + admin-promoted overlay tokens. */
  companyTags: CompanyTag[]
  enrichmentSource: CompanyEnrichmentSource
  /** ISO timestamp of last successful enrichment write. */
  enrichedAt: string
  /** Adam manual override sentinel. Phase A5 NEVER overwrites when set. */
  lastReviewedBy: string | null
  fundingRounds?: CompanyFundingRound[]
  createdAt: string
  updatedAt: string
}

/**
 * Convenience normalizer used by both writers + score-time reader.
 *
 * Cap input length BEFORE regex passes to bound worst-case work (CodeQL
 * js/polynomial-redos: `^-+|-+$` on attacker-controlled input could be
 * slow on pathological repetitions; 100-char cap removes the unbounded
 * dimension).
 */
export function normalizeCompanyName(raw: string): string {
  if (typeof raw !== "string") return ""
  const bounded = raw.slice(0, 200).toLowerCase()
  const collapsed = bounded.replace(/[^a-z0-9]+/g, "-")
  // Manual trim of leading/trailing dashes to avoid backtracking regex.
  let start = 0
  let end = collapsed.length
  while (start < end && collapsed.charCodeAt(start) === 45) start++
  while (end > start && collapsed.charCodeAt(end - 1) === 45) end--
  return collapsed.slice(start, end).slice(0, 100)
}
