/**
 * v1.5 / Phase 53+ — Probabilistic reply-count split (Adam humanize spec).
 *
 * BACKGROUND
 * ----------
 * Bug 4 (commit ea59897) introduced a single-send-per-turn invariant after
 * Adam's 2026-05-03 实测 saw 6 outbound bubbles for 4 inbound msgs. That fix
 * was correct in spirit (no chunking by length) but over-corrected: real
 * humans on iMessage routinely send 1-OR-2 messages per reply turn — never
 * 3+, but mixing is what makes texting look like texting.
 *
 * This module implements the post-generation probabilistic split: given the
 * fully normalized `visibleReply`, decide whether to ship 1 or 2 outbound
 * bubbles and where to cut. Decision is seeded (turnId) for replay-determinism.
 *
 * DESIGN
 * ------
 * - Post-gen, not pre-gen — Qwen-7B doesn't reliably honor "respond in 1-2
 *   parts, separator |||" directives. Determinism wins.
 * - Hard short-circuits to 1: empty / very short / single-sentence / contains
 *   crisis hotline trailer / contains mem0Degraded marker. Crisis must NEVER
 *   ship as 2 bubbles — splitting risks the hotline arriving alone or losing
 *   visual co-location with the empathy line.
 * - Split-point preference: transition markers (zh "另外/对了"; en "also/btw")
 *   are strongest; sentence boundaries are next; double-newline last. We never
 *   split mid-sentence.
 * - Position constraint: cut must fall in the middle 30%-70% of the reply,
 *   so we don't produce a 5-char part + a 200-char part (which looks
 *   accidental, not natural).
 * - Probability: weighted_random with default p_one=0.65. For long replies
 *   (>100 chars and ≥3 sentences) p_two is bumped to 0.5 — the longer the
 *   reply, the more natural it is to break it up.
 * - RNG: mulberry32 seeded by sha-like-fold of seed string. Same seed →
 *   same decision. Tests rely on this.
 *
 * NON-GOALS
 * ---------
 * - 3+ part splits: never. ≤2 sends per turn is the new invariant.
 * - Mid-sentence splits: never. Always cut at a structural boundary.
 * - Length-based chunking: that was the Bug 4 path; we don't do it here.
 *   `output-normalizer` keeps `maxLength=600` purely as a telemetry signal.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type SplitReason =
  | "short_force_1"
  | "single_sentence_force_1"
  | "hotline_trailer_force_1"
  | "mem0_marker_force_1"
  | "long_high_prob_2"
  | "weighted_random_1"
  | "weighted_random_2"
  | "no_split_point"
  | "empty"

export interface SplitDecision {
  count: 1 | 2
  parts: string[]
  reason: SplitReason
  /** Char index in the ORIGINAL reply where the second part begins. Undefined when count=1. */
  splitAtIndex?: number
}

export interface DecideReplySplitOptions {
  /** Deterministic seed (typically turnId). Falsy → fresh Math.random per call. */
  seed?: string
  /** Probability of returning count=1. Default 0.65. Must be in [0,1]. */
  pOne?: number
  /** Replies shorter than this many chars always force count=1. Default 60. */
  minCharsForSplit?: number
  /** Replies with ≤ this many sentences always force count=1. Default 1. */
  maxSentencesForForce1?: number
  /**
   * When true, replies that look like crisis-hotline trailers are NOT split.
   * Default true. Set false only for unit testing the split mechanism itself.
   */
  guardHotline?: boolean
}

// ---------------------------------------------------------------------------
// Seeded RNG — mulberry32 (32-bit, fast, deterministic, well-distributed)
// ---------------------------------------------------------------------------

function foldStringToUint32(s: string): number {
  // FNV-1a 32-bit. Sufficient entropy + dispersion for our seed → RNG path.
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildRng(seed: string | undefined): () => number {
  if (!seed || seed.length === 0) {
    return Math.random
  }
  return mulberry32(foldStringToUint32(seed))
}

// ---------------------------------------------------------------------------
// Sentence + transition tokenizer (bilingual)
// ---------------------------------------------------------------------------

/**
 * Sentence-terminator regex: zh `。！？` or en `.!?` followed by whitespace
 * or end-of-string. Captures the punctuation in group 1 so callers can
 * preserve it in the first part. We DO NOT split on bare commas — those are
 * intra-sentence pauses, not sentence boundaries.
 */
const SENTENCE_TERMINATOR = /([.。!?！？])(\s+|$)/g

/**
 * Count sentences. We use the terminator regex; if a reply has no terminator
 * but is non-empty, it counts as 1 sentence (informal texts).
 */
export function countSentences(reply: string): number {
  if (!reply || !reply.trim()) return 0
  const matches = reply.match(/[.。!?！？]+/g)
  if (!matches || matches.length === 0) return 1
  // Trailing terminator → matches.length is sentence count.
  // No trailing terminator → there's an extra incomplete sentence after.
  const trailing = /[.。!?！？]\s*$/.test(reply.trimEnd())
  return trailing ? matches.length : matches.length + 1
}

/**
 * Transition markers — strong signals that the writer started a new
 * thought. When found at the start of a sentence (post-boundary), they're
 * the preferred split point.
 *
 * zh markers MUST be tested at-the-start-of-sentence: 另外, 对了, 还有, 不过, 而且
 * en markers (case-insensitive, word-boundary): also, btw, oh and, plus
 *
 * NOTE: order within the array is irrelevant — we score candidates equally
 * within the "transition" tier; final pick is by position-score.
 */
const ZH_TRANSITIONS = ["另外", "对了", "还有", "不过", "而且"]
const EN_TRANSITIONS = ["also", "btw", "oh and", "plus"]

interface SplitCandidate {
  /** Char index in the original reply where the second part will START. */
  index: number
  /** Higher = preferred. transition=3, sentence_punct=2, double_newline=1 */
  tier: number
}

/**
 * Find all viable split-point candidates within `reply`.
 *
 * Position constraint: candidate must fall in [minPos, maxPos] where
 * minPos = floor(len * 0.30) and maxPos = floor(len * 0.70). Prevents
 * lopsided 5-char + 200-char splits that look accidental.
 *
 * Returns candidates sorted by tier DESC then by closeness-to-center ASC.
 */
function findSplitCandidates(reply: string): SplitCandidate[] {
  const len = reply.length
  if (len < 2) return []
  const minPos = Math.floor(len * 0.3)
  const maxPos = Math.floor(len * 0.7)
  const center = Math.floor(len / 2)
  const candidates: SplitCandidate[] = []

  // Tier 3: transition markers preceded by a sentence boundary.
  // We scan for zh markers (which carry their own boundary semantics in
  // Chinese — they're typically at sentence-start) and en transitions
  // following whitespace/punct.
  for (const marker of ZH_TRANSITIONS) {
    let from = 0
    while (true) {
      const idx = reply.indexOf(marker, from)
      if (idx < 0) break
      from = idx + marker.length
      // Must be preceded by a sentence terminator + optional whitespace,
      // OR start of paragraph (newline).
      const before = reply.slice(0, idx).trimEnd()
      const lastChar = before.length > 0 ? before[before.length - 1]! : ""
      const validBefore =
        idx === 0 ||
        /[.。!?！？\n]/.test(lastChar) ||
        before.length === 0
      if (validBefore && idx >= minPos && idx <= maxPos) {
        candidates.push({ index: idx, tier: 3 })
      }
    }
  }
  for (const marker of EN_TRANSITIONS) {
    const re = new RegExp(`(^|[\\s.!?])(${marker})\\b`, "gi")
    let m: RegExpExecArray | null
    while ((m = re.exec(reply)) !== null) {
      // Index of the marker itself (after the leading boundary char).
      const markerStart = m.index + m[1]!.length
      if (markerStart >= minPos && markerStart <= maxPos) {
        candidates.push({ index: markerStart, tier: 3 })
      }
    }
  }

  // Tier 2: sentence-terminator boundaries.
  SENTENCE_TERMINATOR.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SENTENCE_TERMINATOR.exec(reply)) !== null) {
    // Position of the start of the NEXT part (after punct + whitespace).
    const idx = m.index + m[0]!.length
    if (idx >= minPos && idx <= maxPos && idx < len) {
      candidates.push({ index: idx, tier: 2 })
    }
  }

  // Tier 1: explicit double-newline (paragraph) boundaries.
  {
    const re = /\n\n+/g
    let dm: RegExpExecArray | null
    while ((dm = re.exec(reply)) !== null) {
      const idx = dm.index + dm[0]!.length
      if (idx >= minPos && idx <= maxPos && idx < len) {
        candidates.push({ index: idx, tier: 1 })
      }
    }
  }

  // Sort: highest tier first, then closest-to-center.
  candidates.sort((a, b) => {
    if (a.tier !== b.tier) return b.tier - a.tier
    return Math.abs(a.index - center) - Math.abs(b.index - center)
  })

  // De-dup by index (a sentence boundary may also be a transition start).
  const seen = new Set<number>()
  const unique: SplitCandidate[] = []
  for (const c of candidates) {
    if (!seen.has(c.index)) {
      seen.add(c.index)
      unique.push(c)
    }
  }
  return unique
}

// ---------------------------------------------------------------------------
// Hotline / mem0 marker detection (defense-in-depth duplicate of pa-safety)
// ---------------------------------------------------------------------------

/**
 * Local sniff: does this reply contain a hotline trailer? We duplicate the
 * minimal pattern set from `pa-safety/crisis-detector.ts` rather than import
 * to keep this module self-contained for unit testing without a full safety
 * package wire-up. The orchestrator main path uses the canonical
 * `replyContainsHotline` from pa-safety BEFORE calling us; this is a
 * defense-in-depth second check.
 */
function looksLikeHotlineTrailer(reply: string): boolean {
  if (!reply) return false
  // Numeric hotline tokens (PII-stable across both EN and ZH trailers).
  if (/\b988\b/.test(reply)) return true
  if (/\b741741\b/.test(reply)) return true
  if (/400-?161-?9995/.test(reply)) return true
  // ZH "心理援助热线" — only present in our trailer template
  if (reply.includes("心理援助热线")) return true
  // EN "Crisis Text Line"
  if (/Crisis Text Line/i.test(reply)) return true
  return false
}

/**
 * mem0Degraded notice (index.ts:1488). Format:
 *   "${reply}\n\n（长期语义记忆暂时不可用；我仍使用已确认事实和最近对话。）"
 * If the reply ends with this notice, we should not split — the notice is a
 * pinned trailer that must remain attached to the preceding body.
 */
function looksLikeMem0DegradedNotice(reply: string): boolean {
  if (!reply) return false
  return reply.includes("长期语义记忆暂时不可用")
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

const DEFAULT_MIN_CHARS_FOR_SPLIT = 60
const DEFAULT_MAX_SENTENCES_FOR_FORCE_1 = 1
const DEFAULT_P_ONE = 0.65
/** When reply is ≥ this many chars AND has ≥3 sentences, p_two is bumped to 0.5. */
const LONG_REPLY_CHAR_THRESHOLD = 100

export function decideReplySplit(
  reply: string,
  opts: DecideReplySplitOptions = {}
): SplitDecision {
  const {
    seed,
    pOne = DEFAULT_P_ONE,
    minCharsForSplit = DEFAULT_MIN_CHARS_FOR_SPLIT,
    maxSentencesForForce1 = DEFAULT_MAX_SENTENCES_FOR_FORCE_1,
    guardHotline = true,
  } = opts

  // Empty reply: degenerate but legal — preserve to keep enqueueOutbound
  // contract happy (callers may downstream-check for empty body separately).
  if (!reply || reply.length === 0) {
    return { count: 1, parts: [reply ?? ""], reason: "empty" }
  }

  // Hotline guard FIRST — crisis turns must never be split (P0 §3.1).
  if (guardHotline && looksLikeHotlineTrailer(reply)) {
    return { count: 1, parts: [reply], reason: "hotline_trailer_force_1" }
  }

  if (looksLikeMem0DegradedNotice(reply)) {
    return { count: 1, parts: [reply], reason: "mem0_marker_force_1" }
  }

  // Length/sentence force-1 gates.
  if (reply.length < minCharsForSplit) {
    return { count: 1, parts: [reply], reason: "short_force_1" }
  }
  const sentences = countSentences(reply)
  if (sentences <= maxSentencesForForce1) {
    return { count: 1, parts: [reply], reason: "single_sentence_force_1" }
  }

  // Search for split candidates.
  const candidates = findSplitCandidates(reply)
  if (candidates.length === 0) {
    return { count: 1, parts: [reply], reason: "no_split_point" }
  }

  // Probability adjustment: long replies skew toward 2.
  const isLong =
    reply.length > LONG_REPLY_CHAR_THRESHOLD && sentences >= 3
  const effectivePOne = isLong ? Math.min(pOne, 0.5) : pOne

  const rng = buildRng(seed)
  const draw = rng()
  const wantsTwo = draw >= effectivePOne

  if (!wantsTwo) {
    return {
      count: 1,
      parts: [reply],
      reason: isLong ? "weighted_random_1" : "weighted_random_1",
    }
  }

  // Take the top candidate (already sorted: tier desc, then center proximity).
  const cut = candidates[0]!
  const partA = reply.slice(0, cut.index).trimEnd()
  const partB = reply.slice(cut.index).trimStart()

  // Defensive: if either part is empty after trim, fall back to count=1
  // (shouldn't happen given position constraint but cheap safety).
  if (partA.length === 0 || partB.length === 0) {
    return { count: 1, parts: [reply], reason: "no_split_point" }
  }

  return {
    count: 2,
    parts: [partA, partB],
    reason: isLong ? "long_high_prob_2" : "weighted_random_2",
    splitAtIndex: cut.index,
  }
}

// ---------------------------------------------------------------------------
// Test helpers (exported for unit tests; not part of stable public API)
// ---------------------------------------------------------------------------

export const __testing = {
  buildRng,
  foldStringToUint32,
  findSplitCandidates,
  looksLikeHotlineTrailer,
  looksLikeMem0DegradedNotice,
}
