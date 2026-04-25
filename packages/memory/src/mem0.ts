/**
 * Mem0 OSS SDK (mem0ai/oss) — add + search
 * LLM: SiliconFlow (OpenAI-compatible)
 * Embedder: SiliconFlow BAAI/bge-m3 (1024 dims)
 * VectorStore: Qdrant (self-hosted on Fly)
 *
 * Public API kept identical to the previous Mem0 Cloud HTTP shim so that
 * `stacked.ts` and `pa-orchestrator` need no source changes:
 *   - `mem0Search(config, query, userId): Promise<string[]>`
 *   - `mem0Add(config, messages, userId): Promise<void>`
 *
 * Config is sourced from process env at the call boundary in `stacked.ts`.
 * The `Mem0Config` shape is widened to carry the new OSS-specific fields,
 * but legacy `apiKey`/`baseUrl` props are still accepted (treated as a
 * generic OpenAI-compatible LLM key + base URL).
 */
import type { Memory as MemoryType } from "mem0ai/oss"
import { FetchQdrantClient } from "./qdrant-fetch.js"

export type Mem0Config = {
  /** OpenAI-compatible API key for the LLM + embedder (SiliconFlow). */
  apiKey: string
  /** OpenAI-compatible base URL. Defaults to SiliconFlow. */
  baseUrl?: string
  /** Chat model id used by Mem0 for fact extraction. */
  llmModel?: string
  /** Embedding model id; must match `embeddingDims`. */
  embedModel?: string
  /** Embedding dimensions; default 1024 (bge-m3). */
  embeddingDims?: number
  /** Qdrant base URL (https). */
  qdrantUrl: string
  /** Qdrant API key. */
  qdrantApiKey: string
  /** Qdrant collection name; defaults to `pa_memory`. */
  qdrantCollection?: string
}

const DEFAULT_LLM_BASE = "https://api.siliconflow.cn/v1"
const DEFAULT_LLM_MODEL = "Qwen/Qwen2.5-72B-Instruct"
const DEFAULT_EMBED_MODEL = "BAAI/bge-m3"
const DEFAULT_EMBED_DIMS = 1024
const DEFAULT_COLLECTION = "pa_memory"

/** Strip trailing slashes; treat blank as missing so callers never pass `""` into OpenAI clients. */
export function normalizeOpenAiCompatBaseUrl(url: string | undefined, fallback = DEFAULT_LLM_BASE): string {
  const raw = (url ?? "").trim()
  const u = raw.length > 0 ? raw : fallback
  return u.replace(/\/+$/, "")
}

/**
 * mem0ai's Qdrant adapter defaults `port` to **6333** whenever the URL has no
 * explicit port (`new URL(...).port === ""`). Fly.dev's edge only exposes 443,
 * so the 6333 connection times out / resets. Force an explicit `:443` (or
 * `:80`) into the URL string. WHATWG `URL.port` setter discards the value
 * when it equals the scheme default, so we splice the port in manually.
 */
export function normalizeQdrantUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "")
  try {
    const parsed = new URL(trimmed)
    if (parsed.port) return trimmed
    const explicitPort = parsed.protocol === "http:" ? "80" : "443"
    return `${parsed.protocol}//${parsed.hostname}:${explicitPort}${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`
      .replace(/\/+$/, "")
  } catch {
    return trimmed
  }
}

/** Empty env vars often become `""` which bypasses `??` defaults and breaks SiliconFlow. */
export function normalizeMem0RuntimeConfig(cfg: Mem0Config): Mem0Config {
  const baseUrl = normalizeOpenAiCompatBaseUrl(cfg.baseUrl, DEFAULT_LLM_BASE)
  const llmTrim = (cfg.llmModel ?? "").trim()
  const llmModel = llmTrim.length > 0 ? llmTrim : DEFAULT_LLM_MODEL
  const embedTrim = (cfg.embedModel ?? "").trim()
  const embedModel = embedTrim.length > 0 ? embedTrim : DEFAULT_EMBED_MODEL
  const embeddingDims =
    cfg.embeddingDims !== undefined && Number.isFinite(cfg.embeddingDims) ? cfg.embeddingDims : DEFAULT_EMBED_DIMS
  return {
    ...cfg,
    baseUrl,
    llmModel,
    embedModel,
    embeddingDims,
    qdrantUrl: normalizeQdrantUrl(cfg.qdrantUrl),
  }
}

type MemoryCtor = new (cfg: Record<string, unknown>) => MemoryType

let cachedClient: { key: string; client: MemoryType } | null = null
let cachedCtor: MemoryCtor | null = null

async function loadMemoryCtor(): Promise<MemoryCtor> {
  if (cachedCtor) return cachedCtor
  const mod = (await import("mem0ai/oss")) as { Memory: MemoryCtor }
  cachedCtor = mod.Memory
  return mod.Memory
}

function configCacheKey(cfg: Mem0Config): string {
  const n = normalizeMem0RuntimeConfig(cfg)
  return [
    n.baseUrl ?? DEFAULT_LLM_BASE,
    n.llmModel ?? DEFAULT_LLM_MODEL,
    n.embedModel ?? DEFAULT_EMBED_MODEL,
    n.embeddingDims ?? DEFAULT_EMBED_DIMS,
    n.qdrantUrl,
    n.qdrantCollection ?? DEFAULT_COLLECTION,
  ].join("|")
}

async function getClient(cfg: Mem0Config): Promise<MemoryType> {
  const n = normalizeMem0RuntimeConfig(cfg)
  const key = configCacheKey(n)
  if (cachedClient && cachedClient.key === key) return cachedClient.client
  const Ctor = await loadMemoryCtor()
  const llmBase = n.baseUrl ?? DEFAULT_LLM_BASE
  const llmModel = n.llmModel ?? DEFAULT_LLM_MODEL
  const embedBase = n.baseUrl ?? DEFAULT_LLM_BASE
  const embedModel = n.embedModel ?? DEFAULT_EMBED_MODEL
  const embedDims = n.embeddingDims ?? DEFAULT_EMBED_DIMS
  const client = new Ctor({
    llm: {
      provider: "openai",
      config: {
        apiKey: n.apiKey,
        baseURL: llmBase,
        model: llmModel,
      },
    },
    embedder: {
      provider: "openai",
      config: {
        apiKey: n.apiKey,
        baseURL: embedBase,
        model: embedModel,
        embeddingDims: embedDims,
      },
    },
    vectorStore: {
      provider: "qdrant",
      config: {
        // Inject our own minimal client (direct undici fetch, no qdrant-js
        // Agent). Bypasses qdrant-js's keepalive-Agent ECONNRESET against
        // Fly.dev edge. mem0's Qdrant adapter accepts a pre-built `client`
        // and skips its own QdrantClient construction.
        client: new FetchQdrantClient({ url: n.qdrantUrl, apiKey: n.qdrantApiKey }),
        collectionName: n.qdrantCollection ?? DEFAULT_COLLECTION,
        embeddingModelDims: embedDims,
        dimension: embedDims,
      },
    },
    // Cloud Functions (esbuild) cannot ship better-sqlite3's native .node
    // binding; disableHistory uses an in-memory DummyHistoryManager instead.
    // We don't need persistent fact history — Qdrant is the source of truth.
    disableHistory: true,
  } as Record<string, unknown>)
  cachedClient = { key, client }
  return client
}

/**
 * Reset cached Memory client. Used by tests; safe in production at process boot.
 */
export function _resetMem0Client() {
  cachedClient = null
}

export async function mem0Search(
  config: Mem0Config,
  query: string,
  userId: string
): Promise<string[]> {
  const client = await getClient(config)
  try {
    const res = (await client.search(query, {
      topK: 8,
      filters: { user_id: userId },
    })) as
      | { results?: Array<{ memory?: string; text?: string }> }
      | Array<{ memory?: string; text?: string }>
      | undefined
    const list = Array.isArray(res) ? res : res?.results ?? []
    return list.map((m) => m.memory || m.text || "").filter(Boolean)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log("[mem0/search] error", e instanceof Error ? `${e.name}: ${e.message}` : String(e))
    throw e
  }
}

export async function mem0Add(
  config: Mem0Config,
  messages: { role: "user" | "assistant"; content: string }[],
  userId: string
): Promise<void> {
  const client = await getClient(config)
  try {
    await client.add(messages, { userId })
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log("[mem0/add] error", e instanceof Error ? `${e.name}: ${e.message}` : String(e))
    throw e
  }
}
