/**
 * Mem0 OSS SDK (mem0ai/oss) — add + search
 * LLM: SiliconFlow (OpenAI-compatible)
 * Embedder: SiliconFlow BAAI/bge-m3 (1024 dims)
 * VectorStore: Qdrant (self-hosted on Fly)
 *
 * Public API kept backward-compatible with the previous Mem0 Cloud HTTP shim
 * so that `stacked.ts` and `pa-orchestrator` need no source changes:
 *   - `mem0Search(config, query, userId): Promise<string[]>`
 *   - `mem0Add(config, messages, userId, options?): Promise<void>`
 *
 * iter30 WS1 (2026-05-03): `mem0Add` now accepts an optional 4th `options`
 * parameter carrying `metadata` + `agentId`. Both flow through to the
 * underlying Mem0 SDK call (`AddMemoryOptions.metadata` /
 * `AddMemoryOptions.agentId`) which round-trips them into the Qdrant point
 * payload alongside the SDK-managed user_id/agent_id/run_id stamps. All
 * pre-iter30 callers remain valid (3-arg invocations).
 *
 * Config is sourced from process env at the call boundary in `stacked.ts`.
 * The `Mem0Config` shape is widened to carry the new OSS-specific fields,
 * but legacy `apiKey`/`baseUrl` props are still accepted (treated as a
 * generic OpenAI-compatible LLM key + base URL).
 */
import type { Memory as MemoryType } from "mem0ai/oss"
import { detectCrisisInInput, hashForAudit } from "@pa/pa-safety"
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
  /** Qdrant collection name; defaults to `pa-memory`. */
  qdrantCollection?: string
}

const DEFAULT_LLM_BASE = "https://api.siliconflow.cn/v1"
const DEFAULT_LLM_MODEL = "Qwen/Qwen2.5-72B-Instruct"
const DEFAULT_EMBED_MODEL = "BAAI/bge-m3"
const DEFAULT_EMBED_DIMS = 1024
const DEFAULT_COLLECTION = "pa-memory"

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

/**
 * Backlog #24 — emit a `pa.spend.daily` event so Mem0 internal-LLM call
 * volume is observable. mem0ai/oss does NOT surface token usage to the
 * client, so we tag count only (usd=0). The same telemetry shape is used
 * by `apps/functions/src/instrumentation/cost-logger.ts` — keeping mem0
 * dependency-free (no firebase-functions import) so this package stays
 * a pure SDK wrapper. Cloud Logging parses console.log JSON identically
 * to the firebase-functions logger.
 *
 * Fail-open: any synchronous error inside this emit is swallowed.
 *
 * TODO(mem0-fork): mem0ai/oss internal extractor cost is opaque (no
 * client-visible token counts). Real $/call enforcement requires a fork
 * exposing usage via the client.add/search return shape. Tracked alongside
 * V1.5-ROLLOUT.md backlog #24.
 */
function emitMem0CostEvent(op: "add" | "search", config: Mem0Config, userId: string, extra: Record<string, string | number | undefined> = {}): void {
  try {
    const payload = {
      "pa.metric": "pa.spend.daily",
      kind: "mem0",
      service: "mem0",
      model: (config.llmModel ?? "Qwen/Qwen2.5-72B-Instruct") + "::" + (config.embedModel ?? "BAAI/bge-m3"),
      inputTokens: 0,
      outputTokens: 0,
      count: 1,
      usd: 0,
      operation: op,
      userId,
      ...extra,
    }
    // eslint-disable-next-line no-console
    console.log("pa.spend.daily", payload)
  } catch {
    /* fail-open: cost-ledger never blocks production path */
  }
}


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
    emitMem0CostEvent("search", config, userId, { resultCount: list.length })
    return list.map((m) => m.memory || m.text || "").filter(Boolean)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log("[mem0/search] error", e instanceof Error ? `${e.name}: ${e.message}` : String(e))
    throw e
  }
}

/**
 * Stream-E P0 (2026-05-02) — Crisis-text scrub gate for Mem0 writes.
 *
 * Phase 51 commit d6b683d TD-1: crisis-ideation user input was being
 * written to Mem0 unredacted, violating Adam directive on PII / re-traumatization.
 * This helper inspects every outgoing message; if ANY message tripping the
 * crisis bank, we SKIP the entire `mem0.add` call and return faux-success.
 *
 * Why skip-not-redact:
 *   - Redacting to `[CRISIS_REDACTED]` still creates a Qdrant vector that
 *     could be surfaced in future recall (degrading reply quality).
 *   - Skipping is cheap (no client call) AND keeps the upstream
 *     `afterAssistantTurn.writebackRan` semantics intact (caller's view of
 *     "did writeback succeed" is preserved at the boolean level).
 *
 * Emergency disable: env `PA_MEM0_CRISIS_SCRUB_DISABLED=true` (cold-start).
 * Default ON. Firestore-flag wiring (`paMem0CrisisScrubEnabled`) is a
 * follow-up — `mem0.ts` is a pure SDK wrapper with no Firestore handle, so
 * the env-var path is the only enforcement point at this layer. Caller-stack
 * Firestore flag is tracked as TD in INTENT-PLAYBOOK §3.7-followup.
 */
export function scrubCrisisFromMessages(
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>
): { skip: boolean; reason: "no_match" | "crisis_detected" | "scrub_disabled"; signals: string[]; inputHashes: string[] } {
  if (process.env.PA_MEM0_CRISIS_SCRUB_DISABLED === "true") {
    return { skip: false, reason: "scrub_disabled", signals: [], inputHashes: [] }
  }
  const allSignals: string[] = []
  const allHashes: string[] = []
  for (const m of messages) {
    const det = detectCrisisInInput(m.content ?? "")
    if (det.detected) {
      allSignals.push(...det.signals)
      allHashes.push(hashForAudit(m.content ?? ""))
    }
  }
  if (allSignals.length === 0) {
    return { skip: false, reason: "no_match", signals: [], inputHashes: [] }
  }
  return { skip: true, reason: "crisis_detected", signals: allSignals, inputHashes: allHashes }
}

/**
 * Optional iter30 extension on top of the legacy 3-arg signature. Callers can
 * pass arbitrary `metadata` (round-tripped to Qdrant payload via Mem0 SDK's
 * `AddMemoryOptions.metadata`) and/or an `agentId` (forwarded as the SDK's
 * `agentId` field which Mem0 stamps into both `filters.agent_id` and the
 * payload's `agent_id` key).
 *
 * Backward compat: every existing 3-arg call (`mem0Add(config, messages,
 * userId)`) keeps the same shape — `options` is optional and defaults to
 * passing nothing extra to the SDK.
 *
 * `infer` is intentionally left at the SDK default (true). When callers
 * explicitly opt out, they pass `{ infer: false }` here and we forward that
 * to the SDK so the messages are stored verbatim with the supplied metadata
 * (used by round-trip tests / direct-write paths). Default behaviour stays
 * extractor-on so production traffic is unchanged.
 */
export type Mem0AddOptions = {
  metadata?: Record<string, unknown>
  agentId?: string
  /** Forwarded to Mem0 SDK `AddMemoryOptions.infer`. Defaults to SDK default (true). */
  infer?: boolean
}

export async function mem0Add(
  config: Mem0Config,
  messages: { role: "user" | "assistant"; content: string }[],
  userId: string,
  options?: Mem0AddOptions
): Promise<void> {
  // Stream-E P0: pre-flight crisis-text scrub. NEVER write crisis content to
  // Mem0. Skip silently with PII-safe telemetry; return faux-success so the
  // upstream `afterAssistantTurn` writeback contract is preserved.
  const scrub = scrubCrisisFromMessages(messages)
  if (scrub.skip) {
    // eslint-disable-next-line no-console
    console.log("[mem0/add] memory:crisis_scrubbed", {
      userId,
      reason: scrub.reason,
      signalCount: scrub.signals.length,
      // signal IDs are pattern sources (no raw user text). Truncate to
      // first 8 to keep log line bounded.
      signals: scrub.signals.slice(0, 8),
      inputHashes: scrub.inputHashes.slice(0, 4),
      messageCount: messages.length,
    })
    return
  }

  const client = await getClient(config)
  try {
    // Build Mem0 SDK AddMemoryOptions. Only include keys when the caller
    // supplied them so the SDK falls back to its own defaults otherwise
    // (3-arg legacy calls land here with `options === undefined`, producing
    // the exact same `{ userId }` payload as before iter30).
    const sdkOptions: Record<string, unknown> = { userId }
    if (options?.metadata !== undefined) sdkOptions.metadata = options.metadata
    if (options?.agentId !== undefined) sdkOptions.agentId = options.agentId
    if (options?.infer !== undefined) sdkOptions.infer = options.infer
    await client.add(messages, sdkOptions as Parameters<typeof client.add>[1])
    emitMem0CostEvent("add", config, userId, {
      messageCount: messages.length,
      hasMetadata: options?.metadata ? "1" : "0",
      hasAgentId: options?.agentId ? "1" : "0",
    })
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log("[mem0/add] error", e instanceof Error ? `${e.name}: ${e.message}` : String(e))
    throw e
  }
}

// ============================================================================
// iter30 WS1 — test seam: lets unit tests inject a fake Memory ctor without
// reaching the real `mem0ai/oss` module. Production code path never touches
// this. Reset together with `_resetMem0Client`.
// ============================================================================
export function __test__setMemoryCtor(ctor: MemoryCtor | null): void {
  cachedCtor = ctor
  cachedClient = null
}
