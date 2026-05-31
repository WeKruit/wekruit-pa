/**
 * Phase 19 Adaptive Mirror — deterministic style analyzer.
 *
 * D-02: pure JS heuristics, no model call.
 * D-05: window = last 5 user turns (assistant turns NOT considered).
 * D-08: slang detection reuses Phase 18 VOICE-07 lexicon (slang-lexicon.ts).
 * D-10: exactly 5 features (no more): register_score, zh_char_ratio,
 *       emoji_freq, avg_sentence_len, slang_hits.
 *
 * register_score formula (0=very slangy, 1=very formal):
 *
 *   register_score =
 *       0.40 * text_sentence_len_norm // longer prose sentences read formal
 *     + 0.25 * (1 - slang_density)    // slang hits subtract from formality
 *     + 0.20 * (1 - emoji_density)    // emoji subtract from formality
 *     + 0.15 * formal_punct_density   // full-width + ascii punct signal complete clauses
 *
 * Where:
 *   - text_sentence_len_norm = clamp(avg_text_sentence_len / 40, 0, 1)
 *     (text = non-emoji, non-whitespace chars; ≥40 chars/sentence saturates
 *      as "fully formal" signal. Pure-emoji turns score 0 here.)
 *   - slang_density   = clamp(slang_hits / sample_size, 0, 1)
 *   - emoji_density   = clamp(emoji_freq / 5, 0, 1)
 *     (≥5 emoji per 100 non-ws chars saturates as "fully informal")
 *   - formal_punct_density = clamp(formal_punct_count / sentence_count, 0, 1)
 *
 * Pure-emoji input bottoms out at register_score ≈ 0.25 (slang=0 default
 * lifts that floor), so the threshold for "very slangy" is ≤ 0.3.
 *
 * Empty / whitespace-only input → register_score = 0 (cannot infer formality).
 *
 * Weights chosen heuristically; documented here so eval audits can reproduce.
 * If we re-tune, bump WEIGHTS_VERSION below and note in SUMMARY.
 */
import { countSlangHits } from "./slang-lexicon.js"

export const WEIGHTS_VERSION = "1.0.0"

export interface StyleSnapshot {
  /** 0=very slangy/casual, 1=very formal. */
  register_score: number
  /** 0-1, share of CJK chars vs total non-whitespace chars. */
  zh_char_ratio: number
  /** Emojis per 100 non-whitespace chars (averaged over window). */
  emoji_freq: number
  /** Avg sentence length in chars (sentences split on full-width + ascii terminators). */
  avg_sentence_len: number
  /** Lexicon match count from Phase 18 VOICE-07 list across window. */
  slang_hits: number
  /** Number of user turns observed (0..5). */
  sample_size: number
}

const WINDOW_SIZE = 5

// CJK Unified Ideographs main block. Suggestion in CONTEXT.md.
const CJK_RE = /[\u4e00-\u9fff]/gu
// Extended_Pictographic covers most emoji; not skin-tone modifiers, but
// fine for frequency signal.
const EMOJI_RE = /\p{Extended_Pictographic}/gu
const FORMAL_PUNCT_RE = /[\uff0c\u3002\u3001\uff1b\uff1a,.;:]/gu
const SENTENCE_SPLIT_RE = /[\u3002.!?\uff01\uff1f\n]+/u

function emptySnapshot(): StyleSnapshot {
  return {
    register_score: 0,
    zh_char_ratio: 0,
    emoji_freq: 0,
    avg_sentence_len: 0,
    slang_hits: 0,
    sample_size: 0,
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function countMatches(text: string, re: RegExp): number {
  let count = 0
  // RegExp with /g state is reset per call; use matchAll for purity.
  for (const _ of text.matchAll(re)) count++
  return count
}

export function analyzeUserStyle(userTurns: string[]): StyleSnapshot {
  if (!Array.isArray(userTurns) || userTurns.length === 0) return emptySnapshot()

  // D-05: window = last 5.
  const window = userTurns.slice(-WINDOW_SIZE)
  const sample_size = window.length

  // Aggregate across window. Joining for batch counts is cheaper than
  // per-turn loops and produces the same totals (counts are linear).
  const joined = window.join("\n")
  const nonWs = joined.replace(/\s+/g, "")
  const totalChars = nonWs.length

  if (totalChars === 0) {
    return { ...emptySnapshot(), sample_size }
  }

  const cjkCount = countMatches(joined, CJK_RE)
  const emojiCount = countMatches(joined, EMOJI_RE)
  const formalPunctCount = countMatches(joined, FORMAL_PUNCT_RE)
  const slang_hits = countSlangHits(joined)

  const zh_char_ratio = clamp01(cjkCount / totalChars)
  const emoji_freq = (emojiCount / totalChars) * 100

  // Sentence split: split each turn separately then sum non-empty pieces.
  // We track BOTH raw sentence chars (for avg_sentence_len) and "text"
  // chars (non-emoji, non-whitespace) for register_score, so pure-emoji
  // turns don't read as long-form prose.
  let sentenceCount = 0
  let sentenceCharTotal = 0
  let sentenceTextCharTotal = 0
  for (const turn of window) {
    const trimmed = turn.trim()
    if (!trimmed) continue
    const pieces = trimmed
      .split(SENTENCE_SPLIT_RE)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    if (pieces.length === 0) {
      // The turn was all-punctuation; treat as 1 zero-length sentence.
      sentenceCount += 1
    } else {
      sentenceCount += pieces.length
      for (const p of pieces) {
        sentenceCharTotal += p.length
        const textOnly = p.replace(EMOJI_RE, "").replace(/\s+/g, "")
        sentenceTextCharTotal += textOnly.length
      }
    }
  }
  const avg_sentence_len = sentenceCount > 0 ? sentenceCharTotal / sentenceCount : 0
  const avg_text_sentence_len = sentenceCount > 0 ? sentenceTextCharTotal / sentenceCount : 0

  // register_score blend.
  const text_sentence_len_norm = clamp01(avg_text_sentence_len / 40)
  const slang_density = clamp01(slang_hits / Math.max(1, sample_size))
  const emoji_density = clamp01(emoji_freq / 5)
  const formal_punct_density =
    sentenceCount > 0 ? clamp01(formalPunctCount / sentenceCount) : 0

  const register_score = clamp01(
    0.40 * text_sentence_len_norm +
      0.25 * (1 - slang_density) +
      0.20 * (1 - emoji_density) +
      0.15 * formal_punct_density
  )

  return {
    register_score,
    zh_char_ratio,
    emoji_freq,
    avg_sentence_len,
    slang_hits,
    sample_size,
  }
}
