/**
 * Phase 33 — BGE-M3 sentence-embedding wrapper (HARNESS-04).
 *
 * Direct SiliconFlow embeddings POST. We do NOT instantiate the Mem0 OSS
 * client because it pulls in the Qdrant adapter + history manager that are
 * pointless for harness use. We DO reuse the same model id (`BAAI/bge-m3`)
 * and base URL (`https://api.siliconflow.cn/v1`) that production memory
 * uses (D14), so embeddings are directly comparable to the runtime
 * memory layer.
 *
 * Used by:
 *   - `advice_novelty` axis (cos-sim of current Claire reply vs last 3)
 *   - `drift_resistance` deterministic helper (advice-repeat half)
 *   - Phase 35 F4 advice-repeat detector (production)
 *
 * Cost: BGE-M3 is on SiliconFlow's free embedding tier — confirmed via
 * mem0.ts comments + D14. Worst-case per scenario ≈ 16 calls; with
 * `embedBatch` it's 1 HTTP call returning an array. **0 net new cost.**
 *
 * Failure mode: if no API key is configured, `embed`/`embedBatch` return
 * `null` (NOT throw) so the runner can record the axis as
 * `skipped: missing api key` rather than crashing the whole eval pass.
 */

const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1"
const DEFAULT_MODEL = "BAAI/bge-m3"
const DEFAULT_DIMS = 1024
const CACHE_LIMIT = 200

// LRU cache: text → Float32Array. We keep insertion order via Map +
// re-insert on hit to refresh recency.
const _cache = new Map()

// HTTP override hook for tests.
let _fetchImpl = null
export function _setFetchImpl(fn) { _fetchImpl = fn }

export function _resetCache() {
  _cache.clear()
}

function getApiKey() {
  const k =
    process.env.SILICONFLOW_API_KEY?.trim() ||
    process.env.PA_OPENAI_AGENT_API_KEY?.trim() ||
    process.env.PA_SILICONFLOW_API_KEY?.trim() ||
    ""
  return k.length > 0 ? k : null
}

function getBaseUrl() {
  return (
    process.env.SILICONFLOW_BASE_URL?.trim() ||
    process.env.PA_OPENAI_AGENT_BASE_URL?.trim() ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "")
}

function lruGet(key) {
  if (!_cache.has(key)) return null
  const v = _cache.get(key)
  // refresh recency
  _cache.delete(key)
  _cache.set(key, v)
  return v
}

function lruSet(key, value) {
  if (_cache.has(key)) _cache.delete(key)
  _cache.set(key, value)
  while (_cache.size > CACHE_LIMIT) {
    const firstKey = _cache.keys().next().value
    _cache.delete(firstKey)
  }
}

async function postEmbeddings(input) {
  const apiKey = getApiKey()
  if (!apiKey) return null
  const fetchFn = _fetchImpl || globalThis.fetch
  if (typeof fetchFn !== "function") {
    throw new Error("embed-sim: fetch is not available in this runtime")
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
    throw new Error(`embed-sim: SiliconFlow ${resp.status} ${resp.statusText} — ${text.slice(0, 200)}`)
  }
  const json = await resp.json()
  if (!Array.isArray(json.data)) {
    throw new Error(`embed-sim: malformed response (no .data array)`)
  }
  return json.data
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => Float32Array.from(d.embedding ?? []))
}

/**
 * Embed a single text. Returns `null` if no API key is configured (so the
 * caller can degrade gracefully).
 *
 * @param {string} text
 * @returns {Promise<Float32Array|null>}
 */
export async function embed(text) {
  if (typeof text !== "string" || text.length === 0) {
    return Float32Array.from(new Array(DEFAULT_DIMS).fill(0))
  }
  const cached = lruGet(text)
  if (cached) return cached
  const apiKey = getApiKey()
  if (!apiKey) return null
  const arr = await postEmbeddings([text])
  if (!arr || arr.length === 0) return null
  lruSet(text, arr[0])
  return arr[0]
}

/**
 * Embed a batch in one HTTP call. Cache-aware: only un-cached texts are
 * sent to the network; results are merged back in input order.
 *
 * @param {string[]} texts
 * @returns {Promise<(Float32Array|null)[]|null>}  Per-input embeddings, or
 *   null when API key missing for ALL inputs (callers branch on that).
 */
export async function embedBatch(texts) {
  if (!Array.isArray(texts)) return null
  if (texts.length === 0) return []
  const out = new Array(texts.length).fill(null)
  const missingIdx = []
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
    const v = arr[k] ?? null
    if (v) {
      lruSet(texts[idx], v)
      out[idx] = v
    }
  }
  return out
}

/**
 * Cosine similarity ∈ [-1, 1]. Zero-vector input → 0 (avoids NaN).
 * @param {Float32Array|number[]} a
 * @param {Float32Array|number[]} b
 * @returns {number}
 */
export function cosineSim(a, b) {
  if (!a || !b) return 0
  const len = Math.min(a.length, b.length)
  if (len === 0) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < len; i++) {
    const av = a[i], bv = b[i]
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Convenience: embed two texts and return cos-sim. Returns `null` if
 * either embed call returns null (env missing).
 * @returns {Promise<number|null>}
 */
export async function similarity(textA, textB) {
  const pair = await embedBatch([textA, textB])
  if (!pair || !pair[0] || !pair[1]) return null
  return cosineSim(pair[0], pair[1])
}

/**
 * Compute max similarity of `reply` against an array of historical
 * Claire replies. Returns:
 *   - { maxSim, mostSimilarIdx, sims } when embeddings worked
 *   - null when API key missing
 *
 * @param {string} reply
 * @param {string[]} history  - last N Claire turns, oldest first
 * @returns {Promise<{ maxSim: number, mostSimilarIdx: number, sims: number[] }|null>}
 */
export async function maxSimilarityVsHistory(reply, history) {
  if (typeof reply !== "string" || reply.length === 0) return null
  if (!Array.isArray(history) || history.length === 0) {
    return { maxSim: 0, mostSimilarIdx: -1, sims: [] }
  }
  const all = await embedBatch([reply, ...history])
  if (!all || !all[0]) return null
  const replyVec = all[0]
  const sims = []
  let maxSim = -1
  let mostSimilarIdx = -1
  for (let i = 0; i < history.length; i++) {
    const v = all[i + 1]
    const s = v ? cosineSim(replyVec, v) : 0
    sims.push(s)
    if (s > maxSim) {
      maxSim = s
      mostSimilarIdx = i
    }
  }
  return { maxSim: Math.max(0, maxSim), mostSimilarIdx, sims }
}
