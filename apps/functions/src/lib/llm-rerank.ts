/**
 * iter34 followup G.4 / D.15 — async LLM rerank module.
 *
 * Adam directive 2026-05-05: a cheap LLM is fine here — SiliconFlow's free 7B
 * model can run async batches in the background with no problem.
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
  /** ≤200 chars one-sentence "why this rank" reason. */
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
        response_format?:
          | { type: "json_object" }
          | { type: "json_schema"; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } }
        temperature?: number
        max_tokens?: number
        max_completion_tokens?: number
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
  /** Transient-failure retry pause override (tests pass 0). */
  retryPauseMs?: number
}

const RERANK_MODEL = "Qwen/Qwen2.5-7B-Instruct"
const RERANK_TEMPERATURE = 0.2
// 3000 (was 1500): observed live 2026-06-09 — Qwen ignores the ≤90-char
// reasoning instruction often enough that 10-job responses overflowed 1500
// and truncated mid-JSON. Headroom is cheap; truncation zeroes the cache.
const RERANK_MAX_TOKENS = 3000
const REASONING_MAX_LEN = 200

/**
 * 2026-06-09 provider switch — OpenAI gpt-5.4-nano PRIMARY, Qwen FALLBACK.
 *
 * Live evidence (probe-qwen-raw, 2026-06-09): Qwen2.5-7B on SiliconFlow emits
 * structurally broken JSON for this contract in the majority of calls —
 * `{"" :3,"rank":"3"` malformed keys, string scores, degenerate repetition
 * until finish_reason=length — BOTH with and without
 * response_format=json_object. That made `ranked` empty for most users and
 * zeroed the 0.40-weight llmMatch component fleet-wide (matching ran blind).
 * gpt-5.4-nano with response_format=json_schema STRICT makes malformed output
 * impossible at the API layer, at ~$0.5/night for the full nightly batch.
 * Qwen stays as the no-OpenAI-key fallback. NOTE: deviates from the D9
 * "Qwen-7B nightly" model choice — flagged to Adam 2026-06-09; the D9 intent
 * (cheap async rerank) is preserved.
 */
const RERANK_PRIMARY_MODEL = "gpt-5.4-nano"

const RERANK_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ranked"],
  properties: {
    ranked: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["i", "rank", "score", "reasoning"],
        properties: {
          i: { type: "integer" },
          rank: { type: "integer" },
          score: { type: "number" },
          reasoning: { type: "string" },
        },
      },
    },
  },
} as const

type ResolvedRerankProvider = {
  client: RerankChatClient
  model: string
  responseFormat:
    | { type: "json_object" }
    | { type: "json_schema"; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } }
  service: "openai" | "siliconflow"
}

/**
 * 2026-06-09 fleet-wide llmMatch=0 fix. The nightly batch feeds ~50-job pools
 * into a module budgeted for 5-10 jobs: 50 jobs × (64-char hash jobId ≈ 40
 * output tokens + reasoning) blows the 1500 max_tokens cap, the JSON
 * truncates mid-array, the parse fails, and `ranked` comes back EMPTY — which
 * the nightly then cached as a fresh result, zeroing the 0.40-weight llmMatch
 * component of every V16 match score. Fix: process jobs in chunks that fit
 * the output budget and merge by score (scores are absolute fit grades in
 * [0,1], so cross-chunk merge is sound). Chunks run sequentially on purpose —
 * SiliconFlow 429s under parallel bursts (observed in the 2026-06-09 run).
 */
export const RERANK_CHUNK_SIZE = 10
/** One retry per chunk after a transient failure (429/5xx), fixed pause. */
const RERANK_RETRY_PAUSE_MS = 4000

function chunkJobs<T>(jobs: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < jobs.length; i += size) out.push(jobs.slice(i, i + size))
  return out
}

/**
 * Salvage individual `{...}` row objects out of malformed/truncated LLM
 * output. Each candidate fragment must JSON.parse on its own and look like a
 * rerank row (an `i` or `jobId` key plus a `score`) to be kept — anything
 * else is dropped. This is transport-level JSON repair, not text
 * classification: the row contents still go through mapIndexKeysToJobIds +
 * sanitizeRanked exactly like a clean response.
 */
function salvageRankedRows(raw: string): { ranked: unknown[] } {
  const ranked: unknown[] = []
  for (const fragment of raw.match(/\{[^{}]*\}/g) ?? []) {
    try {
      const obj = JSON.parse(fragment) as Record<string, unknown>
      if (!obj || typeof obj !== "object") continue
      const hasKey = typeof obj.jobId === "string" || Number.isFinite(Number(obj.i))
      const hasScore = obj.score !== undefined
      if (hasKey && hasScore) ranked.push(obj)
    } catch {
      /* incomplete fragment (e.g. the truncation point) — skip */
    }
  }
  return { ranked }
}

/**
 * Map the model's compact `i` keys (1-based chunk index) back to real jobIds.
 * Rows that already carry a `jobId` pass through untouched (back-compat with
 * the original schema; sanitizeRanked still drops anything unknown).
 */
function mapIndexKeysToJobIds(parsed: unknown, chunk: RerankInput["jobs"]): unknown {
  if (!parsed || typeof parsed !== "object") return parsed
  const ranked = (parsed as { ranked?: unknown }).ranked
  if (!Array.isArray(ranked)) return parsed
  return {
    ranked: ranked.map((r) => {
      if (!r || typeof r !== "object") return r
      const row = r as Record<string, unknown>
      if (typeof row.jobId === "string") return row
      const i = Number(row.i)
      const job = Number.isInteger(i) && i >= 1 && i <= chunk.length ? chunk[i - 1] : undefined
      return job ? { ...row, jobId: job.id } : row
    }),
  }
}

/**
 * Build the static system prompt with a mandatory JSON contract — Qwen2.5-7B
 * with `response_format=json_object` obeys the schema reliably when the example
 * is in-prompt.
 */
function buildSystemPrompt(): string {
  // Jobs are keyed by a small integer `i` (1..N), NOT by their raw jobId:
  // production jobIds are 64-char hex hashes that tokenize at ~1 token/char,
  // so echoing 10 of them burned ~600 output tokens and pushed the response
  // past max_tokens (the 2026-06-09 truncated-JSON incident). The caller maps
  // `i` back to the real jobId.
  return [
    "You are a job match assistant. The input is a candidate and N jobs; each job has an integer key `i`.",
    "Task: assign each job a rank (1 = best match, N = worst), a 0..1 score,",
    "and a one-sentence reasoning explaining why this rank (short and direct).",
    "",
    "Output STRICT JSON, schema:",
    '{"ranked":[{"i":<job key int>,"rank":<int 1..N>,"score":<float 0..1>,"reasoning":"<one short sentence>"}, ...]}',
    "",
    "Rules:",
    "- Every input job MUST appear in ranked exactly once, identified by its `i` key.",
    "- Ranks 1..N cannot repeat; 1 is the best match.",
    "- Higher score = better match, in the closed interval [0,1].",
    "- reasoning <= 90 chars, one sentence, no lists or bullets.",
    "- Output no prose, no markdown, no commentary — only JSON.",
  ].join("\n")
}

/**
 * Default lazy client factory. Reads `SILICONFLOW_API_KEY` from process.env at
 * call time so Cloud Functions secret-binding works (firebase-functions v2
 * surfaces secrets as env vars). Returns null when no key is present — the
 * caller emits a warn and returns an empty ranked array.
 */
async function defaultRerankProvider(): Promise<ResolvedRerankProvider | null> {
  const providers = await import("./llm-providers.js")
  const { default: OpenAI } = (await import("openai")) as unknown as {
    default: new (init: { apiKey: string; baseURL?: string }) => RerankChatClient
  }
  // PRIMARY: OpenAI gpt-5.4-nano with STRICT json_schema (see provider-switch
  // note above — Qwen could not hold the JSON contract).
  const openai = providers.getOpenAIConfig()
  if (openai.apiKey) {
    return {
      client: new OpenAI({ apiKey: openai.apiKey, baseURL: openai.baseURL }),
      model: RERANK_PRIMARY_MODEL,
      responseFormat: {
        type: "json_schema",
        json_schema: { name: "rerank", strict: true, schema: RERANK_JSON_SCHEMA as unknown as Record<string, unknown> },
      },
      service: "openai",
    }
  }
  // FALLBACK: SiliconFlow Qwen-7B (the pre-2026-06-09 primary).
  const sf = providers.getSiliconFlowConfig()
  if (!sf.apiKey) return null
  return {
    client: new OpenAI({ apiKey: sf.apiKey, baseURL: sf.baseURL }),
    model: RERANK_MODEL,
    responseFormat: { type: "json_object" },
    service: "siliconflow",
  }
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

  let provider: ResolvedRerankProvider | null
  try {
    // Injected client (tests) keeps the legacy Qwen shape so fakes stay stable.
    provider = deps.client
      ? {
          client: deps.client,
          model: RERANK_MODEL,
          responseFormat: { type: "json_object" },
          service: "siliconflow",
        }
      : await defaultRerankProvider()
  } catch (err) {
    logger.warn("[llm-rerank] client_init_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return { ranked: [], modelUsed: RERANK_MODEL, latencyMs: now() - t0 }
  }
  if (!provider) {
    logger.warn("[llm-rerank] no_api_key")
    return { ranked: [], modelUsed: RERANK_MODEL, latencyMs: now() - t0 }
  }

  const systemPrompt = buildSystemPrompt()
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  // One chunk → one model call (with a single transient-failure retry).
  // Returns the sanitized rows for THAT chunk; [] on persistent failure so
  // one bad chunk degrades the pool instead of zeroing the whole user.
  const runChunk = async (
    chunk: RerankInput["jobs"],
  ): Promise<RerankRow[]> => {
    // Send compact integer keys instead of 64-char hash ids (see
    // buildSystemPrompt for why); map back after parse.
    const compactJobs = chunk.map(({ id: _id, ...rest }, idx) => ({ i: idx + 1, ...rest }))
    const userPrompt = JSON.stringify({ candidate: input.candidate, jobs: compactJobs })
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Awaited<ReturnType<RerankChatClient["chat"]["completions"]["create"]>>
      try {
        res = await provider!.client.chat.completions.create({
          model: provider!.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: provider!.responseFormat,
          // gpt-5.4-nano rejects `max_tokens` (wants max_completion_tokens)
          // and only supports default temperature; Qwen path unchanged.
          ...(provider!.service === "openai"
            ? { max_completion_tokens: RERANK_MAX_TOKENS }
            : { temperature: RERANK_TEMPERATURE, max_tokens: RERANK_MAX_TOKENS }),
        })
      } catch (err) {
        logger.warn("[llm-rerank] api_call_failed", {
          error: err instanceof Error ? err.message : String(err),
          jobCount: chunk.length,
          attempt,
        })
        if (attempt === 0) {
          await sleep(deps.retryPauseMs ?? RERANK_RETRY_PAUSE_MS)
          continue
        }
        return []
      }

      const raw = res.choices?.[0]?.message?.content ?? "{}"
      let parsed: unknown
      try {
        parsed = JSON.parse(typeof raw === "string" ? raw : "{}")
      } catch {
        // Salvage pass — Qwen-7B routinely emits malformed or truncated JSON
        // even under response_format=json_object (observed live 2026-06-09).
        // The complete row objects inside the broken array are still good;
        // extract them individually instead of zeroing the whole chunk.
        parsed = salvageRankedRows(typeof raw === "string" ? raw : "")
        const salvagedCount = Array.isArray((parsed as { ranked?: unknown[] }).ranked)
          ? (parsed as { ranked: unknown[] }).ranked.length
          : 0
        logger.warn("[llm-rerank] invalid_json_salvaged", {
          previewLen: typeof raw === "string" ? raw.length : 0,
          jobCount: chunk.length,
          salvagedCount,
        })
      }

      // Cost-ledger emit (best effort — failure must not block return).
      try {
        const usage = res.usage
        logTokenSpend({
          kind: "chat",
          service: provider!.service,
          model: provider!.model,
          inputTokens: usage?.prompt_tokens,
          outputTokens: usage?.completion_tokens,
          labels: deps.costLabels,
        })
      } catch {
        /* fail-open: cost-ledger never blocks production path */
      }

      return sanitizeRanked(mapIndexKeysToJobIds(parsed, chunk), chunk)
    }
    return []
  }

  // Sequential chunks (SiliconFlow 429s under parallel bursts). A single
  // chunk keeps the model's emitted-rank order exactly as before; multiple
  // chunks merge by score desc — scores are absolute [0,1] fit grades,
  // comparable across chunks — then re-sequence 1..N.
  const chunks = chunkJobs(input.jobs, RERANK_CHUNK_SIZE)
  const merged: RerankRow[] = []
  for (const chunk of chunks) {
    merged.push(...(await runChunk(chunk)))
  }
  if (chunks.length > 1) merged.sort((a, b) => b.score - a.score)
  const ranked = merged.map((row, idx) => ({ ...row, rank: idx + 1 }))

  return {
    ranked,
    modelUsed: provider.model,
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
