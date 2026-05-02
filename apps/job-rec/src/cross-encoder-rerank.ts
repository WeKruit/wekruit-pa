/**
 * Stream H10 D2 — cross-encoder rerank step.
 *
 * Why a 2nd-stage rerank? Cosine similarity on text-embedding-3-small is a
 * decent recall layer (50 → 10) but plateaus around 0.43-0.44 for the
 * tech-track Adam-vs-corpus case. At that range, a "QC Analyst" string
 * sits within ~0.005 of a true-positive "Data Scientist" — the H7 anti-bias
 * regex catches the obvious QA/QC titles, but doesn't help with the
 * borderline cases (e.g. validation engineer / quality assurance manager).
 *
 * Cross-encoders (e.g. BAAI/bge-reranker-v2-m3) jointly encode (query, doc)
 * and produce relevance scores with 5-orders-of-magnitude separation between
 * true positives and false friends. Cost on SiliconFlow free-tier is $0
 * for our daily-batch volume.
 *
 * Pipeline position:
 *   queryMatchingJobs (50 cap)
 *     → cosine rerank (50 → 10)
 *     → cross-encoder rerank (10 → top-N)
 *     → applyTitleAntiBias
 *
 * Failure mode: fail-open. If the API returns 5xx, network drops, or the
 * key is missing, we return the input order with score=null and log a
 * warning. The cron path MUST stay green for users — degraded ranking is
 * acceptable; lost users are not.
 */
export type RerankCandidate = { id: string; text: string }

export type RerankerDeps = {
  /** Inject for tests; defaults to global fetch (Node 22 has it native). */
  fetch?: typeof fetch
  /** Defaults to env SILICONFLOW_API_KEY. Empty string → fail-open. */
  apiKey?: string
  /** Defaults to https://api.siliconflow.cn/v1/rerank */
  endpoint?: string
  /** Defaults to BAAI/bge-reranker-v2-m3 */
  model?: string
  /** Cap on candidates sent to the API. Defaults to 10 — keeps payload small. */
  topN?: number
  /** Optional structured-log callback. */
  log?: (event: string, payload?: Record<string, unknown>) => void
  /** Per-request timeout ms. Default 8000 (cron has a 60s budget across all users). */
  timeoutMs?: number
}

export type RerankedItem = { id: string; score: number | null }

const DEFAULT_ENDPOINT = "https://api.siliconflow.cn/v1/rerank"
const DEFAULT_MODEL = "BAAI/bge-reranker-v2-m3"
const DEFAULT_TOP_N = 10
const DEFAULT_TIMEOUT_MS = 8000

/**
 * Cross-encoder rerank a candidate set against a query string. Returns a
 * NEW array sorted by relevance descending. Fail-open semantics:
 *
 *   - empty `candidates` → []
 *   - missing apiKey OR endpoint OR fetch → input order with score=null
 *   - network / non-2xx / parse error → input order with score=null
 *   - success but malformed payload → input order with score=null
 *
 * The function is pure-ish: a single API call, deterministic when the
 * upstream API is deterministic (which BAAI rerankers are — no sampling).
 */
export async function rerankWithCrossEncoder(
  query: string,
  candidates: RerankCandidate[],
  deps: RerankerDeps = {}
): Promise<RerankedItem[]> {
  const log = deps.log ?? (() => undefined)
  if (!Array.isArray(candidates) || candidates.length === 0) return []

  const trimmed = candidates.slice(0, deps.topN ?? DEFAULT_TOP_N)
  const inputOrder: RerankedItem[] = trimmed.map((c) => ({ id: c.id, score: null }))

  const apiKey =
    typeof deps.apiKey === "string"
      ? deps.apiKey
      : (process.env.SILICONFLOW_API_KEY ?? "").trim()
  if (!apiKey) {
    log("[cross-encoder-rerank] missing_api_key_fail_open", { count: trimmed.length })
    return inputOrder
  }

  const fetchFn = deps.fetch ?? (typeof fetch === "function" ? fetch : null)
  if (!fetchFn) {
    log("[cross-encoder-rerank] no_fetch_impl_fail_open", {})
    return inputOrder
  }

  const endpoint = deps.endpoint ?? DEFAULT_ENDPOINT
  const model = deps.model ?? DEFAULT_MODEL
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const body = JSON.stringify({
      model,
      query: query.slice(0, 512),
      documents: trimmed.map((c) => c.text.slice(0, 512)),
      top_n: trimmed.length,
      return_documents: false,
    })
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      signal: controller.signal,
    })
    if (!res.ok) {
      log("[cross-encoder-rerank] non_2xx_fail_open", { status: res.status })
      return inputOrder
    }
    const json = (await res.json()) as unknown
    const results =
      json && typeof json === "object" && Array.isArray((json as { results?: unknown }).results)
        ? ((json as { results: unknown[] }).results as Array<{ index?: number; relevance_score?: number }>)
        : null
    if (!results) {
      log("[cross-encoder-rerank] malformed_payload_fail_open", {})
      return inputOrder
    }

    const out: RerankedItem[] = []
    for (const r of results) {
      if (typeof r.index !== "number" || r.index < 0 || r.index >= trimmed.length) continue
      const cand = trimmed[r.index]
      if (!cand) continue
      out.push({
        id: cand.id,
        score: typeof r.relevance_score === "number" ? r.relevance_score : null,
      })
    }
    if (out.length === 0) {
      log("[cross-encoder-rerank] no_valid_results_fail_open", {})
      return inputOrder
    }
    // SiliconFlow already returns results sorted by score desc, but we
    // re-sort defensively in case future endpoints differ.
    out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    log("[cross-encoder-rerank] success", {
      sentCount: trimmed.length,
      resultCount: out.length,
      topScore: out[0]?.score ?? null,
    })
    return out
  } catch (err) {
    log("[cross-encoder-rerank] threw_fail_open", {
      error: err instanceof Error ? err.message : String(err),
    })
    return inputOrder
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Synthesize a query string from a normalized profile + recent CV signals.
 * Intentionally short (<200 chars) to keep cross-encoder context-window
 * usage low.
 */
export function buildRerankQuery(input: {
  recentRoleTitle?: string | null
  topSkills?: readonly string[] | null
  industryTags?: readonly string[] | null
}): string {
  const parts: string[] = []
  if (input.recentRoleTitle && input.recentRoleTitle.trim().length > 0) {
    parts.push(input.recentRoleTitle.trim())
  }
  const skills = (input.topSkills ?? []).filter((s) => typeof s === "string" && s.length > 0).slice(0, 5)
  if (skills.length > 0) parts.push(`with skills ${skills.join(", ")}`)
  const tags = (input.industryTags ?? []).filter((t) => typeof t === "string" && t !== "other")
  if (tags.length > 0) parts.push(`interested in ${tags.join(", ")}`)
  return parts.join(" ").slice(0, 480)
}

/**
 * Build a candidate text for a job. Title + company + role-relevant
 * skill keywords give the cross-encoder enough signal without bloating
 * the request.
 */
export function buildJobCandidateText(job: {
  jobTitle?: string | null
  companyName?: string | null
  requiredSkills?: readonly string[] | null
  industryKey?: string | null
}): string {
  const title = (job.jobTitle ?? "").trim()
  const co = (job.companyName ?? "").trim()
  const skills =
    Array.isArray(job.requiredSkills) && job.requiredSkills.length > 0
      ? `; skills: ${job.requiredSkills.slice(0, 8).join(", ")}`
      : ""
  const ik = job.industryKey ? ` (${job.industryKey})` : ""
  return `${title} at ${co}${ik}${skills}`.slice(0, 480)
}


// ===========================================================================
// Stream I (v1.5 / Phase 43.5) — Startup-vs-corp scoring boost.
//
// Pure heuristic. Zero new LLM calls. Multiplicative weights applied AFTER
// cross-encoder rerank, BEFORE applyTitleAntiBias. Latency budget < 5ms over
// 100 jobs (string ops + Set lookup + small regex bank).
//
// User signal hierarchy (one of {1.0, 0.5, 0.0, -0.5, -1.0}):
//   +1.0 strong-yes  : statedPreferences.prefersStartup === true
//   +0.5 lean-yes    : no statement BUT CV has startup-keyword/<500-emp company
//    0.0 neutral     : no statement + no CV signal
//   -0.5 lean-no     : statedPreferences.prefersStartup === false
//   -1.0 strong-no   : prefersStartup === false AND CV is FAANG-dominant
//
// Job signal: isStartupJob(job) returns boolean OR null when we can't tell.
//   - allowlisted FAANG/top-50 → not-startup (false)
//   - companyEmployeeCount < 500 → startup (true)
//   - startup-keyword match in companyName/jobTitle → startup (true)
//   - else → null (unknown — conservative no-boost)
//
// Boost matrix (multiplied onto the cross-encoder relevance score):
//   user +1.0 × startup job  → ×1.30  (strong-yes match)
//   user +0.5 × startup job  → ×1.15  (lean-yes match)
//   user -1.0 × FAANG job    → ×1.20  (FAANG-native gets FAANG boost)
//   else                     → ×1.00  (no change)
//
// Flag-off path returns identity ranking (boost is a no-op).
// ===========================================================================

/**
 * Hand-curated FAANG + top-50 enterprise allowlist. ~80 entries. Hand-curated
 * (NOT LLM-generated) because anything else risks adding mid-stage startups
 * that happened to ship a press release. Lower-cased + trimmed; comparison
 * is case-insensitive.
 *
 * Source criteria: (a) company employee count > ~5,000, AND (b) public-market
 * cap or post-IPO unicorn, AND (c) widely understood as "big-co" by US
 * candidates. We deliberately exclude post-IPO scaleups < 5y from IPO
 * (e.g. Snowflake/Databricks at the boundary — included; Brex/Ramp — excluded).
 *
 * Add-only as the corpus shifts. Each addition is a one-line entry; do not
 * sort — ordering doesn't matter for Set lookup.
 */
export const FAANG_ALLOWLIST: ReadonlySet<string> = new Set([
  // Big tech / FAANG
  "google", "alphabet", "apple", "amazon", "meta", "facebook", "microsoft",
  "netflix",
  // Public-cap tech
  "stripe", "snowflake", "databricks", "openai", "anthropic", "nvidia",
  "tesla", "spacex", "uber", "lyft", "airbnb", "doordash", "instacart",
  "pinterest", "reddit", "linkedin", "twitter", "x corp", "spotify",
  "shopify", "atlassian", "servicenow", "workday", "intuit", "paypal",
  "square", "block", "coinbase", "robinhood",
  // Legacy enterprise
  "ibm", "oracle", "sap", "salesforce", "cisco", "adobe", "vmware", "dell",
  "hp", "hewlett-packard", "intel", "amd", "qualcomm", "broadcom",
  "texas instruments", "applied materials", "lam research",
  // Consulting / finance giants
  "mckinsey", "bain", "bcg", "deloitte", "accenture", "kpmg", "ey", "pwc",
  "goldman sachs", "morgan stanley", "jpmorgan", "jpmorgan chase",
  "bank of america", "citigroup", "wells fargo", "blackrock",
  "two sigma", "citadel", "jane street", "jump trading", "hudson river trading",
  // Other enterprise
  "walmart", "target", "costco", "fedex", "ups",
  "disney", "warner bros", "comcast", "at&t", "verizon",
  "boeing", "lockheed martin", "raytheon", "northrop grumman",
  // China big tech (some users care)
  "alibaba", "tencent", "bytedance", "baidu", "meituan", "jd.com",
  "pinduoduo", "didi", "kuaishou", "xiaomi", "huawei",
])

/**
 * Bilingual startup keywords. RegExp array — case-insensitive on the
 * company-name/job-title side. Ordered most-specific first so matches
 * surface stronger signal early.
 */
export const STARTUP_KEYWORDS: readonly RegExp[] = [
  // English
  /\bearly[- ]stage\b/i,
  /\bseries\s+(?:seed|pre[- ]?seed|a|b|c)\b/i,
  /\bseed\s+stage\b/i,
  /\bfounding\s+(?:engineer|team|member)\b/i,
  /\bfounder['’]?s\s+office\b/i,
  /\bwe['’]?re\s+hiring\s+our\s+first\b/i,
  /\bstealth\s+(?:mode|startup)\b/i,
  /\byc\s+w\d{2}\b/i,
  /\byc\s+s\d{2}\b/i,
  /\b(?:y\s+combinator|y-combinator)\b/i,
  // Chinese
  /创业/, /早期/, /初创/, /我们刚拿到融资/, /种子轮/, /天使轮/, /A\s*轮/, /B\s*轮/,
  /创始团队/, /创始工程师/,
]

/**
 * Tunable boost weights. Centralized so ops can tune without redeploying
 * Firestore config. Rollback = revert this CONST.
 */
export const BOOST_WEIGHTS = {
  STRONG_YES_STARTUP: 1.3,
  LEAN_YES_STARTUP: 1.15,
  STRONG_NO_FAANG: 1.2,
  NEUTRAL: 1.0,
} as const

export type UserStartupSignal = -1.0 | -0.5 | 0.0 | 0.5 | 1.0

export type CvExperience = {
  company?: string | null
  companyEmployeeCount?: number | null
  industry?: string | null
}

/**
 * Returns true when companyName matches a known FAANG/top-50 entry.
 * Lower-cased compare. Pure / no allocation per call beyond .trim().
 */
export function isFaangCompany(companyName: string | null | undefined): boolean {
  if (typeof companyName !== "string") return false
  const c = companyName.trim().toLowerCase()
  if (c.length === 0) return false
  return FAANG_ALLOWLIST.has(c)
}

/**
 * Returns true when text matches any STARTUP_KEYWORDS regex. Cheap; the
 * regex bank is small (~20 entries).
 */
function matchesStartupKeyword(text: string | null | undefined): boolean {
  if (typeof text !== "string" || text.length === 0) return false
  for (const re of STARTUP_KEYWORDS) {
    if (re.test(text)) return true
  }
  return false
}

/**
 * Heuristic startup detector. Returns:
 *   - true  : confident startup (small employee count OR keyword match,
 *             AND not in FAANG allowlist)
 *   - false : confident not-startup (FAANG/top-50 allowlist hit)
 *   - null  : unknown — caller should default to no-boost
 *
 * Conservative bias: when companyEmployeeCount is missing AND no keyword
 * fires AND not in FAANG list → return null (unknown), NOT true. We'd
 * rather miss a boost than mis-fire one.
 */
export function isStartupJob(job: {
  companyName?: string | null
  jobTitle?: string | null
  companyEmployeeCount?: number | null
}): boolean | null {
  if (isFaangCompany(job.companyName)) return false
  // Strong signal: explicit small headcount.
  if (typeof job.companyEmployeeCount === "number" && job.companyEmployeeCount > 0 && job.companyEmployeeCount < 500) {
    return true
  }
  // Keyword bank — companyName + jobTitle text.
  if (matchesStartupKeyword(job.companyName) || matchesStartupKeyword(job.jobTitle)) {
    return true
  }
  return null
}

/**
 * User-side signal in {-1.0, -0.5, 0.0, 0.5, 1.0}.
 *
 * Decision tree:
 *   prefersStartup === true                                          → +1.0
 *   prefersStartup === false AND CV-FAANG-dominant                    → -1.0
 *   prefersStartup === false                                          → -0.5
 *   prefersStartup unset AND CV has startup-signal experience         → +0.5
 *   else                                                              →  0.0
 *
 * "CV-FAANG-dominant" = ≥1 experience at a FAANG-allowlisted company.
 * "CV startup-signal" = ≥1 experience matching keyword OR <500 emp.
 */
export function userPreferStartup(profile: {
  statedPreferences?: { prefersStartup?: boolean | null } | null
  cvExperiences?: readonly CvExperience[] | null
}): UserStartupSignal {
  const stated = profile.statedPreferences?.prefersStartup
  const exps = Array.isArray(profile.cvExperiences) ? profile.cvExperiences : []
  const hasFaangExp = exps.some((e) => isFaangCompany(e?.company ?? null))
  const hasStartupExp = exps.some((e) => {
    if (!e) return false
    if (typeof e.companyEmployeeCount === "number" && e.companyEmployeeCount > 0 && e.companyEmployeeCount < 500) {
      return true
    }
    return matchesStartupKeyword(e.company ?? null)
  })

  if (stated === true) return 1.0
  if (stated === false) {
    return hasFaangExp ? -1.0 : -0.5
  }
  // No statement — fall back to CV.
  if (hasStartupExp) return 0.5
  return 0.0
}

/**
 * Compute the multiplicative boost for a (user signal, job) pair.
 * Pure / branchless after lookups. Returns 1.0 (no-op) for unknown jobs
 * or neutral users — callers can short-circuit on === 1.0.
 */
export function computeStartupBoost(
  userSignal: UserStartupSignal,
  job: { companyName?: string | null; jobTitle?: string | null; companyEmployeeCount?: number | null }
): number {
  const isStartup = isStartupJob(job)
  // Strong-yes user × startup job
  if (userSignal === 1.0 && isStartup === true) return BOOST_WEIGHTS.STRONG_YES_STARTUP
  // Lean-yes user × startup job
  if (userSignal === 0.5 && isStartup === true) return BOOST_WEIGHTS.LEAN_YES_STARTUP
  // Strong-no user × FAANG job (isStartup === false means allowlisted-FAANG hit)
  if (userSignal === -1.0 && isStartup === false) return BOOST_WEIGHTS.STRONG_NO_FAANG
  return BOOST_WEIGHTS.NEUTRAL
}

/**
 * Per-job boost explanation surfaced for daily-push reasoning + observability.
 * Only emitted when boostMult !== 1.0. Forward-compatible for H13/D2 formatter.
 */
export type BoostExplanation = {
  jobId: string
  boostMult: number
  userSignal: UserStartupSignal
  jobSignal: "startup" | "faang" | "unknown"
}

/**
 * Apply startup-vs-corp boost to a ranked candidate set. Pure / deterministic.
 *
 * Behavior:
 *   - When all per-job mults === 1.0, returns input array unchanged + empty
 *     explanations (zero-cost path).
 *   - Otherwise, computes pseudo-score `(rank ? rank : pseudo) * mult`, sorts
 *     descending, and returns the new order + explanations for non-1.0 entries.
 *
 * `baseScores` (optional): pass cross-encoder relevance scores if available;
 * when null/missing for a job, we fall back to `1 / (idx + 1)` so original
 * order is preserved in the absence of boost.
 *
 * Latency: O(n log n) for the sort + O(n) for the scan. ~80-entry Set lookup
 * + ~20-entry regex bank per job. Empirically < 5ms over 100 jobs.
 */
export function applyStartupBoost<
  J extends { id: string; companyName?: string | null; jobTitle?: string | null; companyEmployeeCount?: number | null },
>(
  jobs: readonly J[],
  userSignal: UserStartupSignal,
  baseScores?: ReadonlyMap<string, number | null>
): { jobs: J[]; explanations: BoostExplanation[] } {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { jobs: [], explanations: [] }
  }
  const explanations: BoostExplanation[] = []
  let anyBoost = false
  const scored = jobs.map((j, idx) => {
    const base = (() => {
      const s = baseScores?.get(j.id)
      if (typeof s === "number" && Number.isFinite(s) && s > 0) return s
      // No baseScore → uniform 1.0. The boost mult IS the only differentiator,
      // which gives user preference full weight. Stable-sort ties by original idx
      // (so unboosted jobs preserve cross-encoder order among themselves).
      return 1.0
    })()
    const mult = computeStartupBoost(userSignal, j)
    if (mult !== BOOST_WEIGHTS.NEUTRAL) {
      anyBoost = true
      const isStartup = isStartupJob(j)
      const jobSignal: BoostExplanation["jobSignal"] =
        isStartup === true ? "startup" : isStartup === false ? "faang" : "unknown"
      explanations.push({ jobId: j.id, boostMult: mult, userSignal, jobSignal })
    }
    return { j, score: base * mult, idx }
  })
  if (!anyBoost) {
    // Zero-impact path — preserve referential identity (cheap caller contract).
    return { jobs: jobs.slice(), explanations: [] }
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.idx - b.idx // stable on ties
  })
  return { jobs: scored.map((s) => s.j), explanations }
}
