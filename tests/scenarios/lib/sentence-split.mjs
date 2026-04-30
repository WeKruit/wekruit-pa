/**
 * Phase 33 — bilingual sentence splitter (HARNESS-03).
 *
 * Single-pass tokenizer that handles:
 *   - zh terminators 。！？；
 *   - en terminators . ! ?  (whitespace- or EOS-followed only)
 *   - decimal numbers ("3.14") and URLs ("https://x.com") preserved
 *   - common abbreviations ("Dr.", "U.S.", "etc.") preserved
 *   - ellipses (`…`, `...`, `。。。`) treated as a single boundary
 *   - emoji-only or emoji-trailing segments counted as sentences
 *   - paragraph break (≥2 newlines) = sentence boundary
 *
 * Used by the `length_compliance` axis (≤3-sentence cap, F2 detector
 * preview) and by Phase 35 production-side detector. Pure function — no
 * I/O, no async, no dependency.
 */

const ZH_TERMINATORS = new Set(["。", "！", "？", "；"])
const EN_TERMINATORS = new Set([".", "!", "?"])

// Single trailing-period tokens we never split after. Lowercased compare.
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr",
  "st", "etc", "vs", "e.g", "i.e",
  "u.s", "u.k", "u.s.a",
  "no", // "No. 4"
])

function isAsciiDigit(ch) {
  return ch >= "0" && ch <= "9"
}

function isWhitespace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r"
}

/**
 * True when the period at index `i` is part of a decimal number ("3.14")
 * — i.e. surrounded by ASCII digits on both sides.
 */
function isDecimalDot(text, i) {
  const prev = text[i - 1]
  const next = text[i + 1]
  return Boolean(prev && next && isAsciiDigit(prev) && isAsciiDigit(next))
}

/**
 * True when the period at index `i` lives inside a URL run. Cheap heuristic:
 * scan back to the most recent whitespace/start; if that token contains
 * `://` or matches a `domain.tld/`-ish pattern, treat as URL.
 */
function isUrlDot(text, i) {
  let start = i
  while (start > 0 && !isWhitespace(text[start - 1])) start -= 1
  let end = i
  while (end < text.length && !isWhitespace(text[end])) end += 1
  const token = text.slice(start, end)
  if (token.includes("://")) return true
  // www.x.com or x.com/path
  if (/^www\./i.test(token)) return true
  if (/[a-z0-9-]+\.[a-z]{2,}\//i.test(token)) return true
  return false
}

/**
 * True when the period at `i` is the tail of a known abbreviation. We look at
 * up to ~6 chars back from `i` to a word boundary and lowercase-compare to
 * ABBREVIATIONS. Multi-dot abbreviations like "U.S." are treated by
 * stripping inner dots before lookup.
 */
function isAbbreviationDot(text, i) {
  let start = i
  while (start > 0) {
    const ch = text[start - 1]
    if (isWhitespace(ch) || ch === "(" || ch === "[" || ch === "“") break
    start -= 1
    if (i - start > 8) break
  }
  const raw = text.slice(start, i).toLowerCase()
  if (!raw) return false
  // Strip trailing dot variants and inner dots for U.S.A. matching
  const normalized = raw.replace(/\.+$/, "")
  if (ABBREVIATIONS.has(normalized)) return true
  // "U.S." with inner dots — match against dotless form too
  const dotless = normalized.replace(/\./g, "")
  if (ABBREVIATIONS.has(dotless)) return true
  return false
}

/**
 * True when text[i] starts an ellipsis run we should treat as a single
 * boundary marker. Recognizes `…`, `...`, `。。。`. Returns the run length
 * (1, 2, or 3+) so the caller can advance past it.
 */
function ellipsisRunLength(text, i) {
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
 * Split `text` into sentences. Returns an array of trimmed non-empty
 * strings. Empty / whitespace-only input → `[]`.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  if (typeof text !== "string" || text.length === 0) return []
  const out = []
  let buf = ""
  let i = 0
  while (i < text.length) {
    const ch = text[i]

    // Paragraph break = boundary, even mid-sentence-no-terminator
    if (ch === "\n" && text[i + 1] === "\n") {
      if (buf.trim().length > 0) out.push(buf.trim())
      buf = ""
      i += 2
      while (text[i] === "\n") i += 1
      continue
    }

    // Ellipsis (single boundary, swallow trailing)
    const ellipsisN = ellipsisRunLength(text, i)
    if (ellipsisN > 0) {
      buf += text.slice(i, i + ellipsisN)
      if (buf.trim().length > 0) out.push(buf.trim())
      buf = ""
      i += ellipsisN
      // skip immediately-following whitespace so it doesn't become a leading-space
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
      // For `.` only, suppress if decimal/URL/abbreviation
      if (ch === ".") {
        if (isDecimalDot(text, i) || isUrlDot(text, i) || isAbbreviationDot(text, i)) {
          buf += ch
          i += 1
          continue
        }
      }
      // For `!` `?` `.`: terminator only if followed by whitespace, EOS,
      // closing-quote then whitespace/EOS, or another terminator (run like "?!")
      let j = i + 1
      while (j < text.length && (text[j] === "!" || text[j] === "?" || text[j] === ".")) {
        j += 1
      }
      // closing quote/paren after terminator OK
      if (text[j] === "\"" || text[j] === "'" || text[j] === ")" || text[j] === "]" || text[j] === "”") {
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
      // Not a true boundary (e.g. "test.com")
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

/**
 * @param {string} text
 * @returns {number}
 */
export function countSentences(text) {
  return splitSentences(text).length
}

/**
 * @param {string} text
 * @param {number} [cap=3]
 * @returns {boolean}
 */
export function withinSentenceCap(text, cap = 3) {
  return countSentences(text) <= cap
}
