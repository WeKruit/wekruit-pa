/**
 * v1.6 Phase 55 (MATCH-02) — matching-jobs schema migration mappers.
 *
 * Deterministic mappers from legacy fields stored on `matching-jobs` to
 * Phase 52 canonical vocabs (`roleFunction`, `industrySector`).
 *
 * Sources (frozen at Phase 55 start, verbatim from CLAUDE.md design lock):
 *  - `JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION` — 19→17 mapping derived from
 *    `wekruit-matching/src/wekruit_matching/scraper/jobright_github.py:75`
 *    `REPO_TO_CATEGORY`. Output of jobright scraping is one of these
 *    keys, stored in `matching-jobs.category`.
 *  - `LEGACY_INDUSTRY_TO_CANONICAL` — 38+ key mapping from
 *    `wekruit-matching/src/wekruit_matching/enrichment/classifier.py:31`
 *    `INDUSTRY_VOCAB`, stored in `matching-jobs.industryKey` /
 *    `industryEnum`.
 *  - `TITLE_KEYWORD_TO_ROLE` — secondary regex pass for the `general`
 *    catch-all category and for jobs missing a category. Conservative:
 *    matches well-known role titles; never substitutes for an explicit
 *    category mapping.
 *
 * Adam-locked (D1, D2, D5, D9): mappers are deterministic. Same input
 * always produces same output. NO LLM call. NO regex fallback for
 * industry — if legacy key isn't in the table, output `[]` (preserves
 * idempotency; future enrichment can fill via LLM separately).
 */

import { type RoleFunction } from "@wekruit/shared-tags"
import { type IndustrySector } from "@wekruit/shared-tags"

/**
 * Source: wekruit-matching/scraper/jobright_github.py:75 REPO_TO_CATEGORY
 *
 * Maps the legacy `category` field stored on matching-jobs to canonical
 * Phase 52 `roleFunction[]`. Multi-value because some categories
 * (e.g., engineering) span multiple Phase 52 functions.
 *
 * `general` deliberately maps to `[]` — it's the jobright internship
 * catch-all and we defer to title-regex secondary pass.
 */
export const JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION: Record<string, RoleFunction[]> = {
  tech: ["software_engineering"],
  data_analytics: ["data_analysis"],
  engineering: ["engineering_and_development"],
  product: ["product_management"],
  business: ["business_analyst"],
  design: ["creatives_and_design"],
  consulting: ["consultant"],
  accounting_finance: ["accounting_and_finance"],
  marketing: ["marketing"],
  management: ["management_and_executive"],
  sales: ["sales"],
  human_resources: ["human_resources"],
  legal: ["legal_and_compliance"],
  arts_entertainment: ["arts_and_entertainment"],
  education: ["education_and_training"],
  government: ["public_sector_and_government"],
  customer_service: ["customer_service_and_support"],
  general: [],
}

/**
 * Source: wekruit-matching/enrichment/classifier.py:31 INDUSTRY_VOCAB (38)
 * extended in Phase 55 with: banking, finance, insurance (→ financial_technology
 * collapse — D2 lossy OK for now), defense, security, manufacturing, retail,
 * media, education, government, energy, transportation, hospitality, real_estate,
 * nonprofit, legal, pharma, logistics, food_service, agriculture, mining,
 * utilities.
 *
 * Maps the legacy `industryKey` / `industryEnum` to Phase 52
 * `industrySector[]`. Multi-value because some legacy keys could expand
 * to multiple canonical sectors (currently all 1:1, future-proof shape).
 *
 * `other` and `unknown` deliberately map to `[]` — preserves the "no
 * signal" semantic. Phase 56 query path treats empty `industrySector[]`
 * as "skip soft score" rather than misclassify.
 */
export const LEGACY_INDUSTRY_TO_CANONICAL: Record<string, IndustrySector[]> = {
  tech: ["technology_general"],
  technology: ["technology_general"],
  fintech: ["financial_technology"],
  financial_services: ["financial_technology"],
  healthtech: ["healthcare_and_life_sciences"],
  healthcare: ["healthcare_and_life_sciences"],
  life_sciences: ["healthcare_and_life_sciences"],
  medical_diagnostics: ["healthcare_and_life_sciences"],
  ecommerce: ["e_commerce_and_retail"],
  enterprise_saas: ["software_and_saas"],
  ai_ml: ["artificial_intelligence_and_machine_learning"],
  ai: ["artificial_intelligence_and_machine_learning"],
  hr_analytics: ["artificial_intelligence_and_machine_learning"],
  cybersecurity: ["cybersecurity"],
  gaming: ["gaming_and_esports"],
  social_media: ["media_and_entertainment"],
  hardware: ["hardware_and_semiconductors"],
  consulting: ["management_consulting"],
  telecom: ["telecommunications"],
  automotive: ["automotive_and_mobility"],
  aerospace_defense: ["aerospace_and_defense"],
  construction: ["construction_and_built_environment"],
  defense: ["aerospace_and_defense"],
  security: ["cybersecurity"],
  manufacturing: ["manufacturing_and_industrial"],
  industrial_automation: ["manufacturing_and_industrial"],
  retail: ["e_commerce_and_retail"],
  media: ["media_and_entertainment"],
  education: ["education_technology"],
  government: ["public_sector_and_government"],
  energy: ["energy_and_utilities"],
  transportation: ["transportation_and_logistics"],
  hospitality: ["hospitality_and_travel"],
  real_estate: ["real_estate_and_proptech"],
  nonprofit: ["non_profit_and_social_impact"],
  legal: ["legal_services"],
  pharma: ["biotechnology_and_pharmaceuticals"],
  pharmaceutical: ["biotechnology_and_pharmaceuticals"],
  banking: ["financial_technology"],
  finance: ["financial_technology"],
  insurance: ["financial_technology"],
  logistics: ["transportation_and_logistics"],
  food_service: ["hospitality_and_travel"],
  agriculture: ["agriculture_and_foodtech"],
  mining: ["manufacturing_and_industrial"],
  utilities: ["energy_and_utilities"],
  blockchain: ["crypto_web3_blockchain"],
  data_technology: ["software_and_saas"],
  // 10-bucket legacy `industryEnum` tokens (from cv-ingest/industry-tags.ts).
  // Stored on jobs alongside / instead of the snake_case industryKey above.
  tech_software: ["software_and_saas"],
  tech_hardware: ["hardware_and_semiconductors"],
  fintech_finance: ["financial_technology"],
  healthcare_biotech: ["healthcare_and_life_sciences"],
  consumer_retail: ["e_commerce_and_retail"],
  media_entertainment: ["media_and_entertainment"],
  manufacturing_industrial: ["manufacturing_and_industrial"],
  other: [],
  unknown: [],
}

/**
 * Title-regex secondary pass for `general` / unknown categories.
 *
 * Order matters: more-specific patterns first so a "Senior Software
 * Engineer / Tech Lead" picks BOTH software_engineering AND
 * management_and_executive. We collect all matches and dedupe.
 *
 * Conservative: only matches common, unambiguous tokens. False positives
 * are worse than false negatives here (downstream Phase 56 hard-filters
 * on roleFunction; misclass means user sees a non-relevant job).
 */
const TITLE_KEYWORD_TO_ROLE: Array<[RegExp, RoleFunction[]]> = [
  [
    /\b(software\s+engineer(ing)?|swe|developer|programmer|coder|backend|frontend|fullstack|full\s*stack|web\s+developer|mobile\s+developer|ios\s+developer|android\s+developer)\b/i,
    ["software_engineering"],
  ],
  [
    /\b(data\s+(scientist|analyst|engineer)|analytics|business\s+intelligence|\bbi\b)\b/i,
    ["data_analysis"],
  ],
  [
    /\b(machine\s+learning|ml\s+engineer|ai\s+engineer|deep\s+learning|nlp)\b/i,
    ["software_engineering", "data_analysis"],
  ],
  [/\b(product\s+(manager|owner|lead)|\bpm\b)\b/i, ["product_management"]],
  [/\b(business\s+analyst|\bba\b|requirements)\b/i, ["business_analyst"]],
  [
    /\b(designer|ui\s+designer|ux\s+designer|graphic|creative)\b/i,
    ["creatives_and_design"],
  ],
  [/\b(consultant|consulting|advisor)\b/i, ["consultant"]],
  [
    /\b(accountant|accounting|finance|cfo|controller|treasurer|fp&a)\b/i,
    ["accounting_and_finance"],
  ],
  [/\b(marketing|growth|brand|content\s+marketing)\b/i, ["marketing"]],
  [
    /\b(manager|director|\bvp\b|head\s+of|lead|principal|chief)\b/i,
    ["management_and_executive"],
  ],
  [
    /\b(sales|account\s+executive|\bae\b|\bbdr\b|\bsdr\b|business\s+development)\b/i,
    ["sales"],
  ],
  [/\b(\bhr\b|human\s+resources|recruiter|talent|people\s+ops)\b/i, ["human_resources"]],
  [
    /\b(legal|attorney|lawyer|paralegal|compliance|counsel)\b/i,
    ["legal_and_compliance"],
  ],
  [
    /\b(artist|musician|actor|performer|writer|editor)\b/i,
    ["arts_and_entertainment"],
  ],
  [
    /\b(teacher|professor|tutor|instructor|trainer)\b/i,
    ["education_and_training"],
  ],
  [
    /\b(government|public\s+sector|policy|federal|state)\b/i,
    ["public_sector_and_government"],
  ],
  [
    /\b(customer\s+(service|support|success)|cs\s+rep|help\s+desk)\b/i,
    ["customer_service_and_support"],
  ],
]

function dedupeRoles(roles: RoleFunction[]): RoleFunction[] {
  const seen = new Set<RoleFunction>()
  const out: RoleFunction[] = []
  for (const r of roles) {
    if (!seen.has(r)) {
      seen.add(r)
      out.push(r)
    }
  }
  return out
}

/**
 * Run all title regexes and union their matches. Used both as the
 * fallback for `general`/unknown categories and as the secondary
 * standalone path when category is missing.
 */
export function inferRoleFromTitle(title: string | undefined | null): RoleFunction[] {
  if (!title || typeof title !== "string") return []
  const collected: RoleFunction[] = []
  for (const [re, roles] of TITLE_KEYWORD_TO_ROLE) {
    if (re.test(title)) {
      for (const r of roles) collected.push(r)
    }
  }
  return dedupeRoles(collected)
}

/**
 * Map the legacy `category` field (and optionally use `title` as
 * fallback). Returns multi-value RoleFunction[].
 *
 * Behavior:
 *  - Direct hit in JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION → return mapped array
 *  - Empty mapping (e.g. `general`) OR unknown category → fall through to
 *    title regex (`inferRoleFromTitle`)
 *  - Both miss → return `[]`
 */
export function mapJobrightCategoryToRoleFunction(
  category: string | undefined | null,
  title?: string | null
): RoleFunction[] {
  const cat = typeof category === "string" ? category.toLowerCase().trim() : ""
  if (cat) {
    const direct = JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION[cat]
    if (direct && direct.length > 0) return direct
  }
  // category missing OR maps to [] → secondary title-regex pass
  return inferRoleFromTitle(title ?? undefined)
}

/**
 * Map the legacy `industryKey` / `industryEnum` field to canonical
 * Phase 52 `industrySector[]`.
 *
 * Behavior:
 *  - Direct hit in LEGACY_INDUSTRY_TO_CANONICAL → return mapped array
 *  - Unknown / `other` / `unknown` → return `[]`
 *
 * No regex fallback — keep deterministic + idempotent. Future enrichment
 * (LLM industry classifier) can fill from JD text separately.
 */
export function mapLegacyIndustryToCanonical(
  legacyKey: string | undefined | null
): IndustrySector[] {
  if (!legacyKey || typeof legacyKey !== "string") return []
  const key = legacyKey.toLowerCase().trim()
  if (!key) return []
  return LEGACY_INDUSTRY_TO_CANONICAL[key] ?? []
}

/**
 * Live-data-aware compose: derive the v1.6 `roleFunction[]` and
 * `industrySector[]` for a matching-jobs doc from its actual stored
 * fields (production verified 2026-05-06).
 *
 * Production matching-jobs docs do NOT carry a `category` field, and
 * the `industryKey` / `industry` fields hold a MIX of category-style
 * values (engineering, human_resources, customer_service, ...) and
 * industry-style values (fintech, healthtech, enterprise_saas, ...).
 * `industryEnum` (when present) is the legacy 10-bucket; `roleTitle`
 * holds the title.
 *
 * Resolution order (mirrored in migrate-matching-jobs-schema.mjs):
 *
 *  roleFunction:
 *  1. explicit `category` field present + maps → use direct
 *  2. else `industryKey` matches a CATEGORY token → use that category
 *  3. else fall back to roleTitle / title / jobTitle regex
 *
 *  industrySector:
 *  1. `industryEnum` array → map each + dedupe
 *  2. else `industryEnum` scalar → map
 *  3. else `industryKey` matches an INDUSTRY token → use that industry
 *  4. else free-text `industry` → map
 *
 * The same callable from the migration script's inlined ESM copy MUST
 * stay in sync — tests assert convergence on canonical fixtures.
 */
export interface MatchingJobLikeForMapping {
  category?: string | null
  industry?: string | null
  industryKey?: string | null
  industryEnum?: string | string[] | null
  roleTitle?: string | null
  title?: string | null
  jobTitle?: string | null
}

export interface MatchingJobV16Computed {
  newRoleFunction: RoleFunction[]
  newIndustrySector: IndustrySector[]
  mapperUsed: {
    role:
      | "category_direct"
      | "industryKey_as_category"
      | "title_regex_fallback"
      | "no_mapping"
    industry:
      | "industryEnum_array"
      | "industryEnum_scalar"
      | "industryKey"
      | "industry"
      | "no_mapping"
  }
}

export function computeMatchingJobV16Fields(
  job: MatchingJobLikeForMapping
): MatchingJobV16Computed {
  const category = job.category
  const title = job.roleTitle ?? job.title ?? job.jobTitle
  const industryEnum = job.industryEnum
  const industryKey = job.industryKey
  const industry = job.industry

  // ─── roleFunction ────────────────────────────────────────────────────
  let newRoleFunction: RoleFunction[] = []
  let roleSource: MatchingJobV16Computed["mapperUsed"]["role"] = "no_mapping"

  if (category) {
    const cat = category.toLowerCase().trim()
    const direct = JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION[cat]
    if (direct && direct.length > 0) {
      newRoleFunction = direct
      roleSource = "category_direct"
    }
  }
  if (newRoleFunction.length === 0 && industryKey) {
    const k = industryKey.toLowerCase().trim()
    const direct = JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION[k]
    if (direct && direct.length > 0) {
      newRoleFunction = direct
      roleSource = "industryKey_as_category"
    }
  }
  if (newRoleFunction.length === 0 && title) {
    const fromTitle = inferRoleFromTitle(title)
    if (fromTitle.length > 0) {
      newRoleFunction = fromTitle
      roleSource = "title_regex_fallback"
    }
  }

  // ─── industrySector ──────────────────────────────────────────────────
  let newIndustrySector: IndustrySector[] = []
  let industrySource: MatchingJobV16Computed["mapperUsed"]["industry"] = "no_mapping"

  if (Array.isArray(industryEnum) && industryEnum.length > 0) {
    const collected: IndustrySector[] = []
    for (const k of industryEnum) {
      for (const m of mapLegacyIndustryToCanonical(k)) collected.push(m)
    }
    if (collected.length > 0) {
      newIndustrySector = dedupeSectors(collected)
      industrySource = "industryEnum_array"
    }
  }
  if (newIndustrySector.length === 0 && industryEnum && !Array.isArray(industryEnum)) {
    const mapped = mapLegacyIndustryToCanonical(industryEnum)
    if (mapped.length > 0) {
      newIndustrySector = mapped
      industrySource = "industryEnum_scalar"
    }
  }
  if (newIndustrySector.length === 0 && industryKey) {
    const mapped = mapLegacyIndustryToCanonical(industryKey)
    if (mapped.length > 0) {
      newIndustrySector = mapped
      industrySource = "industryKey"
    }
  }
  if (newIndustrySector.length === 0 && industry) {
    const mapped = mapLegacyIndustryToCanonical(industry)
    if (mapped.length > 0) {
      newIndustrySector = mapped
      industrySource = "industry"
    }
  }

  return {
    newRoleFunction,
    newIndustrySector,
    mapperUsed: { role: roleSource, industry: industrySource },
  }
}

function dedupeSectors(sectors: IndustrySector[]): IndustrySector[] {
  const seen = new Set<IndustrySector>()
  const out: IndustrySector[] = []
  for (const s of sectors) {
    if (!seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}
