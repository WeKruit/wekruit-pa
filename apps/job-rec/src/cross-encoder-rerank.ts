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
