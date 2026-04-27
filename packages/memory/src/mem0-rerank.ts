/**
 * Memory-opt P0-3 — small-LLM rerank step over Mem0 search results.
 *
 * Mem0 returns top-K (K=8) by raw cosine similarity. The reranker calls
 * a small chat-completions model once per turn to re-order those K
 * candidates by relevance to the user's CURRENT message, then trims to
 * top-3 before they hit the persona-card recall channel.
 *
 * Hard rules:
 *  - Pure function over an injectable LLM dep. Real LLM call is only
 *    invoked through `defaultLlmRerank` (which the orchestrator wires
 *    by env). Tests pass a stub.
 *  - FAIL-OPEN: on missing config, parse failure, timeout, or any
 *    error, return the input order unchanged. NEVER throws to the
 *    caller. Memory recall must continue even when the rerank LLM is
 *    down (degrade to top-K cosine ordering).
 *  - Bounded cost: hard-cap input lines, hard-cap per-line chars,
 *    hard-cap total prompt length. Output tokens capped at 64
 *    (~ "[3,1,2,4,5]" + slack).
 *  - Bounded latency: per-call timeout via AbortController.
 *  - Idempotent: same (query, candidates) → same shape; ordering may
 *    differ across calls (LLM nondeterminism).
 */

const MAX_CANDIDATES = 10
const MAX_LINE_CHARS = 240
const TOP_AFTER_RERANK = 3
const DEFAULT_TIMEOUT_MS = 1500

export type RerankDep = (
  query: string,
  candidates: string[],
  signal: AbortSignal
) => Promise<number[] | null>

export type RerankOptions = {
  /** Override the LLM call. When omitted, uses `defaultLlmRerank`. */
  rerank?: RerankDep
  /** Per-call timeout in ms. Default 1500. */
  timeoutMs?: number
  /** Override the env-flag check. Test hook. */
  disabled?: boolean
}

function rerankIsDisabled(): boolean {
  const raw = process.env.PA_MEM0_RERANK_DISABLED
  if (typeof raw !== "string") return false
  const v = raw.trim().toLowerCase()
  return v === "true" || v === "1" || v === "on"
}

/** Trim and clip every candidate so the prompt is bounded. */
function prepareCandidates(lines: string[]): string[] {
  return lines.slice(0, MAX_CANDIDATES).map((l) => {
    const t = (l ?? "").trim()
    if (t.length <= MAX_LINE_CHARS) return t
    return t.slice(0, MAX_LINE_CHARS) + "…"
  })
}

/**
 * Validate and project the LLM-returned ordering onto the candidate
 * indices. Drops out-of-range / duplicate / non-integer entries; appends
 * any unreferenced candidates at the tail (so we never silently lose
 * data even if the model returns a partial array).
 */
function applyOrdering(lines: string[], order: number[] | null | undefined): string[] {
  if (!Array.isArray(order)) return lines
  const seen = new Set<number>()
  const out: string[] = []
  for (const raw of order) {
    if (!Number.isInteger(raw)) continue
    const idx = raw
    if (idx < 0 || idx >= lines.length) continue
    if (seen.has(idx)) continue
    seen.add(idx)
    out.push(lines[idx]!)
  }
  // Append untouched lines in original order so we never lose data.
  for (let i = 0; i < lines.length; i++) {
    if (seen.has(i)) continue
    out.push(lines[i]!)
  }
  return out
}

/**
 * Rerank `lines` (Mem0 search results) against `query` and return the
 * top-3 in re-ranked order. NEVER throws; on any failure returns the
 * first 3 lines of the original input (no-op rerank).
 */
export async function rerankAndTrim(
  query: string,
  lines: string[],
  opts: RerankOptions = {}
): Promise<string[]> {
  if (!Array.isArray(lines) || lines.length === 0) return []
  // No work needed if we already have ≤ TOP_AFTER_RERANK candidates.
  if (lines.length <= TOP_AFTER_RERANK) return [...lines]
  const disabled = opts.disabled !== undefined ? opts.disabled : rerankIsDisabled()
  if (disabled) return lines.slice(0, TOP_AFTER_RERANK)

  const candidates = prepareCandidates(lines)
  const rerank = opts.rerank ?? defaultLlmRerank
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let order: number[] | null = null
  try {
    order = await rerank(query, candidates, controller.signal)
  } catch {
    order = null
  } finally {
    clearTimeout(timer)
  }
  const reordered = applyOrdering(candidates, order)
  return reordered.slice(0, TOP_AFTER_RERANK)
}

/**
 * Default LLM rerank — calls the OpenAI-compatible chat-completions
 * endpoint already configured for the rest of the stack. Returns `null`
 * when env is missing or the response can't be parsed.
 *
 * Cost target: ~200 input tokens + 32 output tokens per turn. With
 * SiliconFlow Qwen2.5-7B-Instruct (rough proxy for "nano"), that's
 * ~$0.0001-0.0003 per turn at SiliconFlow rates.
 */
export async function defaultLlmRerank(
  query: string,
  candidates: string[],
  signal: AbortSignal
): Promise<number[] | null> {
  const apiKey =
    process.env.SILICONFLOW_API_KEY?.trim() ||
    process.env.MEM0_LLM_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) return null
  const baseUrl = (
    process.env.PA_RERANK_BASE_URL?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    "https://api.siliconflow.cn/v1"
  ).replace(/\/+$/, "")
  // Nano model — overridable via env. Default to a small SiliconFlow
  // chat model. Safe to point at gpt-5.4-nano or any other small model
  // when running outside SiliconFlow.
  const model =
    process.env.PA_RERANK_MODEL?.trim() ||
    process.env.MEM0_LLM_MODEL?.trim() ||
    "Qwen/Qwen2.5-7B-Instruct"

  const numbered = candidates.map((c, i) => `${i}: ${c}`).join("\n")
  const sys =
    "You re-rank short memory snippets by relevance to the user's current message. " +
    "Output ONLY a JSON array of integer indices (most relevant first), e.g. [3,1,0]. " +
    "Do not include indices that are clearly off-topic. No explanation."
  const user = `User message:\n${query}\n\nCandidates:\n${numbered}\n\nReturn JSON array only.`

  let resp: Response
  try {
    resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 64,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      }),
    })
  } catch {
    return null
  }
  if (!resp.ok) return null
  let json: unknown
  try {
    json = await resp.json()
  } catch {
    return null
  }
  const text = (json as {
    choices?: Array<{ message?: { content?: string } }>
  })?.choices?.[0]?.message?.content?.trim()
  if (!text) return null
  // Tolerate code fences or surrounding text — extract first [...] block.
  const match = text.match(/\[[^\]]*\]/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0])
    if (!Array.isArray(parsed)) return null
    return parsed.filter((n): n is number => Number.isInteger(n))
  } catch {
    return null
  }
}

/** Test-only constants exposed for assertions. */
export const _TEST_CAPS = {
  MAX_CANDIDATES,
  MAX_LINE_CHARS,
  TOP_AFTER_RERANK,
  DEFAULT_TIMEOUT_MS,
}
