/**
 * Phase 54 (USER-TAG-03) — Onboarding chat-answer → canonical Phase 52
 * vocab mappers.
 *
 * The Phase 52 design lock (CLAUDE.md v1.6) put two tag axes in canonical,
 * spelled-out closed enums:
 *   - `targetRoleFunction[]` (jobright `utm_campaign` 17, ROLE_FUNCTION_VOCAB)
 *   - `targetLocations[]` (130+ region/metro tokens, LOCATION_VOCAB)
 *   - `visaStatus` (4 enum, VISA_VOCAB — collapses OPT/CPT/H1B → sponsor_needed)
 *
 * Onboarding lives in iter34's deterministic flow (packages/pa-orchestrator/
 * src/onboarding.ts). It collects answers and writes them into legacy
 * `pa-users.statedPreferences` with smaller closed-set tokens (e.g.
 * CanonicalRole = "swe", CanonicalLocation = "sf"). Phase 54 now also
 * writes the SAME signal — re-mapped into Phase 52 vocab — to
 * `pa-users.tags` via `mergeUserTags`.
 *
 * These mappers are deterministic, regex-driven, and fail-soft (return
 * empty / null on no-match rather than throwing). When the LLM signal is
 * unclear, downstream Phase 56 hard-filter treats missing fields as
 * "no restriction" so a low-quality classification never blocks matches.
 *
 * Design notes:
 *   - We deliberately keep these as deterministic mappers (not LLM calls)
 *     so onboarding latency stays low. D15 (LLM judgment) applies to the
 *     CV-side parser and ambiguous classification cases, not to
 *     mid-conversation reply parsing.
 *   - All output tokens come from `@wekruit/shared-tags` canonical vocab
 *     to honor "do not duplicate vocab" (CLAUDE.md anti-pattern).
 *   - Multi-pick allowed: `mapAnswerToRoleFunction` + `mapAnswerToLocations`
 *     return arrays; user may target multiple.
 */

import {
  ROLE_FUNCTION_VOCAB,
  type RoleFunction,
  LOCATION_VOCAB,
  type Location,
  VISA_VOCAB,
  type Visa,
} from "@wekruit/shared-tags"

// ---------------------------------------------------------------------------
// roleFunction mapper
// ---------------------------------------------------------------------------

/**
 * Keyword → ROLE_FUNCTION_VOCAB token. Order matters: most-specific first
 * to avoid generic "engineer" matching before "data engineer".
 *
 * The canonical vocab has 17 spelled-out entries; this map covers the
 * common job-search keywords.
 */
const ROLE_FUNCTION_KEYWORDS: ReadonlyArray<{
  pattern: RegExp
  token: RoleFunction
}> = [
  // Data analysis: data scientist/analyst/engineer, ML, AI engineer
  {
    pattern:
      /(data\s+(scientist|analyst|analytics|engineer|science)|analytics?\b|insights?\b|ml\s+engineer|machine\s+learning|deep\s+learning|ai\s+engineer|llm)/i,
    token: "data_analysis",
  },
  // Product management
  {
    pattern: /(\bpm\b|product\s+manager|product\s+management|tpm\b)/i,
    token: "product_management",
  },
  // Business analyst
  {
    pattern:
      /(business\s+(analyst|analysis)|\bba\b|executive\s+assistant|administrative\s+assistant|admin\s+assistant|office\s+manager|operations?\s+(coordinator|assistant|analyst)|program\s+(coordinator|operations))/i,
    token: "business_analyst",
  },
  // Designer / creative
  {
    pattern:
      /(designer|design\b|\bux\b|\bui\b|product\s+designer|creative|illustrator)/i,
    token: "creatives_and_design",
  },
  // Consultant
  {
    pattern: /(consultant|consulting|management\s+consultant)/i,
    token: "consultant",
  },
  // Accounting/finance
  {
    pattern:
      /(accountant|finance\b|financial\b|cpa\b|investment\s+(banking|analyst)|equity\s+research)/i,
    token: "accounting_and_finance",
  },
  // Marketing
  {
    pattern: /(marketing|growth|brand|content\s+marketing|seo)/i,
    token: "marketing",
  },
  // Management/executive
  {
    pattern:
      /(\bvp\b|director\b|engineering\s+manager|\bem\b|head\s+of\s+|chief|ceo\b|cto\b|coo\b|founder)/i,
    token: "management_and_executive",
  },
  // Sales
  {
    pattern: /(sales|account\s+exec|\bae\b|\bbd\b|business\s+development)/i,
    token: "sales",
  },
  // Human resources
  {
    pattern: /(human\s+resources|\bhr\b|recruiter|recruiting|talent\b)/i,
    token: "human_resources",
  },
  // Legal/compliance
  {
    pattern: /(lawyer|legal\b|attorney|paralegal|compliance)/i,
    token: "legal_and_compliance",
  },
  // Arts/entertainment
  {
    pattern: /(artist|musician|actor|filmmaker)/i,
    token: "arts_and_entertainment",
  },
  // Education/training
  {
    pattern: /(teacher|teaching\s+assistant|professor|educator|tutor|tutoring|trainer\b)/i,
    token: "education_and_training",
  },
  // Public sector
  {
    pattern: /(government\b|public\s+sector|policy\b|gov't)/i,
    token: "public_sector_and_government",
  },
  // Customer service/support
  {
    pattern:
      /(customer\s+(service|support|success)|support\s+engineer)/i,
    token: "customer_service_and_support",
  },
  // Software engineering — broad fallback for "engineer" / "developer"
  {
    pattern:
      /(swe|software\s+engineer|software\s+dev|software\s+development|frontend|backend|fullstack|\bfe\b|\bbe\b|coder|\bcs\b|computer\s+science|developer|web\s+developer|mobile\s+developer)/i,
    token: "software_engineering",
  },
  // Engineering & development (broader — includes hardware, mechanical, etc).
  // Only fires when no software_engineering / data_analysis cue is present —
  // we expose them as separate vocab axes per Phase 52 D1.
  {
    pattern:
      /(mechanical\s+engineer|electrical\s+engineer|hardware\s+engineer|ee\s+engineer|civil\s+engineer|chemical\s+engineer|bioengineer|firmware)/i,
    token: "engineering_and_development",
  },
]

/**
 * Map a free-text role answer to one or more ROLE_FUNCTION_VOCAB tokens.
 * Multi-pick: the user may say "data + product" → both tokens returned.
 *
 * Empty / unrecognized → []. Phase 56 hard-filter treats [] as "no
 * restriction" (don't filter on this axis).
 */
export function mapAnswerToRoleFunction(
  text: string | null | undefined
): RoleFunction[] {
  if (!text || typeof text !== "string") return []
  const trimmed = text.trim()
  if (!trimmed) return []
  const matched = new Set<RoleFunction>()
  for (const { pattern, token } of ROLE_FUNCTION_KEYWORDS) {
    if (pattern.test(trimmed)) matched.add(token)
  }
  return Array.from(matched)
}

// ---------------------------------------------------------------------------
// yoeRange bucketer
// ---------------------------------------------------------------------------

/**
 * Bucket a numeric YoE into one of 5 string buckets. Mirrors Phase 56
 * career-stage hard-filter window (junior 0-3 vs senior 4+).
 */
export type YoeRange = "0-1" | "2-3" | "4-6" | "7-10" | "10+"

/**
 * yoe → bucket. Null / negative / NaN → null. Values are inclusive at
 * lower bound, e.g. yoe=2 → "2-3".
 */
export function bucketYoe(yoe: number | null | undefined): YoeRange | null {
  if (yoe == null) return null
  if (typeof yoe !== "number") return null
  if (!Number.isFinite(yoe) || yoe < 0) return null
  if (yoe <= 1) return "0-1"
  if (yoe <= 3) return "2-3"
  if (yoe <= 6) return "4-6"
  if (yoe <= 10) return "7-10"
  return "10+"
}

/**
 * Convert a free-text YoE answer ("3 years", "new grad", "5+") to a bucket.
 * Returns null when no clean signal.
 */
export function mapAnswerToYoeBucket(
  text: string | null | undefined
): YoeRange | null {
  if (!text || typeof text !== "string") return null
  const t = text.trim()
  if (!t) return null
  // 10+ explicit FIRST (longest match wins so "10 or more" doesn't fall through)
  if (/(10\s*\+|over\s+10|more\s+than\s+10|10\s+or\s+more)/i.test(t)) {
    return "10+"
  }
  // New-grad signals
  if (
    /(new\s*grad|fresh(\s*out)?|just\s*graduated|no\s*experience|^0\s*years?|zero\s+(years|exp))/i.test(
      t
    )
  ) {
    return "0-1"
  }
  // Numeric "N years/yrs/y"
  const num = t.toLowerCase().match(/(\d{1,2})\s*(\+)?\s*(years?|yrs?|y\b)/i)
  if (num && num[1]) {
    const n = parseInt(num[1], 10)
    const hasPlus = num[2] === "+"
    if (Number.isFinite(n) && n >= 0 && n <= 50) {
      const bucket = bucketYoe(n)
      // "5+" bumps "4-6" → "7-10" only if the user signals long horizon —
      // we keep it conservative and just use the base bucket.
      return hasPlus && n >= 7 ? "10+" : bucket
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// visa mapper (4-enum collapse)
// ---------------------------------------------------------------------------

/**
 * Map a free-text visa answer to one of 4 VISA_VOCAB tokens. D4 lock:
 * OPT/CPT/H1B/H4 EAD ALL collapse to `sponsor_needed`. The 4-token enum
 * is downstream-friendly: hard-filter just checks "needs sponsor →
 * drop sponsorship=false jobs".
 *
 * Returns "other" on unrecognized input (Phase 56 treats as "match all").
 */
export function mapAnswerToVisa(
  text: string | null | undefined
): Visa {
  if (!text || typeof text !== "string") return "other"
  const t = text.trim()
  if (!t) return "other"

  // Citizen — most-specific first to avoid GC matching "card" via citizen
  if (/(us\s*citizen|usc\b|american\s+citizen|citizen\b)/i.test(t)) {
    return "citizen"
  }
  // Permanent resident / green card
  if (/(green\s*card|gc\b|permanent\s*resident|\bpr\b\s*(holder)?)/i.test(t)) {
    return "permanent_resident"
  }
  // Sponsor-needed bucket: OPT/CPT/H1B/H4 EAD/sponsor explicit
  if (
    /(sponsor|sponsorship|need.*visa|opt\b|stem\s*opt|\bcpt\b|h[-\s]?1\s*b|h1\b|\bh4\b|f[-\s]?1\b|tn\s*visa|j[-\s]?1\b|stem)/i.test(
      t
    )
  ) {
    return "sponsor_needed"
  }
  return "other"
}

// ---------------------------------------------------------------------------
// targetLocations mapper
// ---------------------------------------------------------------------------

/**
 * Aliases → LOCATION_VOCAB token. Common abbreviations + colloquial
 * shortcuts.
 *
 * The actual LOCATION_VOCAB has 130+ canonical tokens; this alias map
 * just routes the common ones. Anything not matched falls through to
 * substring search against the spelled-out vocab (best-effort).
 */
const LOCATION_ALIASES: ReadonlyArray<{ pattern: RegExp; token: Location }> = [
  // Remote / open-ended
  {
    pattern: /(anywhere|wherever|no\s*preference)/i,
    token: "remote_anywhere",
  },
  {
    pattern: /(remote(\s+us|\s+united\s+states)?)/i,
    token: "remote_united_states",
  },
  // US metros
  {
    pattern:
      /(bay\s*area|\bsf\b|san\s*francisco|south\s*bay|peninsula|silicon\s*valley)/i,
    token: "san_francisco_bay_area",
  },
  {
    pattern: /(\bnyc\b|new\s*york|manhattan|brooklyn|\bny\b)/i,
    token: "new_york_metro",
  },
  { pattern: /(seattle|wa\s*state)/i, token: "seattle_metro" },
  { pattern: /(\bla\b|los\s*angeles)/i, token: "los_angeles_metro" },
  {
    pattern: /(boston|cambridge\s+ma|\bma\b\s+area)/i,
    token: "boston_metro",
  },
  { pattern: /(chicago|\bil\b\s+(area|metro))/i, token: "chicago_metro" },
  { pattern: /(austin|\btx\b\s+(area|metro))/i, token: "austin_metro" },
  { pattern: /(denver)/i, token: "denver_metro" },
  { pattern: /(washington\s*dc|dc\s+metro|\bdc\b)/i, token: "washington_dc_metro" },
  { pattern: /(atlanta)/i, token: "atlanta_metro" },
  { pattern: /(miami)/i, token: "miami_metro" },
  { pattern: /(philadelphia)/i, token: "philadelphia_metro" },
  { pattern: /(dallas|fort\s+worth)/i, token: "dallas_fort_worth" },
  { pattern: /(houston)/i, token: "houston_metro" },
  { pattern: /(san\s+diego)/i, token: "san_diego" },
  // Canada
  { pattern: /(toronto)/i, token: "toronto" },
  { pattern: /(vancouver)/i, token: "vancouver" },
  { pattern: /(montreal)/i, token: "montreal" },
  // China
  { pattern: /(shanghai)/i, token: "shanghai" },
  { pattern: /(beijing|peking)/i, token: "beijing" },
  { pattern: /(hangzhou)/i, token: "hangzhou" },
  { pattern: /(shenzhen)/i, token: "shenzhen" },
  { pattern: /(guangzhou)/i, token: "guangzhou" },
  // EU / UK
  { pattern: /(london)/i, token: "london_united_kingdom" },
  { pattern: /(berlin)/i, token: "berlin" },
  { pattern: /(paris)/i, token: "paris" },
  { pattern: /(amsterdam)/i, token: "amsterdam" },
  // APAC
  { pattern: /(singapore)/i, token: "singapore" },
  { pattern: /(tokyo)/i, token: "tokyo" },
  { pattern: /(hong\s*kong|hk\b)/i, token: "hong_kong" },
  { pattern: /(taipei)/i, token: "taipei" },
  { pattern: /(seoul)/i, token: "seoul" },
  { pattern: /(sydney)/i, token: "sydney" },
  { pattern: /(bangalore)/i, token: "bangalore" },
  { pattern: /(mumbai)/i, token: "mumbai" },
]

/**
 * Map a free-text location answer to canonical LOCATION_VOCAB tokens.
 * Multi-pick allowed (user may target several metros). Empty / unrecognized
 * → [] (Phase 56 treats as "anywhere bypass").
 */
export function mapAnswerToLocations(
  text: string | null | undefined
): Location[] {
  if (!text || typeof text !== "string") return []
  const trimmed = text.trim()
  if (!trimmed) return []

  const matched = new Set<Location>()
  // 1. Alias pass — most users type "SF" / "NYC" not "san_francisco_bay_area"
  for (const { pattern, token } of LOCATION_ALIASES) {
    if (pattern.test(trimmed)) matched.add(token)
  }
  // 2. Direct vocab match — if user typed the spelled-out canonical token
  const lower = trimmed.toLowerCase().replace(/\s+/g, "_")
  for (const tok of LOCATION_VOCAB) {
    if (lower.includes(tok)) matched.add(tok)
  }
  return Array.from(matched)
}

/**
 * Canonicalize ALREADY-TOKENIZED location strings → `LOCATION_VOCAB`. The
 * conversation-extractor emits free-form location strings ("new_york", "nyc",
 * "remote"); onboarding emits canonical via `mapAnswerToLocations`. Funnel BOTH
 * through here at the SOLE writer (`applyPartialUserTags`) so the stored token
 * is canonical and actually intersects the job side (`matching-jobs.locationBuckets`
 * = `LOCATION_VOCAB` enum, enforced by the enrichment writer). This is the fix
 * for the recurring location drift (new_york vs new_york_metro) that silently
 * over-filtered the location hard gate to recCount=0.
 *
 * Preserve the V16 anywhere-bypass tokens verbatim (`anywhere`/`any`, plus the
 * in-vocab `remote_*` forms) — all are in `ANYWHERE_LOCATION_TOKENS`. Tokens we
 * can't resolve are kept lowercased: never DROP a stated preference. Used by the
 * writer for both `targetLocations` and `targetCountry`.
 */
// The V16 anywhere-bypass tokens that are NOT in LOCATION_VOCAB — keep these
// verbatim so the matcher's location bypass still fires. Mirrors the non-vocab
// members of ANYWHERE_LOCATION_TOKENS (query-matching-jobs-v16.ts): bare
// "remote"/"anywhere"/"any" are generic open-location signals, NOT specific
// regions — do NOT canonicalize them to remote_united_states (that would narrow
// to US-remote and drop the bypass). The in-vocab forms (remote_anywhere,
// remote_global) are preserved by the vocab check.
const LOCATION_BYPASS_KEEP = new Set<string>(["anywhere", "any", "remote"])
export function canonicalizeLocationTokens(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const vocab = new Set<string>(LOCATION_VOCAB as readonly string[])
  const seen = new Set<string>()
  const out: string[] = []
  const push = (t: string): void => {
    const v = t.trim().toLowerCase()
    if (v && !seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  for (const raw of input) {
    if (typeof raw !== "string") continue
    const tok = raw.trim().toLowerCase()
    if (!tok) continue
    // Already canonical, or a bypass token the matcher recognizes → keep verbatim.
    if (vocab.has(tok) || LOCATION_BYPASS_KEEP.has(tok)) {
      push(tok)
      continue
    }
    // Loose token ("new_york", "nyc", "remote") → run through the SAME alias/vocab
    // mapper onboarding uses (underscores → spaces so "new_york" hits the alias).
    const mapped = mapAnswerToLocations(tok.replace(/_/g, " "))
    if (mapped.length > 0) {
      for (const m of mapped) push(m)
    } else {
      push(tok) // unmappable → keep lowercased, never drop a stated preference
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// preferredLang detector
// ---------------------------------------------------------------------------

/**
 * Heuristic CJK vs Latin char-count to detect preferred reply language.
 * Threshold: 50% CJK → 'zh', 50% Latin → 'en', mixed otherwise.
 *
 * Mirrors the Phase 52 schema's `preferredLang` enum (zh|en|mixed).
 *
 * Operates on last N user messages (default: all messages passed). Empty
 * input → null (caller falls back to runtime detection).
 */
export function detectLang(
  messages: ReadonlyArray<string> | null | undefined
): "zh" | "en" | "mixed" | null {
  if (!Array.isArray(messages) || messages.length === 0) return null
  let cjkChars = 0
  let latinWords = 0
  for (const m of messages) {
    if (typeof m !== "string") continue
    // CJK unified ideographs + extensions (unicode-escaped so no literal
    // CJK char appears in source; ranges == U+3400..U+9FFF, U+F900..U+FAFF).
    const cjk = m.match(/[\u3400-\u9fff\uf900-\ufaff]/g)
    if (cjk) cjkChars += cjk.length
    const latin = m.match(/[a-zA-Z]+/g)
    if (latin) latinWords += latin.length
  }
  if (cjkChars === 0 && latinWords === 0) return null
  // Treat each CJK char as 1 unit, each Latin word as 1 unit (rough word-equivalent)
  const total = cjkChars + latinWords
  if (total === 0) return null
  const zhRatio = cjkChars / total
  const enRatio = latinWords / total
  if (zhRatio >= 0.7) return "zh"
  if (enRatio >= 0.7) return "en"
  return "mixed"
}

// ---------------------------------------------------------------------------
// Re-exports for consumers
// ---------------------------------------------------------------------------

export { ROLE_FUNCTION_VOCAB, LOCATION_VOCAB, VISA_VOCAB }
export type { RoleFunction, Location, Visa }
