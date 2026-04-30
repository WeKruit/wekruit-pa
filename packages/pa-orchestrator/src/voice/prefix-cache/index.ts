/**
 * Phase 40 T5 — Prefix-cache barrel.
 *
 * Public API:
 *   - `wrapWithPrefixCache(client, opts?)` — wrap an OpenAI-compat client.
 *   - `getPrefixCacheStats()` — cumulative hit/miss/eviction counters.
 *   - Types: `CachedChatClient`, `CachedChatCompletion`, `PrefixCacheStats`,
 *            `PrefixCacheGlobalStats`, `PrefixCacheOpts`.
 *
 * Wire-in (Adam-owed via WIRE-IN-PATCH.md Section 7) wraps `cachedClient`
 * once in `defaultDeps`:
 *
 *   import { wrapWithPrefixCache } from "./prefix-cache/index.js"
 *   cachedClient = wrapWithPrefixCache(new OpenAI({ apiKey, baseURL }))
 */

export {
  wrapWithPrefixCache,
  getPrefixCacheStats,
  defaultIsPrefixMessage,
  _resetPrefixCache,
} from "./prefix-cache.js"

export type {
  CachedChatClient,
  CachedChatCompletion,
  ChatClient,
  ChatCompletionRequest,
  ChatMessage,
  PrefixCacheGlobalStats,
  PrefixCacheOpts,
  PrefixCacheStats,
} from "./types.js"
