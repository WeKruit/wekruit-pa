/**
 * Phase 37 T1 — Rule-based 5-class UX state classifier.
 *
 * NO LLM (D6 — FiSMiness baseline). Pure regex + lexicon scan.
 * Bilingual zh + en + mixed code-switch.
 *
 * Algorithm:
 * 1. Normalize input (lowercase, strip extra whitespace)
 * 2. For each of 5 UX states, walk its zh + en + symbol lexicons
 *    counting hits. Each hit contributes a per-class weight.
 * 3. Apply structural signals (question density, sentence count,
 *    punctuation density) as multiplicative bumps.
 * 4. Apply gravity tie-break (heavy states win on ties).
 * 5. Default `WarmCurious` when total signal < threshold.
 *
 * Latency budget: < 5ms per call (asserted in tests).
 */

import type {
  UxState,
  UxStateClassifierResult,
} from "./types.js"
import { UX_STATE_GRAVITY_ORDER, UX_STATES } from "./types.js"

// ---------------------------------------------------------------------------
// Lexicon banks per CONTEXT D-37-1.
// Keep weights modest (1-3) so structural signals (question density, sentence
// count) can dominate when warranted.
// ---------------------------------------------------------------------------

interface LexiconEntry {
  /** Substring (case-insensitive for en, raw for zh). */
  term: string
  /** Per-hit score contribution. */
  weight: number
}

const LEXICON: Record<UxState, { zh: LexiconEntry[]; en: LexiconEntry[]; symbols: LexiconEntry[] }> = {
  WarmCurious: {
    zh: [
      { term: "你好", weight: 2 },
      { term: "嗨", weight: 2 },
      { term: "在吗", weight: 2 },
      { term: "想问", weight: 1.5 },
      { term: "请问", weight: 1.5 },
      { term: "好奇", weight: 1.5 },
      { term: "怎么样", weight: 1 },
      { term: "可以吗", weight: 1 },
    ],
    en: [
      { term: "hi ", weight: 2 },
      { term: "hey ", weight: 2 },
      { term: "hello", weight: 2 },
      { term: "wondering", weight: 1.5 },
      { term: "curious", weight: 1.5 },
      { term: "can you", weight: 1 },
      { term: "could you", weight: 1 },
    ],
    symbols: [],
  },
  PlayfulTease: {
    zh: [
      { term: "哈哈", weight: 2 },
      { term: "笑死", weight: 3 },
      { term: "你逗", weight: 2 },
      { term: "666", weight: 2 },
      { term: "梗", weight: 1.5 },
      { term: "皮一下", weight: 2 },
      { term: "开玩笑", weight: 2 },
      { term: "扯", weight: 1 },
    ],
    en: [
      { term: " lol", weight: 2 },
      { term: "lol ", weight: 2 },
      { term: "lmao", weight: 2.5 },
      { term: "haha", weight: 2 },
      { term: "kidding", weight: 2 },
      { term: " jk", weight: 2 },
      { term: "ngl", weight: 1.5 },
    ],
    symbols: [
      { term: "🤣", weight: 3 },
      { term: "😂", weight: 3 },
      { term: "😜", weight: 2 },
      { term: "😉", weight: 1.5 },
    ],
  },
  SoftConcerned: {
    zh: [
      { term: "累", weight: 2 },
      { term: "难", weight: 1.5 },
      { term: "不知道", weight: 1.5 },
      { term: "怀疑", weight: 2 },
      { term: "焦虑", weight: 2.5 },
      { term: "心慌", weight: 2.5 },
      { term: "委屈", weight: 2.5 },
      { term: "担心", weight: 2 },
      { term: "怎么办", weight: 2 },
      { term: "唉", weight: 1.5 },
      { term: "心累", weight: 2.5 },
      { term: "压力", weight: 2 },
    ],
    en: [
      { term: "tired", weight: 2 },
      { term: "stressed", weight: 2.5 },
      { term: "anxious", weight: 2.5 },
      { term: "worried", weight: 2 },
      { term: "dunno", weight: 1.5 },
      { term: "not sure", weight: 1.5 },
      { term: "overwhelmed", weight: 2.5 },
      { term: "rough", weight: 1.5 },
      { term: " hard", weight: 1.5 },
      { term: "burnt out", weight: 2.5 },
    ],
    symbols: [
      { term: "😔", weight: 2 },
      { term: "😢", weight: 2 },
      { term: "😞", weight: 2 },
    ],
  },
  FirmDirect: {
    zh: [
      { term: "怎么做", weight: 2.5 },
      { term: "该不该", weight: 2.5 },
      { term: "帮我决定", weight: 3 },
      { term: "必须", weight: 2 },
      { term: "要不要", weight: 2 },
      { term: "建议", weight: 1.5 },
      { term: "给我", weight: 1.5 },
      { term: "告诉我", weight: 2 },
      { term: "需要", weight: 1 },
      { term: "立刻", weight: 2 },
    ],
    en: [
      { term: "should i", weight: 2.5 },
      { term: "what do i do", weight: 3 },
      { term: "help me decide", weight: 3 },
      { term: "need advice", weight: 2.5 },
      { term: "tell me", weight: 2 },
      { term: "give me", weight: 1.5 },
      { term: "must ", weight: 1.5 },
      { term: "have to ", weight: 1.5 },
    ],
    symbols: [],
  },
  QuietWitness: {
    zh: [
      { term: "想死", weight: 4 },
      { term: "不想活", weight: 4 },
      { term: "撑不住", weight: 3 },
      { term: "想消失", weight: 3.5 },
      { term: "没意义", weight: 3 },
      { term: "绝望", weight: 3 },
      { term: "崩溃", weight: 3 },
      { term: "哭", weight: 2 },
      { term: "走不下去", weight: 3 },
      { term: "撑不下去", weight: 3 },
    ],
    en: [
      { term: "cant go on", weight: 4 },
      { term: "can't go on", weight: 4 },
      { term: "want to die", weight: 4 },
      { term: "wanna die", weight: 4 },
      { term: "hopeless", weight: 3 },
      { term: "broken", weight: 2 },
      { term: "give up", weight: 2.5 },
      { term: "no point", weight: 3 },
      { term: "crying", weight: 2 },
    ],
    symbols: [],
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isCjkChar(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x3000 && codePoint <= 0x303f)
  )
}

/** Detect language based on CJK vs ASCII letter ratio. */
function detectLang(text: string): "zh" | "en" {
  if (!text) return "en"
  let cjk = 0
  let ascii = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (isCjkChar(cp)) cjk += 1
    else if (cp < 128 && /[a-zA-Z]/.test(ch)) ascii += 1
  }
  return cjk > ascii ? "zh" : "en"
}

/**
 * Count "sentences" via a coarse split — both zh terminators (。！？) and
 * en terminators (.!?). Sufficient for question-density + length signals.
 */
function countSentences(text: string): number {
  if (!text || !text.trim()) return 0
  const matches = text.match(/[^。！？.!?]+[。！？.!?]+/g)
  if (matches && matches.length > 0) return matches.length
  // No terminator at all → 1 sentence.
  return 1
}

function countQuestions(text: string): number {
  if (!text) return 0
  const matches = text.match(/[?？]/g)
  return matches ? matches.length : 0
}

function countHeavyNegative(text: string, lang: "zh" | "en"): number {
  let n = 0
  const bank = LEXICON.QuietWitness
  const lower = text.toLowerCase()
  if (lang === "zh") {
    for (const e of bank.zh) if (text.includes(e.term)) n += 1
  } else {
    for (const e of bank.en) if (lower.includes(e.term)) n += 1
  }
  return n
}

function scoreLexiconBank(
  text: string,
  bank: LexiconEntry[],
  matchedOut: string[],
  lower = false
): number {
  if (!text) return 0
  const haystack = lower ? text.toLowerCase() : text
  let score = 0
  for (const entry of bank) {
    if (haystack.includes(entry.term)) {
      score += entry.weight
      matchedOut.push(entry.term.trim())
    }
  }
  return score
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Lower bound for "any signal fired". Below → fall back to WarmCurious. */
const MIN_SIGNAL_FOR_NON_DEFAULT = 1.0

/**
 * Classify the user's UX state from this turn (+ optional history context
 * — currently unused beyond the current turn; Phase 38 extends).
 *
 * @param turn       `{ user: string }` — current user message
 * @param _history   `{ userTurns?: string[] }` — reserved for Phase 38
 * @returns          `{ uxState, confidence, signals }`
 */
export function classifyUxState(
  turn: { user: string },
  _history?: { userTurns?: string[] }
): UxStateClassifierResult {
  const text = (turn?.user ?? "").trim()

  const matched: string[] = []
  const scores: Record<UxState, number> = {
    WarmCurious: 0,
    PlayfulTease: 0,
    SoftConcerned: 0,
    FirmDirect: 0,
    QuietWitness: 0,
  }

  if (!text) {
    return {
      uxState: "WarmCurious",
      confidence: 0,
      signals: { matched, scores },
    }
  }

  const lang = detectLang(text)

  // 1. Lexicon scoring per state.
  for (const state of UX_STATES) {
    const bank = LEXICON[state]
    // zh side — case-sensitive (CJK); en side — lowercase; symbols — raw.
    scores[state] += scoreLexiconBank(text, bank.zh, matched, false)
    scores[state] += scoreLexiconBank(text, bank.en, matched, true)
    scores[state] += scoreLexiconBank(text, bank.symbols, matched, false)
  }

  // 2. Structural signals.
  const sentences = countSentences(text)
  const questions = countQuestions(text)
  const questionDensity = sentences > 0 ? questions / sentences : 0
  const heavyNeg = countHeavyNegative(text, lang)

  // 2a. Question density boosts WarmCurious + FirmDirect.
  if (questionDensity >= 0.3) {
    scores.WarmCurious += 1.0
    if (questions >= 2) scores.FirmDirect += 0.5
  }

  // 2b. Exclamation density + positive lexicon → PlayfulTease.
  const exclamCount = (text.match(/[!！]/g) || []).length
  if (exclamCount >= 1 && (scores.PlayfulTease > 0 || scores.WarmCurious > 0)) {
    scores.PlayfulTease += 0.5 * Math.min(exclamCount, 3)
  }

  // 2c. QuietWitness override — long + zero questions + ≥2 heavy-negative hits.
  // CONTEXT §6 risk: don't false-trigger QuietWitness on plain venting.
  if (sentences >= 3 && questions === 0 && heavyNeg >= 2) {
    // Heavy boost — overrides SoftConcerned per gravity rule.
    scores.QuietWitness += 3.0
  }

  // 2d. Imperative density → FirmDirect (zh: 帮我/告诉我; en: tell me/show me already in lexicon)
  // Already covered by lexicon; structural signal redundant.

  // 3. Pick winner with gravity tie-break.
  let winner: UxState = "WarmCurious"
  let winnerScore = -Infinity
  for (const state of UX_STATE_GRAVITY_ORDER) {
    if (scores[state] > winnerScore) {
      winner = state
      winnerScore = scores[state]
    }
    // Equal score → first in gravity order wins (already handled by walk order).
  }

  // 4. Default fallback when total signal too weak.
  if (winnerScore < MIN_SIGNAL_FOR_NON_DEFAULT) {
    winner = "WarmCurious"
    winnerScore = Math.max(winnerScore, 0)
  }

  // 5. Normalize confidence to 0..1 against a soft cap of 6.
  const confidence = Math.min(1, Math.max(0, winnerScore / 6))

  return {
    uxState: winner,
    confidence,
    signals: {
      matched: Array.from(new Set(matched)),
      scores,
    },
  }
}
