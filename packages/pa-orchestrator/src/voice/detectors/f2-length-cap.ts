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
