/**
 * Phase 40 T5 — SiliconFlow prefix cache POC.
 *
 * Wraps an OpenAI-compat client (the SiliconFlow client used by
 * `voice/llm-rewriter.ts`). Hashes the static prefix portion of each
 * `messages` array (system + few-shot) and tracks LRU + hit/miss telemetry.
 * The actual latency win comes from SiliconFlow's server-side KV cache
 * hitting on identical prefix tokens (D7 — verified ~20-40% latency
 * reduction at zero quality cost).
 *
 * Usage in production (per WIRE-IN-PATCH.md Section 7):
 *
 *   const cachedClient = wrapWithPrefixCache(siliconFlowClient)
 *   // Replace direct chat.completions.create with cachedClient.chat...
 *   const result = await cachedClient.chat.completions.create({
 *     model: "Qwen/Qwen3-8B",
 *     messages: [systemMessage, ...fewShotMessages, userMessage],
 *   })
 *   logToTelemetry(result._cacheStats)  // warm, hashId, latencyMs
 *
 * Tests assert: hash stability, LRU eviction, warm/cold flag mechanics,
 * latency-reduction simulation when mock client returns 50ms cold / 25ms
 * warm responses.
 */

import { createHash } from "node:crypto"
import type {
  CachedChatClient,
  CachedChatCompletion,
  ChatClient,
  ChatCompletionRequest,
  ChatMessage,
  PrefixCacheGlobalStats,
  PrefixCacheOpts,
  PrefixCacheStats,
} from "./types.js"

/** Process-local LRU + counters. Reset on cold-start (CFs gen2). */
const cache = new Map<string, { hitCount: number; lastUsedAt: number }>()
let DEFAULT_CAPACITY = 50
const cumulativeStats = { hits: 0, misses: 0, evictions: 0 }

/** Reset for tests. Not exported via index — internal use only. */
export function _resetPrefixCache(capacity?: number): void {
  cache.clear()
  cumulativeStats.hits = 0
  cumulativeStats.misses = 0
  cumulativeStats.evictions = 0
  if (typeof capacity === "number" && capacity > 0) {
    DEFAULT_CAPACITY = capacity
  }
}

export function getPrefixCacheStats(): PrefixCacheGlobalStats {
  const total = cumulativeStats.hits + cumulativeStats.misses
  return {
    hits: cumulativeStats.hits,
    misses: cumulativeStats.misses,
    evictions: cumulativeStats.evictions,
    hitRate: total === 0 ? 0 : cumulativeStats.hits / total,
    capacity: DEFAULT_CAPACITY,
    size: cache.size,
  }
}

/**
 * Default prefix detector: leading `system` messages + leading
 * `user`/`assistant` few-shot pairs (until first non-few-shot user message).
 *
 * Heuristic: a few-shot turn is a `user`/`assistant` message that appears
 * BEFORE the last user message in the array. The last user message is the
 * actual query; everything before it is treated as static prefix.
 *
 * This means: in a typical voice rewriter call with N few-shot pairs +
 * 1 final user message, the prefix is `system + (2N) few-shot messages`,
 * and the cache key stays identical across calls with the same Bible +
 * few-shot bank.
 */
export function defaultIsPrefixMessage(
  msg: ChatMessage,
  idx: number,
  all: ChatMessage[]
): boolean {
  if (msg.role === "system" || msg.role === "developer") return true
  // Find the LAST user message — anything strictly before it is prefix.
  let lastUserIdx = -1
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i]!.role === "user") {
      lastUserIdx = i
      break
    }
  }
  return idx < lastUserIdx
}

function extractPrefix(
  messages: ChatMessage[],
  isPrefix: (msg: ChatMessage, idx: number, all: ChatMessage[]) => boolean
): ChatMessage[] {
  return messages.filter((m, i) => isPrefix(m, i, messages))
}

function hashPrefix(prefix: ChatMessage[]): string {
  const norm = prefix.map((m) => ({
    role: m.role,
    name: m.name ?? null,
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  }))
  return createHash("sha256")
    .update(JSON.stringify(norm))
    .digest("hex")
    .slice(0, 16)
}

function evictOldestIfNeeded(capacity: number): void {
  while (cache.size > capacity) {
    let oldestKey: string | null = null
    let oldestTs = Infinity
    for (const [k, v] of cache.entries()) {
      if (v.lastUsedAt < oldestTs) {
        oldestTs = v.lastUsedAt
        oldestKey = k
      }
    }
    if (oldestKey === null) break
    cache.delete(oldestKey)
    cumulativeStats.evictions += 1
  }
}

/**
 * Wrap an OpenAI-compat client. Only `chat.completions.create` is wrapped;
 * other methods pass through untouched.
 *
 * The wrapper:
 *  1. Extracts prefix per `opts.isPrefixMessage` (or default detector)
 *  2. Hashes prefix with SHA-256
 *  3. Looks up hash in LRU; computes warm/cold flag
 *  4. Calls upstream `client.chat.completions.create` (server-side cache
 *     hits if hash is warm — measurable latency win)
 *  5. Updates LRU + hitCount + cumulative stats
 *  6. Returns result with `_cacheStats: PrefixCacheStats` attached
 *
 * Failure-open: if hashing or LRU bookkeeping throws (e.g. circular content
 * structure), the wrapper still calls upstream and returns the raw result
 * with `_cacheStats` set to a degraded indicator.
 */
export function wrapWithPrefixCache(
  client: ChatClient,
  opts?: PrefixCacheOpts
): CachedChatClient {
  const capacity = opts?.capacity ?? DEFAULT_CAPACITY
  const isPrefix = opts?.isPrefixMessage ?? defaultIsPrefixMessage

  return {
    chat: {
      completions: {
        create: async (
          request: ChatCompletionRequest,
          options?: { signal?: AbortSignal; timeout?: number }
        ): Promise<CachedChatCompletion> => {
          let stats: PrefixCacheStats
          try {
            const prefix = extractPrefix(request.messages, isPrefix)
            const hashId = hashPrefix(prefix)
            const prior = cache.get(hashId)
            const warm = !!prior
            const hitCount = (prior?.hitCount ?? 0) + 1
            // Update LRU optimistically (before upstream call) so concurrent
            // calls with same prefix immediately register as warm.
            cache.set(hashId, { hitCount, lastUsedAt: Date.now() })
            evictOldestIfNeeded(capacity)
            const prefixCharLen = prefix.reduce(
              (n, m) =>
                n +
                (typeof m.content === "string"
                  ? m.content.length
                  : JSON.stringify(m.content ?? "").length),
              0
            )
            if (warm) cumulativeStats.hits += 1
            else cumulativeStats.misses += 1

            const t0 = Date.now()
            const result = await client.chat.completions.create(
              request,
              options
            )
            const latencyMs = Date.now() - t0

            stats = {
              hashId,
              hitCount,
              warm,
              latencyMs,
              prefixCharLen,
            }
            return Object.assign(result, { _cacheStats: stats })
          } catch (err) {
            // Hashing / LRU defect — fall through to plain call to avoid
            // breaking the production rewrite path. Mark stats as degraded.
            const t0 = Date.now()
            const result = await client.chat.completions.create(
              request,
              options
            )
            const latencyMs = Date.now() - t0
            return Object.assign(result, {
              _cacheStats: {
                hashId: "error",
                hitCount: 0,
                warm: false,
                latencyMs,
                prefixCharLen: 0,
              } as PrefixCacheStats,
            })
          }
        },
      },
    },
  }
}
