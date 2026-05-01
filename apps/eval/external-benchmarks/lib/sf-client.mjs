/**
 * Phase 39 — Thin SiliconFlow OpenAI-compat client.
 *
 * Single source for all 3 adapters (qwen-7b / qwen-72b / claire-stack).
 * Reads env var chain identical to Phase 33/35 helpers:
 *   SILICONFLOW_API_KEY → PA_OPENAI_AGENT_API_KEY → PA_SILICONFLOW_API_KEY
 *
 * No retries, no caching — bench harness wants raw single-call semantics.
 * Network errors bubble up so cost-ledger does NOT charge for failed calls.
 *
 * @typedef {Object} ChatMessage
 * @property {"system"|"user"|"assistant"} role
 * @property {string} content
 *
 * @typedef {Object} ChatOpts
 * @property {string} [model]
 * @property {number} [temperature]
 * @property {number} [max_tokens]
 * @property {number} [top_p]
 * @property {string} [base_url]
 * @property {string} [api_key]
 * @property {typeof fetch} [fetchImpl]
 *
 * @typedef {Object} ChatResult
 * @property {string} text
 * @property {{ inputTokens: number, outputTokens: number }} usage
 * @property {string} model
 *
 * @typedef {Object} EmbedOpts
 * @property {string} [model]
 * @property {string} [base_url]
 * @property {string} [api_key]
 * @property {typeof fetch} [fetchImpl]
 *
 * @typedef {Object} EmbedResult
 * @property {number[][]} embeddings
 * @property {{ inputTokens: number }} usage
 */

const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1"

/**
 * Resolve API key from env var chain.
 * @param {string} [override] - explicit key from caller (highest priority)
 * @returns {string|null}
 */
export function resolveApiKey(override) {
  if (override && typeof override === "string") return override
  return (
    process.env.SILICONFLOW_API_KEY ||
    process.env.PA_OPENAI_AGENT_API_KEY ||
    process.env.PA_SILICONFLOW_API_KEY ||
    null
  )
}

/**
 * Resolve base URL.
 * @param {string} [override]
 * @returns {string}
 */
export function resolveBaseUrl(override) {
  return override || process.env.SILICONFLOW_BASE_URL || DEFAULT_BASE_URL
}

/**
 * SiliconFlow chat completion. Throws on missing key or HTTP error.
 *
 * @param {{ messages: ChatMessage[], opts?: ChatOpts }} args
 * @returns {Promise<ChatResult>}
 */
export async function chatCompletion({ messages, opts = {} }) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("sf-client/chat: messages required")
  }
  const apiKey = resolveApiKey(opts.api_key)
  if (!apiKey) {
    throw new Error(
      "sf-client/chat: no API key. Set SILICONFLOW_API_KEY (or PA_OPENAI_AGENT_API_KEY / PA_SILICONFLOW_API_KEY)."
    )
  }
  const baseUrl = resolveBaseUrl(opts.base_url)
  const model = opts.model || "Qwen/Qwen2.5-7B-Instruct"
  const fetchImpl = opts.fetchImpl || globalThis.fetch

  const body = {
    model,
    messages,
  }
  if (typeof opts.temperature === "number") body.temperature = opts.temperature
  if (typeof opts.max_tokens === "number") body.max_tokens = opts.max_tokens
  if (typeof opts.top_p === "number") body.top_p = opts.top_p

  // Per-call hard timeout — bench loops are sequential, so one hung
  // fetch stalls the whole 1000-conv run.
  //
  // History: Phase 39 hung 1h58m on a single ESTABLISHED TCP connection to
  // 47.239.184.63 with 0:08 CPU. First fix added AbortController.signal but
  // this still hung 1h on a fresh run — undici fetch in node 24 has a known
  // limitation where AbortSignal does NOT always abort sockets stuck in
  // TLS handshake or HTTP/2 flow control. The reliable fix is an OUTER
  // Promise.race that forces resolution regardless of socket state.
  // 90s covers normal 7B-chat latency p99 with headroom.
  const timeoutMs = Number(opts.timeoutMs ?? process.env.PA_BENCH_FETCH_TIMEOUT_MS ?? 90_000)
  const ctrl = new AbortController()

  /** @returns {Promise<never>} */
  const deadline = () => new Promise((_, rej) => setTimeout(() => {
    try { ctrl.abort() } catch {}
    rej(new Error(`sf-client/chat: timeout after ${timeoutMs}ms (outer race)`))
  }, timeoutMs))

  /** @returns {Promise<{text:string, usage:object, model:string}>} */
  const work = (async () => {
    let res
    try {
      res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error(`sf-client/chat: timeout after ${timeoutMs}ms (signal)`)
      }
      throw err
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "")
      throw new Error(`sf-client/chat: HTTP ${res.status}: ${errText.slice(0, 200)}`)
    }

    const json = await res.json()
    return { __json: json }
  })()

  const result = await Promise.race([work, deadline()])
  const json = result.__json
  const text = json?.choices?.[0]?.message?.content ?? ""
  const usage = json?.usage ?? {}
  return {
    text: typeof text === "string" ? text : "",
    usage: {
      inputTokens: Number(usage.prompt_tokens ?? 0),
      outputTokens: Number(usage.completion_tokens ?? 0),
    },
    model,
  }
}

/**
 * SiliconFlow embeddings. Throws on missing key or HTTP error.
 *
 * @param {{ input: string|string[], opts?: EmbedOpts }} args
 * @returns {Promise<EmbedResult>}
 */
export async function embed({ input, opts = {} }) {
  const inputs = Array.isArray(input) ? input : [input]
  if (inputs.length === 0) throw new Error("sf-client/embed: input required")
  const apiKey = resolveApiKey(opts.api_key)
  if (!apiKey) throw new Error("sf-client/embed: no API key")
  const baseUrl = resolveBaseUrl(opts.base_url)
  const model = opts.model || "BAAI/bge-m3"
  const fetchImpl = opts.fetchImpl || globalThis.fetch

  const embedTimeoutMs = Number(opts.timeoutMs ?? process.env.PA_BENCH_FETCH_TIMEOUT_MS ?? 60_000)
  const embedCtrl = new AbortController()
  const embedTimer = setTimeout(() => embedCtrl.abort(), embedTimeoutMs)
  const res = await fetchImpl(`${baseUrl}/embeddings`, {
    method: "POST",
    signal: embedCtrl.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: inputs }),
  }).catch((err) => {
    clearTimeout(embedTimer)
    if (err && err.name === "AbortError") {
      throw new Error(`sf-client/embed: timeout after ${embedTimeoutMs}ms`)
    }
    throw err
  })
  clearTimeout(embedTimer)

  if (!res.ok) {
    const errText = await res.text().catch(() => "")
    throw new Error(`sf-client/embed: HTTP ${res.status}: ${errText.slice(0, 200)}`)
  }
  const json = await res.json()
  const embeddings = (json?.data || []).map((d) => d.embedding)
  const usage = json?.usage ?? {}
  return {
    embeddings,
    usage: { inputTokens: Number(usage.prompt_tokens ?? 0) },
  }
}
