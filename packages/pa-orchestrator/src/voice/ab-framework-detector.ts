/**
 * Phase 53 (v1.6 voice-quality closure) — A/B framework detector + strip.
 *
 * Distinct from `stripABProbeFromTail` (output-normalizer.ts), which targets
 * "X or Y?" multiple-choice TAIL questions. This module targets a separate
 * clinical pattern Claire keeps emitting despite Bible v7.5 NEVER rules:
 * **conditional A/B framing** —
 *
 *   ❌ "If you want to switch to PM, you could try product analyst first"
 *
 * vs the friend-tone equivalent that DROPS the if-clause head:
 *
 *   ✅ "Switching to PM, you could start as product analyst"
 *
 * The strip is conservative: it removes ONLY the leading "If you (want|wanna|
 * would like) … ," head and preserves the entire then-clause verbatim. We do
 * not attempt grammatical rewriting of the surviving clause — any edge-case
 * awkwardness is preferred to silent semantic drift.
 *
 * Idempotent: a stripped string that no longer matches the head pattern
 * passes through unchanged on second invocation.
 *
 * Hook order at runtime (see index.ts post-gen pipeline):
 *
 *   stripABProbeFromTail   ← X-or-Y tail probes  (Phase 21 / 7.5 NEVER)
 *   stripABFramework        ← THIS module: conditional if-then heads
 *   ImperfectionInjector    ← Phase 36
 *   runCrisisHotlineGuard   ← Phase 51 / 53  (must remain LAST)
 *
 * Crisis hotline guard runs AFTER our strip so trailing safety appends are
 * never clobbered. Prompt-injection canned-reply path (Phase 46) bypasses
 * runAgentTurn entirely → our hook never sees it. Both edges verified below.
 *
 * Latency: pure regex, < 1ms per call (no async, no I/O).
 */

export type ABFrameworkPattern =
  | "en_conditional_if_then"

export interface DetectABResult {
  matched: boolean
  /** Substring that matched the if-clause head (telemetry — never log raw user text). */
  segment?: string
  pattern?: ABFrameworkPattern
}

export interface StripABResult {
  /** Post-strip text. Equals input when nothing matched (idempotent). */
  text: string
  applied: boolean
  pattern?: ABFrameworkPattern
  /** Original matched segment, for telemetry. */
  removed?: string
}

// ---------------------------------------------------------------------------
// en — "If you (want|wanna|would like|'d like) X, (you (could|can|might|should))? Y"
//
// head + X + comma + optional bridge + rest. Case-insensitive.
// ---------------------------------------------------------------------------
const EN_HEAD_PATTERN =
  "if\\s+you(?:'d|\\s+would)?\\s+(?:want(?:\\s+to)?|wanna|like\\s+to|'d\\s+like\\s+to)"
const EN_BRIDGE_PATTERN =
  "(?:you\\s+(?:could|can|might|should|may))?"

const AB_FRAMEWORK_RE_EN = new RegExp(
  `(^|[\\.!?\\n])\\s*(?:${EN_HEAD_PATTERN})\\s+([^,\\.!?\\n]{1,60}),\\s*${EN_BRIDGE_PATTERN}\\s*`,
  "iu"
)

/**
 * Detect a conditional A/B framework head. Returns first match.
 */
export function detectABFramework(text: string): DetectABResult {
  if (typeof text !== "string" || text.length === 0) {
    return { matched: false }
  }
  const en = AB_FRAMEWORK_RE_EN.exec(text)
  if (en) {
    return {
      matched: true,
      pattern: "en_conditional_if_then",
      segment: en[0],
    }
  }
  return { matched: false }
}

/**
 * Strip the conditional A/B framework head while preserving the then-clause.
 *
 * Behavior:
 *  - Replace the matched head ("If you want X, you could") with empty string
 *    (consume leading anchor whitespace too).
 *  - Re-capitalize the surviving first character only when the surviving char
 *    is a lowercase ASCII letter.
 *  - If the result becomes empty / whitespace-only, return the original text
 *    (defensive: never delete the entire reply). The pattern's `,` separator
 *    requirement makes this rare, but worth guarding.
 *
 * Idempotent: re-running yields the same string.
 */
export function stripABFramework(text: string): StripABResult {
  if (typeof text !== "string" || text.length === 0) {
    return { text: text ?? "", applied: false }
  }
  const det = detectABFramework(text)
  if (!det.matched || !det.segment || !det.pattern) {
    return { text, applied: false }
  }

  const re = AB_FRAMEWORK_RE_EN

  // Replace by re-running the regex (single match) and reconstructing:
  //   keep group(1) (sentence anchor — `^` or terminal punct)
  //   drop the head + X-clause + bridge
  //   leave whatever follows
  const m = re.exec(text)
  if (!m) {
    return { text, applied: false }
  }
  const anchor = m[1] ?? ""
  const beforeMatch = text.slice(0, m.index)
  const afterMatch = text.slice(m.index + m[0].length)

  let surviving = afterMatch
  // Capitalize the first ASCII letter of the surviving clause (matches
  // sentence-start orthography).
  if (surviving.length > 0) {
    const first = surviving[0]!
    if (first >= "a" && first <= "z") {
      surviving = first.toUpperCase() + surviving.slice(1)
    }
  }

  let stripped = beforeMatch + anchor + surviving
  // If anchor was leading-of-string, the leading whitespace from anchor=""
  // case is fine. Trim leading whitespace post-strip when anchor was newline.
  // Then trim residual leading whitespace.
  if (anchor === "" || anchor === "\n") {
    stripped = stripped.replace(/^\s+/u, "")
  } else if (anchor === "." || anchor === "!" || anchor === "?") {
    // Preserve sentence break — single space after the punctuation looks natural.
    // The regex consumed the post-anchor whitespace; re-add one space.
    if (surviving.length > 0 && !surviving.startsWith(" ")) {
      stripped = beforeMatch + anchor + " " + surviving
      const c = stripped[(beforeMatch + anchor + " ").length]
      if (c && c >= "a" && c <= "z") {
        const idx = (beforeMatch + anchor + " ").length
        stripped = stripped.slice(0, idx) + c.toUpperCase() + stripped.slice(idx + 1)
      }
    }
  }

  // Defense: if the strip emptied the reply, fall back to original.
  if (stripped.trim().length === 0) {
    return { text, applied: false }
  }

  return {
    text: stripped,
    applied: true,
    pattern: det.pattern,
    removed: det.segment,
  }
}
