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
  return [
    cfg.baseUrl ?? DEFAULT_LLM_BASE,
    cfg.llmModel ?? DEFAULT_LLM_MODEL,
    cfg.embedModel ?? DEFAULT_EMBED_MODEL,
    cfg.embeddingDims ?? DEFAULT_EMBED_DIMS,
    cfg.qdrantUrl,
    cfg.qdrantCollection ?? DEFAULT_COLLECTION,
  ].join("|")
}

async function getClient(cfg: Mem0Config): Promise<MemoryType> {
  const key = configCacheKey(cfg)
  if (cachedClient && cachedClient.key === key) return cachedClient.client
  const Ctor = await loadMemoryCtor()
  const client = new Ctor({
    llm: {
      provider: "openai",
      config: {
        apiKey: cfg.apiKey,
        baseURL: cfg.baseUrl ?? DEFAULT_LLM_BASE,
        model: cfg.llmModel ?? DEFAULT_LLM_MODEL,
      },
    },
    embedder: {
      provider: "openai",
      config: {
        apiKey: cfg.apiKey,
        baseURL: cfg.baseUrl ?? DEFAULT_LLM_BASE,
        model: cfg.embedModel ?? DEFAULT_EMBED_MODEL,
        embeddingDims: cfg.embeddingDims ?? DEFAULT_EMBED_DIMS,
      },
    },
    vectorStore: {
      provider: "qdrant",
      config: {
        url: cfg.qdrantUrl,
        apiKey: cfg.qdrantApiKey,
        collectionName: cfg.qdrantCollection ?? DEFAULT_COLLECTION,
        embeddingModelDims: cfg.embeddingDims ?? DEFAULT_EMBED_DIMS,
      },
    },
    historyDbPath: ":memory:",
  })
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
  const res = (await client.search(query, {
    topK: 8,
    filters: { userId },
  })) as
    | { results?: Array<{ memory?: string; text?: string }> }
    | Array<{ memory?: string; text?: string }>
    | undefined
  const list = Array.isArray(res) ? res : res?.results ?? []
  return list.map((m) => m.memory || m.text || "").filter(Boolean)
}

export async function mem0Add(
  config: Mem0Config,
  messages: { role: "user" | "assistant"; content: string }[],
  userId: string
): Promise<void> {
  const client = await getClient(config)
  await client.add(messages, { userId })
}
