/**
 * Adam iter 20 — phrase repeat stripper (Claire self-repetition).
 *
 * Iter 19's 10-turn anxious_grad sim surfaced 5 consecutive Claire replies
 * starting with the SAME phrase across turns 3,5,7,11,13:
 *   "要不要试试把..."
 *   "要不要试 试试把..."
 *   "要不要试试把..."
 *   "要不要试着先..."
 *   "要不要试试把..."
 *
 * Existing modules don't catch this:
 *   - stripRepeatOpener (llm-rewriter.ts:263) — only checks last-2 prior
 *     replies AND only first clause (before terminator). Pattern slipped
 *     because in some turns it was preceded by "感觉挺磨人的。" so the
 *     opener clause was different but the pattern after the period repeated.
 *   - F1 verb-mirror detector — measures user→Claire mirror, NOT
 *     Claire→Claire self-mirror.
 *   - F4 advice-repeat — semantic embedding similarity over advice content
 *     vs syntactic phrase repetition (different surface).
 *
 * This module fills the gap: scan for any 4+ char phrase that appears in
 * BOTH the current reply (in the first 30 chars) AND any of the last-N
 * (default 5) prior Claire replies (anywhere). Strip the longest match.
 *
 * BILINGUAL: zh chars and en multi-word phrases both work — substring
 * match is char-based (works for CJK) and ascii-words form valid windows.
 *
 * SAFETY:
 * - Don't strip if remaining text < 10 chars (avoid nuking whole reply).
 * - Don't strip phrases shorter than 4 chars (too generic — false positive).
 * - Only check first 30 chars of current reply (we want OPENER repetition
 *   not random mid-sentence overlap).
 *
 * COST: O(N×M×W) where N=prior replies, M=current first-30 chars window,
 * W=4-12 char phrase length range. Sub-millisecond in practice.
 */

const DEFAULT_PRIOR_REPLIES = 5
const DEFAULT_WINDOW_CHARS = 30
const DEFAULT_MIN_PHRASE_CHARS = 4
const DEFAULT_MAX_PHRASE_CHARS = 12
const DEFAULT_MIN_REMAINING = 10

export type PhraseStripDecision = {
  stripped: boolean
  text: string
  matched_phrase?: string
  matched_in_priors?: number
}

/**
 * Find the longest substring of `text` (within first `windowChars`) that
 * also appears anywhere in any of `priors`. Returns null if no match
 * meets minPhrase threshold.
 *
 * Greedy: tries longest phrase first (maxPhrase chars), shrinks down.
 * Returns the FIRST length×offset match found (left-to-right preference).
 */
/**
 * V2 QA Agent-B 2026-05-04 P0 fix: pre-fix slicing was raw character
 * windows, no word-boundary awareness for ASCII. Production replies got
 * shredded mid-token: "I sawr resume" (saw your), "How much dowant" (do
 * you want), "rejected bythis morning" (by Meta this) because the strip
 * cut "saw your" → "saw " stripped, "your r" left → "ywant" etc. CJK is
 * char-based by nature so word-boundary doesn't apply, but for ASCII we
 * MUST snap match boundaries to whitespace/punctuation.
 *
 * Strategy:
 *   1. Detect candidate phrase as before (substring of head[].
 *   2. Reject candidate if it starts/ends mid-ASCII-word (i.e. the char
 *      before offset OR the char after offset+len is an ASCII letter
 *      while the boundary char itself is also an ASCII letter).
 *   3. CJK-only candidates pass unchanged (chars are single-token-glyphs).
 */
function isAsciiWord(ch: string): boolean {
  return /[a-zA-Z0-9]/.test(ch)
}

function snapToWordBoundary(
  text: string,
  offset: number,
  len: number
): boolean {
  // Left boundary: char BEFORE offset must NOT be an ASCII word char if
  // the FIRST char of the candidate is. Allow start-of-string.
  if (offset > 0) {
    const before = text.charAt(offset - 1)
    const first = text.charAt(offset)
    if (isAsciiWord(before) && isAsciiWord(first)) return false
  }
  // Right boundary: char AFTER candidate must NOT be ASCII word char if
  // the LAST char of the candidate is. Allow end-of-string.
  const end = offset + len
  if (end < text.length) {
    const last = text.charAt(end - 1)
    const after = text.charAt(end)
    if (isAsciiWord(last) && isAsciiWord(after)) return false
  }
  return true
}

function findLongestRepeatedPhrase(
  text: string,
  priors: string[],
  opts: {
    windowChars: number
    minPhrase: number
    maxPhrase: number
  }
): { phrase: string; offset: number; matchedInPriors: number } | null {
  const head = text.slice(0, opts.windowChars)
  for (let len = Math.min(opts.maxPhrase, head.length); len >= opts.minPhrase; len--) {
    for (let i = 0; i + len <= head.length; i++) {
      const candidate = head.slice(i, i + len)
      // Skip whitespace-only / pure punctuation candidates.
      if (!/[a-zA-Z0-9一-鿿]/.test(candidate)) continue
      // V2 QA Agent-B fix: word-boundary snap. Raw substring slicing
      // produced "I sawr resume" / "rejected bythis morning" in prod.
      if (!snapToWordBoundary(text, i, len)) continue
      let matchedInPriors = 0
      for (const prior of priors) {
        if (prior.includes(candidate)) matchedInPriors++
      }
      if (matchedInPriors > 0) {
        return { phrase: candidate, offset: i, matchedInPriors }
      }
    }
  }
  return null
}

/**
 * Strip repeated phrase from current reply if found. See module docstring
 * for algorithm. Returns { stripped, text, ... } — `text` is the cleaned
 * version (or original if no strip happened).
 *
 * Public API contract:
 * - Idempotent: re-running on output yields same output.
 * - Pure: no env reads, no I/O, no async.
 * - Fail-open: empty/short input returns input unchanged.
 */
export function stripPhraseRepeat(
  currentReply: string,
  priorReplies: readonly string[],
  opts?: {
    priorN?: number
    windowChars?: number
    minPhrase?: number
    maxPhrase?: number
    minRemaining?: number
  }
): PhraseStripDecision {
  const trimmed = (currentReply ?? "").trim()
  if (trimmed.length === 0) {
    return { stripped: false, text: trimmed }
  }
  const priorN = opts?.priorN ?? DEFAULT_PRIOR_REPLIES
  const windowChars = opts?.windowChars ?? DEFAULT_WINDOW_CHARS
  const minPhrase = opts?.minPhrase ?? DEFAULT_MIN_PHRASE_CHARS
  const maxPhrase = opts?.maxPhrase ?? DEFAULT_MAX_PHRASE_CHARS
  const minRemaining = opts?.minRemaining ?? DEFAULT_MIN_REMAINING

  const priors = (priorReplies ?? [])
    .filter((p) => typeof p === "string" && p.length > 0)
    .slice(-priorN)
  if (priors.length === 0) {
    return { stripped: false, text: trimmed }
  }

  const match = findLongestRepeatedPhrase(trimmed, priors, {
    windowChars,
    minPhrase,
    maxPhrase,
  })
  if (!match) {
    return { stripped: false, text: trimmed }
  }
  // Strip from offset to end of phrase + any trailing separators/whitespace.
  const before = trimmed.slice(0, match.offset)
  // After stripping, also drop leading Chinese-particle artifacts like
  // 的/了/啊/呗/吧/嘛/呀/嗯/哦 — they're grammar-tail of the stripped
  // phrase, not standalone sentence starts. Without this, "要不要试试看的，
  // X" → strip "要不要试试看" → "的，X" (nonsense).
  const after = trimmed
    .slice(match.offset + match.phrase.length)
    .replace(/^[\s，,。.;；!！？?…]+/, "")
    .replace(/^[的了啊呗吧嘛呀嗯哦]+/, "")
    .replace(/^[\s，,。.;；!！？?…]+/, "")
  const result = (before + after).trim()
  if (result.length < minRemaining) {
    // Removal would nuke the reply. Fail-open.
    return { stripped: false, text: trimmed }
  }
  return {
    stripped: true,
    text: result,
    matched_phrase: match.phrase,
    matched_in_priors: match.matchedInPriors,
  }
}
