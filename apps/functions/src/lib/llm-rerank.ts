/**
 * iter34 followup G.4 / D.15 — async LLM rerank module.
 *
 * Adam directive 2026-05-05: "用 cheap llm 是没问题的, silconflow 的 7b 就是
 * 他妈免费的, 我们可以 async batch 跑在后台没关系".
 *
 * Wraps SiliconFlow Qwen-7B (free tier) as a JSON-mode reranker so the
 * orchestrator's hard-filter + skill/embedding score pipeline can be augmented
 * with an LLM-grounded reasoning pass for top-N candidates. Output schema is
 * deterministic ({jobId, rank, score, reasoning}) and sanitized so a misbehaving
 * model can never poison the downstream cache.
 *
 * Integration mode (Adam-pinned): ASYNC fire-and-forget. The match request
 * returns the existing skill+embedding top-5 in <200ms, and a background
 * llmRerank() call writes its output into `pa-user-rerank-cache/{userId}` for
 * the NEXT request. This module ONLY exposes the helper — the call site +
 * cache write live in a follow-up worker (see TODO in orchestrator-deps.ts).
 *
 * Cost / latency budget:
 *   - Qwen2.5-7B-Instruct on SiliconFlow free tier — $0/call.
 *   - Latency: 1-3s for N≤10 candidates with response_format=json_object.
 *   - We pass `temperature: 0.2` to make rank deterministic enough for cache.
 *   - max_tokens: 1500 — leaves headroom for 5-10 jobs × ~80 tokens reasoning.
 *
 * Failure modes (all return a clean RerankOutput, never throw):
 *   - Empty input.jobs → ranked=[].
 *   - Invalid JSON from LLM → ranked=[] (parse caught).
 *   - LLM hallucinates jobIds not in input → filtered out.
 *   - Duplicate / out-of-order ranks → re-sequenced 1..N by stable sort.
 *   - score outside [0, 1] → clamped.
 *   - reasoning >200 chars → truncated.
 *
 * NOTE on SDK choice: this module uses the OpenAI SDK pointed at SiliconFlow's
 * /v1 base URL (compatible API). Other SiliconFlow callers in this repo use raw
 * `fetch` — both shapes work. We prefer the SDK here because `response_format:
 * json_object` is a typed first-class field on the SDK request type, which
 * surfaces wire-protocol mismatches at compile time.
 */

import { logger } from "firebase-functions/v2"

import { logTokenSpend } from "../instrumentation/cost-logger.js"

/**
 * Candidate user signal piped into the rerank prompt. Kept terse on purpose —
 * Qwen-7B's 32k context is plenty but free-tier rate limits favor compactness.
 * `cvSummary` is the 1-2 sentence snapshot from `generateCvAnalysis` (or any
 * cheap summary) — NOT the full resume.
 */
export interface RerankInput {
  candidate: {
    targetRole?: string[]
    topSkills?: string[]
    yoeRange?: [number, number]
    visaStatus?: string
    /** 1-2 sentences, ~200 chars max — long resumes blow the prompt budget. */
    cvSummary?: string
  }
  jobs: Array<{
    id: string
    roleTitle: string
    companyName: string
    industryEnum?: string[]
    requiredSkills?: string[]
    seniorityLevel?: string
    sponsorship?: boolean
    locationRaw?: string
    salaryRange?: string
    /** Short job description, 200-400 chars suggested. Truncate before passing. */
    jobDescription?: string
  }>
}

/**
 * One rerank decision per known job. `rank` is always 1..ranked.length after
 * sanitize regardless of what the LLM emitted.
 */
export interface RerankRow {
  jobId: string
  /** 1 = best match. Always 1..N after sanitize. */
  rank: number
  /** 0..1 confidence. Clamped after sanitize. */
  score: number
  /** ≤200 chars one-sentence "为啥这个 rank" reason. */
  reasoning: string
}

export interface RerankOutput {
  ranked: RerankRow[]
  modelUsed: string
  latencyMs: number
}

/**
 * Minimal shape of the SiliconFlow / OpenAI chat-completion response we
 * actually consume. Kept here so tests can fake the client without pulling in
 * the SDK's full typings surface.
 */
export interface RerankChatClient {
  chat: {
    completions: {
      create: (req: {
        model: string
        messages: Array<{ role: "system" | "user"; content: string }>
        response_format?: { type: "json_object" }
        temperature?: number
        max_tokens?: number
      }) => Promise<{
        choices?: Array<{ message?: { content?: string | null } | null } | null>
        usage?: {
          prompt_tokens?: number
          completion_tokens?: number
          total_tokens?: number
        }
      }>
    }
  }
}

export interface LlmRerankDeps {
  /** Inject for tests; default builds an OpenAI client on first call. */
  client?: RerankChatClient
  /** Inject for deterministic latency in tests. Defaults to Date.now. */
  now?: () => number
  /** Free-form labels passed to the cost logger (caller / userId). */
  costLabels?: Record<string, string | number | undefined>
}

const RERANK_MODEL = "Qwen/Qwen2.5-7B-Instruct"
const RERANK_TEMPERATURE = 0.2
const RERANK_MAX_TOKENS = 1500
const REASONING_MAX_LEN = 200

/**
 * Build the static system prompt. Deliberately bilingual-friendly with
 * mandatory JSON contract — Qwen2.5-7B with `response_format=json_object`
 * obeys the schema reliably when the example is in-prompt.
 */
function buildSystemPrompt(): string {
  return [
    "你是 job match assistant。input 是候选人 (candidate) 和 N 个 jobs。",
    "任务: 给每个 job 排一个 rank (1 最匹配, N 最不匹配), 一个 0..1 的 score,",
    "以及一句话的 reasoning 解释为啥这个 rank (中英文都可以, 简短直接)。",
    "",
    "输出 STRICT JSON, schema:",
    '{"ranked":[{"jobId":"<id>","rank":<int 1..N>,"score":<float 0..1>,"reasoning":"<one short sentence>"}, ...]}',
    "",
    "规则:",
    "- 每个 input job 都必须出现在 ranked 里, jobId 必须严格匹配 input。",
    "- rank 1..N 之间不能重复, 1 是最匹配的。",
    "- score 越高越匹配, [0,1] 闭区间。",
    "- reasoning <= 200 字符, 一句话, 不要列表不要 bullet。",
    "- 不输出 prose, 不输出 markdown, 不输出 commentary, 只输出 JSON。",
  ].join("\n")
}

/**
 * Default lazy client factory. Reads `SILICONFLOW_API_KEY` from process.env at
 * call time so Cloud Functions secret-binding works (firebase-functions v2
 * surfaces secrets as env vars). Returns null when no key is present — the
 * caller emits a warn and returns an empty ranked array.
 */
async function defaultRerankClient(): Promise<RerankChatClient | null> {
  const apiKey = process.env.SILICONFLOW_API_KEY?.trim() || ""
  if (!apiKey) return null
  const { default: OpenAI } = (await import("openai")) as unknown as {
    default: new (init: { apiKey: string; baseURL?: string }) => RerankChatClient
  }
  return new OpenAI({ apiKey, baseURL: "https://api.siliconflow.cn/v1" })
}

/**
 * Async LLM rerank entrypoint. NEVER throws — any failure path returns
 * `{ranked:[], modelUsed, latencyMs}`. Caller treats empty `ranked` as "no
 * rerank available, use upstream skill+embedding order".
 */
export async function llmRerank(
  input: RerankInput,
  deps: LlmRerankDeps = {}
): Promise<RerankOutput> {
  const now = deps.now ?? (() => Date.now())
  const t0 = now()

  // Empty input → short-circuit. No LLM call, no cost, return empty ranked.
  if (!Array.isArray(input.jobs) || input.jobs.length === 0) {
    return { ranked: [], modelUsed: RERANK_MODEL, latencyMs: now() - t0 }
  }

  let client: RerankChatClient | null
  try {
    client = deps.client ?? (await defaultRerankClient())
  } catch (err) {
    logger.warn("[llm-rerank] client_init_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return { ranked: [], modelUsed: RERANK_MODEL, latencyMs: now() - t0 }
  }
  if (!client) {
    logger.warn("[llm-rerank] no_api_key")
    return { ranked: [], modelUsed: RERANK_MODEL, latencyMs: now() - t0 }
  }

  const systemPrompt = buildSystemPrompt()
  const userPrompt = JSON.stringify(input)

  let res: Awaited<ReturnType<RerankChatClient["chat"]["completions"]["create"]>>
  try {
    res = await client.chat.completions.create({
      model: RERANK_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: RERANK_TEMPERATURE,
      max_tokens: RERANK_MAX_TOKENS,
    })
  } catch (err) {
    logger.warn("[llm-rerank] api_call_failed", {
      error: err instanceof Error ? err.message : String(err),
      jobCount: input.jobs.length,
    })
    return { ranked: [], modelUsed: RERANK_MODEL, latencyMs: now() - t0 }
  }

  const raw = res.choices?.[0]?.message?.content ?? "{}"
  let parsed: unknown
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : "{}")
  } catch {
    logger.warn("[llm-rerank] invalid_json", {
      previewLen: typeof raw === "string" ? raw.length : 0,
    })
    parsed = { ranked: [] }
  }

  const ranked = sanitizeRanked(parsed, input.jobs)

  // Cost-ledger emit (best effort — failure must not block return).
  try {
    const usage = res.usage
    logTokenSpend({
      kind: "chat",
      service: "siliconflow",
      model: RERANK_MODEL,
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
      labels: deps.costLabels,
    })
  } catch {
    /* fail-open: cost-ledger never blocks production path */
  }

  return {
    ranked,
    modelUsed: RERANK_MODEL,
    latencyMs: now() - t0,
  }
}

/**
 * Take the parsed LLM JSON and produce a clean RerankRow[] honoring the
 * documented invariants:
 *   - drop entries whose jobId isn't in the input set (hallucination guard)
 *   - drop entries with non-string jobId
 *   - clamp score to [0, 1]; default 0.5 when missing/non-numeric
 *   - truncate reasoning to ≤200 chars; coerce non-string to ""
 *   - sort by emitted `rank` asc (NaN goes last via Number-coerce + ?? Infinity)
 *   - re-sequence rank to 1..N so duplicates / gaps disappear
 *   - de-duplicate jobIds (keep first by sorted order)
 */
function sanitizeRanked(parsed: unknown, jobs: RerankInput["jobs"]): RerankRow[] {
  const known = new Set(jobs.map((j) => j.id))
  const ranked: unknown =
    parsed && typeof parsed === "object" && "ranked" in (parsed as Record<string, unknown>)
      ? (parsed as { ranked: unknown }).ranked
      : []
  if (!Array.isArray(ranked)) return []

  type Tagged = {
    jobId: string
    rank: number
    score: number
    reasoning: string
  }
  const cleaned: Tagged[] = []
  const seen = new Set<string>()
  for (const r of ranked) {
    if (!r || typeof r !== "object") continue
    const row = r as Record<string, unknown>
    const jobIdRaw = row.jobId
    if (typeof jobIdRaw !== "string" || !known.has(jobIdRaw)) continue
    if (seen.has(jobIdRaw)) continue
    seen.add(jobIdRaw)

    const rankRaw = Number(row.rank)
    const rankSort = Number.isFinite(rankRaw) ? rankRaw : Number.POSITIVE_INFINITY

    let score = 0.5
    if (typeof row.score === "number" && Number.isFinite(row.score)) {
      score = Math.max(0, Math.min(1, row.score))
    } else if (typeof row.score === "string") {
      const n = Number(row.score)
      if (Number.isFinite(n)) score = Math.max(0, Math.min(1, n))
    }

    let reasoning = ""
    if (typeof row.reasoning === "string") {
      reasoning = row.reasoning.length > REASONING_MAX_LEN
        ? row.reasoning.slice(0, REASONING_MAX_LEN)
        : row.reasoning
    }

    cleaned.push({ jobId: jobIdRaw, rank: rankSort, score, reasoning })
  }

  // Stable sort by emitted rank ascending (NaN/missing → last).
  cleaned.sort((a, b) => a.rank - b.rank)

  // Re-sequence to 1..N regardless of what came in.
  return cleaned.map((row, idx) => ({
    jobId: row.jobId,
    rank: idx + 1,
    score: row.score,
    reasoning: row.reasoning,
  }))
}
