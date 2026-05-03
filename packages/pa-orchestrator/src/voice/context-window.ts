/**
 * Long-context humanize control — sliding-window history truncation.
 *
 * WHY (Adam 2026-05-02 spec):
 *   Qwen-7B advertises 32k context but effective attention degrades past
 *   ~6k input tokens. Long sessions trigger:
 *     - repeated tokens ("下下下下下下", "投投", "向向")
 *     - hallucinated literal-prompt copies ("算法磨人")
 *     - mixed-register drift / NEVER-rule ignores (Bible v7.5 pushed out
 *       of attention by long history tail)
 *
 *   The current orchestrator caps history by TURN COUNT
 *   (HISTORY_LIMIT=40) but never by TOKEN COUNT — a 40-turn session with
 *   long replies easily blows 6k tokens, blowing past Qwen-7B's effective
 *   attention.
 *
 * STRATEGY:
 *   Sliding window: always keep the LAST `minTurns` turns (default 8) and
 *   drop earlier turns until the estimated token count fits within
 *   `maxTokens` (default 1500). When the kept tail itself already exceeds
 *   the budget we still keep all `minTurns` (never truncate the most
 *   recent context — that's what the user is actually replying to).
 *
 * NON-GOALS:
 *   - Older-turn LLM summarization is intentionally deferred (Phase 39
 *     conversation-summary backlog) — adds 1 LLM call per turn.
 *   - True tokenizer (gpt-tokenizer / @huggingface/tokenizers) NOT used
 *     to keep this layer dependency-free + sub-1ms. Heuristic accepts
 *     ±20% error which is well below the 6k attention-degrade margin
 *     when budget is 1500.
 *
 * Token estimation heuristic:
 *   - 1 CJK character ≈ 1 token (Qwen BPE for CJK is roughly 1:1)
 *   - 1 ASCII whitespace-separated word ≈ 1.3 tokens
 *   - per-message overhead (role marker + separators) ≈ 4 tokens
 *
 * SAFETY:
 *   - Pure function, no I/O, never throws.
 *   - Empty / single-turn input returns input unchanged.
 *   - `minTurns` is a hard floor — never returns fewer than min(minTurns,
 *     history.length) regardless of token budget.
 */

/** Minimal shape needed for truncation — matches `ChatMessage` and few-shot turns. */
export type TruncatableMessage = {
  body: string
}

/** Per-message overhead (role marker + separators) in token estimate. */
const PER_MESSAGE_OVERHEAD_TOKENS = 4

/** Default budget — well below Qwen-7B's ~6k effective-attention degrade line. */
export const DEFAULT_MAX_TOKENS = 1500

/** Always keep at least this many recent turns (4 user + 4 assistant pairs). */
export const DEFAULT_MIN_TURNS = 8

/** Telemetry threshold — input above this fires a context-window warning log. */
export const TELEMETRY_THRESHOLD_TOKENS = 4000

/**
 * Estimate tokens for a piece of text using a CJK-aware heuristic.
 *
 *   - CJK char (U+4E00-U+9FFF + extensions + Hangul + Hiragana + Katakana) → 1 token
 *   - ASCII whitespace-split words → 1.3 tokens each
 *   - Other (emoji / symbols) absorbed into the ASCII word count
 *
 * Returns 0 for empty / non-string. NEVER throws.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (typeof text !== "string" || text.length === 0) return 0
  // Count CJK / Hangul / Hiragana / Katakana code points.
  // Range cheat-sheet:
  //   CJK Unified                U+4E00-U+9FFF
  //   CJK Ext A                  U+3400-U+4DBF
  //   CJK Compatibility          U+F900-U+FAFF
  //   Hiragana / Katakana        U+3040-U+30FF
  //   Hangul Syllables           U+AC00-U+D7AF
  //   CJK Symbols & Punctuation  U+3000-U+303F (counted to handle 。、)
  const cjkRegex = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g
  const cjkMatches = text.match(cjkRegex)
  const cjkCount = cjkMatches ? cjkMatches.length : 0
  // Strip CJK so the ASCII word counter doesn't double-count CJK chars
  // when they're glued to ASCII (e.g. "AI工程师").
  const asciiOnly = text.replace(cjkRegex, " ")
  const asciiWords = asciiOnly.split(/\s+/).filter((w) => w.length > 0)
  const asciiTokens = Math.ceil(asciiWords.length * 1.3)
  return cjkCount + asciiTokens
}

/**
 * Estimate tokens for an array of messages, including per-message overhead.
 */
export function estimateHistoryTokens(history: ReadonlyArray<TruncatableMessage>): number {
  if (!Array.isArray(history) || history.length === 0) return 0
  let total = 0
  for (const m of history) {
    total += estimateTokens(m?.body) + PER_MESSAGE_OVERHEAD_TOKENS
  }
  return total
}

export type TruncateOptions = {
  /** Max estimated tokens for the kept slice. Default `DEFAULT_MAX_TOKENS`. */
  maxTokens?: number
  /** Hard floor on kept turns. Default `DEFAULT_MIN_TURNS`. */
  minTurns?: number
}

export type TruncateResult<T extends TruncatableMessage> = {
  /** The kept tail, in original order (oldest → newest). */
  kept: T[]
  /** The number of turns dropped from the head. */
  droppedCount: number
  /** Estimated tokens for the kept tail (after truncation). */
  keptTokens: number
  /** Estimated tokens for the original history (before truncation). */
  originalTokens: number
  /** True when truncation actually removed at least one turn. */
  truncated: boolean
}

/**
 * Truncate a history array by sliding-window token budget.
 *
 * Always keeps the LAST `min(minTurns, history.length)` turns, then walks
 * backwards from there adding older turns until adding one more would
 * exceed `maxTokens`. The kept slice is always a contiguous tail.
 *
 *   keepCount := max(minTurns, largest k such that
 *                    estimateHistoryTokens(history.slice(-k)) <= maxTokens)
 *
 * If the bare `minTurns` tail already exceeds `maxTokens` we keep
 * `minTurns` anyway — the most recent context is what the user is
 * actively replying to and must never be dropped.
 */
export function truncateHistoryByTokens<T extends TruncatableMessage>(
  history: ReadonlyArray<T>,
  options: TruncateOptions = {}
): TruncateResult<T> {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  const minTurns = options.minTurns ?? DEFAULT_MIN_TURNS
  const arr = Array.isArray(history) ? [...history] : []
  const originalTokens = estimateHistoryTokens(arr)
  if (arr.length === 0) {
    return { kept: [], droppedCount: 0, keptTokens: 0, originalTokens: 0, truncated: false }
  }
  // Floor — always keep at least min(minTurns, length).
  const floor = Math.min(minTurns, arr.length)
  // Start from the floor and grow towards the head while budget allows.
  let keepCount = floor
  let runningTokens = estimateHistoryTokens(arr.slice(arr.length - floor))
  for (let i = arr.length - floor - 1; i >= 0; i -= 1) {
    const candidateTokens = estimateTokens(arr[i]!.body) + PER_MESSAGE_OVERHEAD_TOKENS
    if (runningTokens + candidateTokens > maxTokens) break
    runningTokens += candidateTokens
    keepCount += 1
  }
  const kept = arr.slice(arr.length - keepCount)
  const keptTokens = estimateHistoryTokens(kept)
  return {
    kept,
    droppedCount: arr.length - keepCount,
    keptTokens,
    originalTokens,
    truncated: arr.length - keepCount > 0,
  }
}
