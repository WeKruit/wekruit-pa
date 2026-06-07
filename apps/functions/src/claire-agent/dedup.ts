/**
 * dedup.ts — pure near-duplicate suppression util for the delivery seam (Adam R1, 2026-06-04).
 *
 * Adam's rule: ABSOLUTE no duplicate message, INCLUDING SIMILAR. Not just byte-identical —
 * "still pulling your info, one sec 🔎" and "still pulling your info—give me a sec 🔍" are
 * SIMILAR and BOTH must not go out. On a near-dup, DROP it (send nothing); never substitute a
 * hallucinated variant.
 *
 * This module is PURE: no Firestore, no I/O, no SDK. The delivery layer (delivery.ts) owns the
 * Firestore read of recent sent messages and the integration; this file only normalizes + scores
 * similarity so it is trivially unit-testable and reusable.
 *
 * Two complementary signals:
 *   1. Exact normalized equality — catches the live "still pulling … one sec" emoji-variant bug:
 *      two bodies that normalize to the same text (different emoji / punctuation / casing).
 *   2. Token Jaccard >= THRESHOLD — catches near-rewrites that share most of their words but differ
 *      in a few. Only applied when BOTH messages have >= MIN_TOKENS_FOR_JACCARD tokens, so short
 *      distinct acks ("ok", "yes", "got it") are never fuzzy-matched — they only collide on exact
 *      normalized equality.
 */

/**
 * Token-overlap threshold for the Jaccard near-dup test. 0.8 = 80% of the COMBINED word set must be
 * shared. Conservative on purpose: two genuinely-different sentences rarely share 80% of their words,
 * so false-positives (dropping a legitimately-distinct message) are unlikely, while emoji/punctuation/
 * minor-reword variants of the SAME message comfortably clear it.
 */
export const JACCARD_THRESHOLD = 0.85

/**
 * Token-CONTAINMENT threshold: |A ∩ B| / |smaller set|. Catches the "same message, reworded" case that
 * Jaccard misses when the two phrasings differ in LENGTH — e.g. the live pair Adam named:
 *   "still pulling your info, one sec 🔎"        → {still,pulling,your,info,one,sec}        (6)
 *   "still pulling your info—give me a sec 🔍"   → {still,pulling,your,info,give,me,a,sec}  (8)
 * Jaccard = 5/9 = 0.56 (misses), but containment = 5/6 = 0.83 (catches). Requires a strong shared
 * common PREFIX too (below) so it doesn't flag two messages that merely happen to reuse common words.
 */
export const CONTAINMENT_THRESHOLD = 0.8

/**
 * Minimum shared leading-token run (after normalization) required to ACTIVATE the containment signal.
 * Both of Adam's "still pulling your info…" lines share a 4-word opener; a genuinely-different message
 * almost never shares a 4-word prefix with a recent one. This is the guard that keeps containment from
 * over-suppressing two distinct messages that coincidentally share many common/stopword tokens.
 */
export const MIN_SHARED_PREFIX_TOKENS = 3

/**
 * Messages shorter than this (in tokens) are NOT eligible for fuzzy Jaccard matching — they only
 * collide on exact normalized equality. Prevents short acks like "ok" / "yes" / "let me know" from
 * being treated as near-dups of each other just because their tiny token sets overlap.
 */
export const MIN_TOKENS_FOR_JACCARD = 4

/**
 * Normalize a message for near-duplicate comparison.
 *   - lowercase
 *   - strip emoji / pictographs
 *   - strip punctuation (replace with space so word boundaries survive)
 *   - collapse whitespace runs to a single space, trim
 *
 * The result is a clean lowercase token stream suitable for both exact-equality and token-set
 * comparison. NOTE: this is intentionally lossy (drops emoji + punctuation) — that is exactly what
 * makes "one sec 🔎" and "one sec 🔍" compare equal.
 */
export function normalizeForComparison(msg: string): string {
  let s = String(msg ?? "").toLowerCase().trim()
  // Strip emoji + extended pictographs (needs the "u" flag). Replace with a space so an emoji that
  // sat between two words doesn't fuse them.
  s = s.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, " ")
  // Strip the variation-selector + zero-width joiner that ride along with composed emoji sequences.
  s = s.replace(/[‍️︎]/g, " ")
  // Replace punctuation / dashes / quotes with a space (keep word boundaries).
  s = s.replace(/[.,!?;:—–\-_'"“”‘’`()\[\]{}<>/\\|@#$%^&*+=~]/g, " ")
  // Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim()
  return s
}

/** Tokenize a normalized string into a word array (empty-safe). */
function tokenize(normalized: string): string[] {
  return normalized.split(" ").filter(Boolean)
}

/** |A ∩ B| of two token arrays' SETS. */
function tokenIntersectionSize(tokens1: string[], tokens2: string[]): number {
  const set2 = new Set(tokens2)
  let n = 0
  const seen = new Set<string>()
  for (const t of tokens1) {
    if (seen.has(t)) continue
    seen.add(t)
    if (set2.has(t)) n++
  }
  return n
}

/**
 * Token Jaccard similarity of two already-normalized strings: |A ∩ B| / |A ∪ B| over their token
 * SETS (duplicate words within one message collapse). 1.0 = identical token sets, 0 = disjoint.
 * Exported for testing / tuning.
 */
export function tokenJaccard(n1: string, n2: string): number {
  const set1 = new Set(tokenize(n1))
  const set2 = new Set(tokenize(n2))
  if (set1.size === 0 && set2.size === 0) return 1
  let intersection = 0
  for (const t of set1) if (set2.has(t)) intersection++
  const union = set1.size + set2.size - intersection
  return union > 0 ? intersection / union : 0
}

/**
 * Token containment: |A ∩ B| / |smaller set|. Exported for testing / tuning. 1.0 = the smaller
 * message's words are all present in the larger one.
 */
export function tokenContainment(n1: string, n2: string): number {
  const t1 = tokenize(n1)
  const t2 = tokenize(n2)
  const set1size = new Set(t1).size
  const set2size = new Set(t2).size
  const smaller = Math.min(set1size, set2size)
  if (smaller === 0) return 0
  return tokenIntersectionSize(t1, t2) / smaller
}

/** Length of the shared leading-token run between two normalized strings. */
function sharedPrefixTokenCount(n1: string, n2: string): number {
  const t1 = tokenize(n1)
  const t2 = tokenize(n2)
  const max = Math.min(t1.length, t2.length)
  let i = 0
  while (i < max && t1[i] === t2[i]) i++
  return i
}

/**
 * Decide whether two messages are near-duplicates (Adam R1: "including SIMILAR").
 *
 *   1. Exact normalized equality → duplicate (emoji/punctuation/case-only variants of one message).
 *   2. Otherwise, IF both messages have >= MIN_TOKENS_FOR_JACCARD tokens, token Jaccard >= threshold
 *      → near-dup. Short messages skip step 2 and only count step 1, so distinct short acks survive.
 */
export function isNearDuplicate(
  msg1: string,
  msg2: string,
  threshold: number = JACCARD_THRESHOLD,
): boolean {
  const n1 = normalizeForComparison(msg1)
  const n2 = normalizeForComparison(msg2)

  // Empty normalized strings are not meaningful content to dedup.
  if (!n1 || !n2) return false

  // (1) exact normalized equality — strongest, applies regardless of length.
  if (n1 === n2) return true

  // (2) fuzzy signals — only for messages long enough that overlap is meaningful (both >= 4 tokens).
  const tokens1 = tokenize(n1)
  const tokens2 = tokenize(n2)
  if (tokens1.length < MIN_TOKENS_FOR_JACCARD || tokens2.length < MIN_TOKENS_FOR_JACCARD) {
    return false
  }

  // (2a) Jaccard over the COMBINED word set — catches near-rewrites that share most words.
  if (tokenJaccard(n1, n2) >= threshold) return true

  // NOTE (Adam 2026-06-04, review): a CONTAINMENT + shared-prefix branch was tried to catch the
  // different-LENGTH reword ("still pulling your info, one sec 🔎" vs "…—give me a sec 🔍", Jaccard
  // only 0.56). It was REMOVED: it produced false positives that silently dropped genuinely-DISTINCT
  // short asks differing only in their payload token — "can you share your linkedin" vs "…your resume",
  // "pull product roles" vs "pull design roles" — which are nearly indistinguishable from the target
  // pair on prefix+containment alone. Dropping a distinct ask is a worse bug than missing one near-dup.
  // The recurring near-dup source (the enrichment "still pulling" hold) is instead PINNED to a fixed
  // phrase in prompt.ts, so its repeats are byte-identical → caught by the exact-equality branch above.
  return false
}

/**
 * True if `candidate` is a near-duplicate of ANY message in `priorMessages` (e.g. the recent
 * messages Claire already sent this session). Pure helper so delivery.ts can call it after its
 * (impure) Firestore read. Empty / blank priors are ignored.
 */
export function isNearDuplicateOfAny(
  candidate: string,
  priorMessages: readonly string[],
  threshold: number = JACCARD_THRESHOLD,
): boolean {
  for (const prev of priorMessages) {
    if (isNearDuplicate(candidate, prev, threshold)) return true
  }
  return false
}
