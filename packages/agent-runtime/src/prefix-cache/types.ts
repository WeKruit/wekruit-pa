/**
 * Phase 40 T5 — SiliconFlow prefix cache types.
 *
 * D7 (verified Phase 28 research): SiliconFlow Qwen3-8B serves a server-side
 * KV cache for identical prefix tokens — measured ~20-40% latency win at zero
 * quality cost when client-side messages produce stable system + few-shot
 * prefix bytes. This module provides the thin client-side wrapper that:
 *  1. Hashes the prefix portion of `messages` (system + leading few-shot)
 *  2. Records cache hit/miss + latency telemetry per call
 *  3. Surfaces warm/cold flag to caller for observability
 *
 * Module is NOT a network bypass — every call still hits SiliconFlow. The
 * latency win comes from server-side KV cache hitting on identical prefix.
 * The wrapper just makes the prefix consistent across calls + measures.
 *
 * Hard constraints:
 *  - 0 net new LLM calls in production path (wrapper, not duplicate caller)
 *  - LRU bound (capacity 50) — prevents unbounded memory growth
 *  - SHA-256 hash of stringified prefix (deterministic, collision-resistant)
 *  - Latency telemetry surfaced via `_cacheStats` extension on result
 */

import type OpenAI from "openai"

/**
 * Subset of OpenAI ChatCompletion the wrapper cares about. We don't depend
 * on the full OpenAI SDK type tree — keeps this module testable in isolation.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer"
  content: string | null | unknown
  name?: string
}

export interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  temperature?: number
  max_tokens?: number
  // Many other fields permitted; we pass-through unchanged.
  [key: string]: unknown
}

/**
 * Telemetry attached to the result so wire-in callers can log to
 * `pa_turns.usage` and dashboards can chart hit rate over time.
 */
export interface PrefixCacheStats {
  /** SHA-256 of the prefix portion of messages, truncated to 16 hex chars. */
  hashId: string
  /** Number of prior calls in this process with the same prefix. */
  hitCount: number
  /** True when this was a cache hit (hitCount >= 1 prior to this call). */
  warm: boolean
  /** Wall-clock for the upstream call, in milliseconds. */
  latencyMs: number
  /** Total prefix character length (for token-cost estimation). */
  prefixCharLen: number
}

/** ChatCompletion-shape result the wrapper returns (pass-through + stats). */
export type CachedChatCompletion = OpenAI.Chat.Completions.ChatCompletion & {
  _cacheStats: PrefixCacheStats
}

/** Minimal client interface the wrapper expects. */
export interface ChatClient {
  chat: {
    completions: {
      create: (
        request: ChatCompletionRequest,
        options?: { signal?: AbortSignal; timeout?: number }
      ) => Promise<OpenAI.Chat.Completions.ChatCompletion>
    }
  }
}

/** Wrapper config. */
export interface PrefixCacheOpts {
  /** LRU capacity — default 50 prefixes tracked. */
  capacity?: number
  /**
   * Override prefix-detection function. Default: leading `system` messages
   * + leading `user`/`assistant` few-shot pairs (until first non-few-shot
   * user message). Tests override for deterministic boundary control.
   */
  isPrefixMessage?: (msg: ChatMessage, idx: number, all: ChatMessage[]) => boolean
}

/** Cumulative stats exposed via `getPrefixCacheStats()`. */
export interface PrefixCacheGlobalStats {
  hits: number
  misses: number
  evictions: number
  hitRate: number
  capacity: number
  size: number
}

/** Wrapped client returned by `wrapWithPrefixCache(...)`. */
export interface CachedChatClient {
  chat: {
    completions: {
      create: (
        request: ChatCompletionRequest,
        options?: { signal?: AbortSignal; timeout?: number }
      ) => Promise<CachedChatCompletion>
    }
  }
}
