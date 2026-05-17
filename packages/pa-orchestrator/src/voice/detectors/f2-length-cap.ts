/**
 * Phase 35 — F2 length cap detector.
 *
 * Counts sentences in Claire's reply via a TS port of the Phase 33
 * `splitSentences` algorithm. Triggers when count > cap (default 3,
 * matches Bible v7.4 "max 3 sentences for chit-chat" directive).
 *
 * Action: `strip` — wire-in caller truncates to first N sentences.
 *
 * Algorithm parity: matches `tests/scenarios/lib/sentence-split.mjs`
 * single-pass tokenizer (ZH terminators 。！？； + EN terminators .!?
 * with whitespace gating + ellipsis + decimal/URL/abbrev protection).
 *
 * Latency: pure text, < 10ms per call typical.
 */
import type { DetectorContext, DetectorResult } from "./types.js"

const DEFAULT_CAP = 3

const ZH_TERMINATORS = new Set(["。", "！", "？", "；"])
const EN_TERMINATORS = new Set([".", "!", "?"])

const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "etc",
  "vs",
  "e.g",
  "i.e",
  "u.s",
  "u.k",
  "u.s.a",
  "no",
])

function readEnvCap(): number {
  const raw = process.env.PA_F2_SENTENCE_CAP?.trim()
  if (!raw) return DEFAULT_CAP
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CAP
  return Math.floor(n)
}

function isAsciiDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9"
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r"
}

function isDecimalDot(text: string, i: number): boolean {
  const prev = text[i - 1]
  const next = text[i + 1]
  return Boolean(prev && next && isAsciiDigit(prev) && isAsciiDigit(next))
}

function isUrlDot(text: string, i: number): boolean {
  let start = i
  while (start > 0 && !isWhitespace(text[start - 1])) start -= 1
  let end = i
  while (end < text.length && !isWhitespace(text[end])) end += 1
  const token = text.slice(start, end)
  if (token.includes("://")) return true
  if (/^www\./i.test(token)) return true
  if (/[a-z0-9-]+\.[a-z]{2,}\//i.test(token)) return true
  return false
}

function isAbbreviationDot(text: string, i: number): boolean {
  let start = i
  while (start > 0) {
    const ch = text[start - 1]
    if (isWhitespace(ch) || ch === "(" || ch === "[" || ch === "“") break
    start -= 1
    if (i - start > 8) break
  }
  const raw = text.slice(start, i).toLowerCase()
  if (!raw) return false
  const normalized = raw.replace(/\.+$/, "")
  if (ABBREVIATIONS.has(normalized)) return true
  const dotless = normalized.replace(/\./g, "")
  if (ABBREVIATIONS.has(dotless)) return true
  return false
}

function ellipsisRunLength(text: string, i: number): number {
  if (text[i] === "…") {
    let n = 1
    while (text[i + n] === "…") n += 1
    return n
  }
  if (text[i] === "." && text[i + 1] === "." && text[i + 2] === ".") {
    let n = 3
    while (text[i + n] === ".") n += 1
    return n
  }
  if (text[i] === "。" && text[i + 1] === "。" && text[i + 2] === "。") {
    let n = 3
    while (text[i + n] === "。") n += 1
    return n
  }
  return 0
}

/**
 * Split text into sentences. Public for tests + parity audits.
 * Mirrors `tests/scenarios/lib/sentence-split.mjs:splitSentences`.
 */
export function splitSentences(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return []
  const out: string[] = []
  let buf = ""
  let i = 0
  while (i < text.length) {
    const ch = text[i]

    // Paragraph break = boundary
    if (ch === "\n" && text[i + 1] === "\n") {
      if (buf.trim().length > 0) out.push(buf.trim())
      buf = ""
      i += 2
      while (text[i] === "\n") i += 1
      continue
    }

    // Ellipsis (single boundary)
    const ellipsisN = ellipsisRunLength(text, i)
    if (ellipsisN > 0) {
      buf += text.slice(i, i + ellipsisN)
      if (buf.trim().length > 0) out.push(buf.trim())
      buf = ""
      i += ellipsisN
      while (i < text.length && isWhitespace(text[i])) i += 1
      continue
    }

    if (ZH_TERMINATORS.has(ch)) {
      buf += ch
      if (buf.trim().length > 0) out.push(buf.trim())
      buf = ""
      i += 1
      while (i < text.length && isWhitespace(text[i])) i += 1
      continue
    }

    if (EN_TERMINATORS.has(ch)) {
      if (ch === ".") {
        if (isDecimalDot(text, i) || isUrlDot(text, i) || isAbbreviationDot(text, i)) {
          buf += ch
          i += 1
          continue
        }
      }
      let j = i + 1
      while (j < text.length && (text[j] === "!" || text[j] === "?" || text[j] === ".")) {
        j += 1
      }
      if (
        text[j] === '"' ||
        text[j] === "'" ||
        text[j] === ")" ||
        text[j] === "]" ||
        text[j] === "”"
      ) {
        j += 1
      }
      const after = text[j]
      const isBoundary = j >= text.length || isWhitespace(after)
      if (isBoundary) {
        buf += text.slice(i, j)
        if (buf.trim().length > 0) out.push(buf.trim())
        buf = ""
        i = j
        while (i < text.length && isWhitespace(text[i])) i += 1
        continue
      }
      buf += ch
      i += 1
      continue
    }

    buf += ch
    i += 1
  }
  if (buf.trim().length > 0) out.push(buf.trim())
  return out
}

export function countSentences(text: string): number {
  return splitSentences(text).length
}

/**
 * Strip reply to first N sentences. Used by orchestrator wire-in to enforce
 * F2 cap (Adam iter 17 spec — replies too long, must shorten before prob-split).
 *
 * Returns:
 *   - { stripped: false, text } if input ≤ cap or empty
 *   - { stripped: true, text: kept, original, dropped } if truncation applied
 *
 * Pure, sync, < 10ms. Uses the same splitSentences tokenizer as detectLengthCap
 * so detector trigger ⇒ strip is guaranteed self-consistent.
 */
export function stripToSentenceCap(
  text: string,
  cap?: number
): { stripped: boolean; text: string; original?: string; dropped?: number } {
  if (typeof text !== "string" || text.length === 0) {
    return { stripped: false, text: text ?? "" }
  }
  const effectiveCap = cap ?? readEnvCap()
  const parts = splitSentences(text)
  if (parts.length <= effectiveCap) {
    return { stripped: false, text }
  }
  const kept = parts.slice(0, effectiveCap).join(" ").trim()
  return {
    stripped: true,
    text: kept,
    original: text,
    dropped: parts.length - effectiveCap,
  }
}

// ---------------------------------------------------------------------------
// Adam iter 19 — F2 char-cap addendum.
//
// iter-17 sentence-cap (count > 3 → strip) doesn't catch the run-on case
// where a single sentence is 200+ chars. Witnessed in anxious_grad sim:
// "我之前确实碰过偏支付/风控那类的职责：核心差别是你不只是把功能跑通...异常链路的闭
// 环一起做出来；比如实时特征/规则命中、黑白名单与策略下发、以及事后追溯都很吃系统
// 设计。" — 1 sentence, 130+ chars, slips through sentence-cap.
//
// Spec (Adam iter 17 + iter 19 combined):
//   "需要缩短一下reply，如果一个reply太长我们可以分好几句话说"
//   = if total reply length > char-cap, truncate at the last sentence
//     boundary that still fits the budget (no mid-sentence truncation).
//
// Cap defaults: 180 chars total. Configurable via PA_F2_CHAR_CAP env.
// (180 ≈ 3 medium zh sentences ≈ 30-40 en words; aligns with friend-chat
//  iMessage register, not LinkedIn-post register.)
//
// Algorithm:
//   1. If text ≤ cap → no-op.
//   2. Walk sentences, accumulating chars; stop at last sentence that
//      still fits cap.
//   3. If even sentence-1 already > cap → keep sentence-1 verbatim
//      (better to ship one over-cap sentence than zero — fail-open).
// ---------------------------------------------------------------------------

const DEFAULT_CHAR_CAP = 180

/**
 * Detect "structured" replies — numbered/multi-step plans where caps would
 * destroy content the user explicitly asked for (CV plan, interview prep
 * checklist, multi-step roadmap). These bypass BOTH sentence-cap and
 * char-cap; let prob-split + iMessage normalizer handle multi-bubble
 * delivery instead of strip.
 *
 * Heuristic markers (any one trips):
 *   - English ordinal markers ≥2: "First, ... Second,"
 *   - Numbered list ≥2: "1. ... 2." / "1) ... 2)" / "1: ... 2:"
 *   - Chinese ordinal markers ≥2: "一、二、" / "第一，第二，"
 *   - Bullet list ≥2: "- foo\n- bar"
 *
 * Pure regex, sub-1ms. Conservative — single occurrence doesn't trip
 * (chitchat "first off let me say..." should still cap).
 */
export function isStructuredReply(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false
  const enOrdinal = /\b(First|Second|Third|Fourth|Fifth)[,\s:]/g
  const enMatches = text.match(enOrdinal)
  if (enMatches && enMatches.length >= 2) return true
  if (/\b1[\.\):]\s*.+[\s\S]*?\b2[\.\):]\s*/.test(text)) return true
  const zhOrdinal = /(一、|二、|三、|四、|五、|第一[，,]|第二[，,]|第三[，,])/g
  const zhMatches = text.match(zhOrdinal)
  if (zhMatches && zhMatches.length >= 2) return true
  if (/^\s*[-*•].+\n[\s\S]*?^\s*[-*•]/m.test(text)) return true
  return false
}

function readEnvCharCap(): number {
  const raw = process.env.PA_F2_CHAR_CAP?.trim()
  if (!raw) return DEFAULT_CHAR_CAP
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 40) return DEFAULT_CHAR_CAP
  return Math.floor(n)
}

export function stripToCharCap(
  text: string,
  cap?: number
): { stripped: boolean; text: string; original?: string; droppedChars?: number } {
  if (typeof text !== "string" || text.length === 0) {
    return { stripped: false, text: text ?? "" }
  }
  const effectiveCap = cap ?? readEnvCharCap()
  if (text.length <= effectiveCap) {
    return { stripped: false, text }
  }
  const sentences = splitSentences(text)
  if (sentences.length === 0) {
    return { stripped: false, text }
  }
  // Walk sentences accumulating until next would exceed cap.
  let kept: string[] = []
  let runningLen = 0
  for (const s of sentences) {
    const candidateLen = runningLen + (kept.length > 0 ? 1 : 0) + s.length
    if (candidateLen > effectiveCap) break
    kept.push(s)
    runningLen = candidateLen
  }
  // Fail-open: if no sentence fits, keep sentence-1 anyway.
  if (kept.length === 0) {
    kept = [sentences[0] as string]
  }
  const out = kept.join(" ").trim()
  if (out.length === text.length) {
    return { stripped: false, text }
  }
  return {
    stripped: true,
    text: out,
    original: text,
    droppedChars: text.length - out.length,
  }
}

/**
 * F2 detector entry point. Pure text, sync.
 */
export function detectLengthCap(ctx: DetectorContext): DetectorResult {
  const start = performance.now()
  const cap = ctx.env?.f2SentenceCap ?? readEnvCap()
  const { assistant } = ctx.turn

  if (!assistant) {
    return {
      id: "f2_length_cap",
      triggered: false,
      score: 0,
      reason: "no_input",
      suggested_action: null,
      latencyMs: performance.now() - start,
    }
  }

  const count = countSentences(assistant)
  const triggered = count > cap

  return {
    id: "f2_length_cap",
    triggered,
    score: count,
    reason: triggered
      ? `sentence_count_${count}_>_cap_${cap}`
      : `sentence_count_${count}_<=_cap_${cap}`,
    suggested_action: triggered ? "strip" : null,
    latencyMs: performance.now() - start,
  }
}
