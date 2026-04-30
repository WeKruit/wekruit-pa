/**
 * Phase 35 — F4 advice-repeat detector.
 *
 * Computes BGE-M3 cosine similarity of the current Claire reply vs the
 * last N (default 3) Claire turns in this session. Triggers when
 * `maxSim >= 0.85` (matches v1.4 metric #5 + Phase 38 contract).
 *
 * Action: `reject_resample` — wire-in caller re-calls rewriter with
 * a diversity nudge listing the prior-advice turns to avoid repeating.
 * 1 retry max; fail-open on 2nd attempt.
 *
 * **Graceful degrade** (CONTEXT §2):
 * - Missing API key → returns `{ triggered: false, score: null,
 *   reason: "skipped: no embed api key" }` — NEVER throws.
 * - Network error / non-200 → returns `{ ..., reason: "skipped:
 *   embed network error: <msg>" }` — NEVER throws.
 * - Empty history → returns `{ ..., reason: "no_history", score: 0 }`.
 * - Empty current reply → returns `{ ..., reason: "no_input", score: 0 }`.
 *
 * Algorithm parity: matches `tests/scenarios/lib/embed-sim.mjs`:
 * - Same model id (`BAAI/bge-m3`)
 * - Same env var resolution chain
 *   (`SILICONFLOW_API_KEY` → `PA_OPENAI_AGENT_API_KEY` → `PA_SILICONFLOW_API_KEY`)
 * - Same base URL (`https://api.siliconflow.cn/v1`)
 * - Same LRU cache semantics (cap 200, oldest evicted on miss)
 *
 * Latency: < 200ms p99 per call (BGE-M3 free tier on SiliconFlow + LRU
 * cache hit on warm path). Smoke harness asserts the budget.
 */
import type { DetectorContext, DetectorResult } from "./types.js"

const DEFAULT_THRESHOLD = 0.85
const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1"
const DEFAULT_MODEL = "BAAI/bge-m3"
const DEFAULT_DIMS = 1024
const CACHE_LIMIT = 200

// LRU cache. Map preserves insertion order; refresh recency on hit.
const _cache = new Map<string, Float32Array>()

// Test hook — override the fetch implementation.
let _fetchImpl: typeof fetch | null = null
export function _setFetchImpl(fn: typeof fetch | null): void {
  _fetchImpl = fn
}

export function _resetCache(): void {
  _cache.clear()
}

function readEnvThreshold(): number {
  const raw = process.env.PA_F4_REPEAT_THRESHOLD?.trim()
  if (!raw) return DEFAULT_THRESHOLD
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_THRESHOLD
  return n
}

function getApiKey(): string | null {
  const k =
    process.env.SILICONFLOW_API_KEY?.trim() ||
    process.env.PA_OPENAI_AGENT_API_KEY?.trim() ||
    process.env.PA_SILICONFLOW_API_KEY?.trim() ||
    ""
  return k.length > 0 ? k : null
}

function getBaseUrl(): string {
  const u =
    process.env.SILICONFLOW_BASE_URL?.trim() ||
    process.env.PA_OPENAI_AGENT_BASE_URL?.trim() ||
    DEFAULT_BASE_URL
  return u.replace(/\/+$/, "")
}

function lruGet(key: string): Float32Array | null {
  if (!_cache.has(key)) return null
  const v = _cache.get(key) as Float32Array
  _cache.delete(key)
  _cache.set(key, v)
  return v
}

function lruSet(key: string, value: Float32Array): void {
  if (_cache.has(key)) _cache.delete(key)
  _cache.set(key, value)
  while (_cache.size > CACHE_LIMIT) {
    const firstKey = _cache.keys().next().value
    if (firstKey === undefined) break
    _cache.delete(firstKey)
  }
}

/**
 * Cosine similarity ∈ [-1, 1]. Zero-vector input → 0.
 */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (!a || !b) return 0
  const len = Math.min(a.length, b.length)
  if (len === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < len; i++) {
    const av = a[i]
    const bv = b[i]
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>
}

/**
 * POST a batch of texts to SiliconFlow `/v1/embeddings`. Returns null
 * if API key missing. Throws on network / HTTP error (caller catches).
 */
async function postEmbeddings(input: string[]): Promise<Float32Array[] | null> {
  const apiKey = getApiKey()
  if (!apiKey) return null
  const fetchFn = _fetchImpl ?? globalThis.fetch
  if (typeof fetchFn !== "function") {
    throw new Error("f4-advice-repeat: fetch is not available in this runtime")
  }
  const url = `${getBaseUrl()}/embeddings`
  const body = {
    model: process.env.PA_EMBED_MODEL?.trim() || DEFAULT_MODEL,
    input,
  }
  const resp = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`SiliconFlow ${resp.status} ${resp.statusText} — ${text.slice(0, 200)}`)
  }
  const json = (await resp.json()) as EmbeddingResponse
  if (!Array.isArray(json.data)) {
    throw new Error("malformed response (no .data array)")
  }
  return json.data
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => Float32Array.from(d.embedding ?? []))
}

/**
 * Embed a batch with cache awareness. Returns null when API key absent
 * for ALL un-cached inputs (caller branches on null).
 */
async function embedBatch(texts: string[]): Promise<(Float32Array | null)[] | null> {
  if (texts.length === 0) return []
  const out: (Float32Array | null)[] = new Array(texts.length).fill(null)
  const missingIdx: number[] = []
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i]
    if (typeof t !== "string" || t.length === 0) {
      out[i] = Float32Array.from(new Array(DEFAULT_DIMS).fill(0))
      continue
    }
    const cached = lruGet(t)
    if (cached) out[i] = cached
    else missingIdx.push(i)
  }
  if (missingIdx.length === 0) return out
  const apiKey = getApiKey()
  if (!apiKey) return null
  const inputs = missingIdx.map((i) => texts[i])
  const arr = await postEmbeddings(inputs)
  if (!arr) return null
  for (let k = 0; k < missingIdx.length; k++) {
    const idx = missingIdx[k]
    const v = arr[k]
    if (v) {
      lruSet(texts[idx], v)
      out[idx] = v
    }
  }
  return out
}

/**
 * F4 detector entry point. Async, network-bound.
 *
 * Performs ONE embedBatch call covering [currentReply, ...history.slice(-3)].
 * Cache hits skip the network. Returns triggered=true when maxSim >= threshold.
 */
export async function detectAdviceRepeat(ctx: DetectorContext): Promise<DetectorResult> {
  const start = performance.now()
  const threshold = ctx.env?.f4RepeatThreshold ?? readEnvThreshold()
  const { assistant } = ctx.turn
  const history = (ctx.history?.claireReplies ?? []).filter(
    (t) => typeof t === "string" && t.length > 0
  )

  if (!assistant || assistant.length === 0) {
    return {
      id: "f4_advice_repeat",
      triggered: false,
      score: 0,
      reason: "no_input",
      suggested_action: null,
      latencyMs: performance.now() - start,
    }
  }

  if (history.length === 0) {
    return {
      id: "f4_advice_repeat",
      triggered: false,
      score: 0,
      reason: "no_history",
      suggested_action: null,
      latencyMs: performance.now() - start,
    }
  }

  // Sliding window — last 3 (oldest first preserved by callers).
  const window = history.slice(-3)

  let embeddings: (Float32Array | null)[] | null
  try {
    embeddings = await embedBatch([assistant, ...window])
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    // Log for diagnosis (CFs forward console.log).
    console.log("[f4-advice-repeat] network error", { msg })
    return {
      id: "f4_advice_repeat",
      triggered: false,
      score: null,
      reason: `skipped: embed network error: ${msg}`,
      suggested_action: null,
      latencyMs: performance.now() - start,
    }
  }

  // Missing key — graceful degrade.
  if (embeddings === null) {
    return {
      id: "f4_advice_repeat",
      triggered: false,
      score: null,
      reason: "skipped: no embed api key",
      suggested_action: null,
      latencyMs: performance.now() - start,
    }
  }

  const replyVec = embeddings[0]
  if (!replyVec) {
    return {
      id: "f4_advice_repeat",
      triggered: false,
      score: null,
      reason: "skipped: empty reply embedding",
      suggested_action: null,
      latencyMs: performance.now() - start,
    }
  }

  let maxSim = 0
  for (let i = 1; i < embeddings.length; i++) {
    const v = embeddings[i]
    if (!v) continue
    const s = cosineSim(replyVec, v)
    if (s > maxSim) maxSim = s
  }

  const triggered = maxSim >= threshold

  return {
    id: "f4_advice_repeat",
    triggered,
    score: maxSim,
    reason: triggered
      ? `cos_sim_${maxSim.toFixed(3)}_>=_${threshold.toFixed(3)}`
      : `cos_sim_${maxSim.toFixed(3)}_<_${threshold.toFixed(3)}`,
    suggested_action: triggered ? "reject_resample" : null,
    latencyMs: performance.now() - start,
  }
}
