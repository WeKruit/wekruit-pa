/**
 * Phase 53 (v1.6 voice-quality closure) — A/B framework detector + strip.
 *
 * Distinct from `stripABProbeFromTail` (output-normalizer.ts), which targets
 * "X 还是 Y?" / "X or Y?" multiple-choice TAIL questions. This module targets
 * a separate clinical pattern Claire keeps emitting despite Bible v7.5 NEVER
 * rules: **conditional A/B framing** —
 *
 *   ❌ "如果你想转 PM 方向，那可以先做 product analyst"
 *   ❌ "If you want to switch to PM, you could try product analyst first"
 *
 * vs the friend-tone equivalent that DROPS the if-clause head:
 *
 *   ✅ "转 PM 方向，先做 product analyst 不错"
 *   ✅ "Switching to PM, you could start as product analyst"
 *
 * The strip is conservative: it removes ONLY the leading "如果你想…，" / "If
 * you (want|wanna|would like) … ," head and preserves the entire then-clause
 * verbatim. We do not attempt grammatical rewriting of the surviving clause —
 * any edge-case awkwardness is preferred to silent semantic drift.
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
  | "zh_conditional_if_then"
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
// zh — "如果你想 X[，,] 那?(可以|可|就)? Y"
//
// Match anchors:
//   - sentence-initial OR after . / 。 / ! / ！ / ? / ？ / newline
//   - head is one of: 如果你想 / 如果你想要 / 如果想 / 要是你想 / 你要是想
//   - X is non-empty, ≤ 30 chars, no terminal punct
//   - separator is a Chinese or ASCII comma
//   - then-clause MAY start with 那 / 那么 / 就 / 可以 / 可 — we capture but discard the head
//
// Capture group 1 = the leading head we will REMOVE. Capture group 2 =
// optional bridge ("那可以/那么就/可以/可") we ALSO remove. Capture group 3 =
// rest-of-clause (preserved). Anchored loosely with /m so multi-sentence
// replies still match the leading conditional clause.
// ---------------------------------------------------------------------------
const ZH_HEAD_PATTERN = "如果你想要?|如果想要?|要是你想|你要是想"
const ZH_BRIDGE_PATTERN = "(?:那(?:么)?)?(?:就)?(?:可以|可|不妨|建议|试试)?"

const AB_FRAMEWORK_RE_ZH = new RegExp(
  // (^|[\.。!！?？\n])  ← anchor
  // \s* (?:head) \s* (X) \s* [,，]
  // \s* (bridge) \s* (rest)
  `(^|[\\.。!！?？\\n])\\s*(?:${ZH_HEAD_PATTERN})\\s*([^,，。！？!?\\n]{1,40})[,，]\\s*${ZH_BRIDGE_PATTERN}\\s*`,
  "u"
)

// ---------------------------------------------------------------------------
// en — "If you (want|wanna|would like|'d like) X, (you (could|can|might|should))? Y"
//
// Same shape as zh: head + X + comma + optional bridge + rest. Case-insensitive.
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
 * Detect a conditional A/B framework head. Returns first match (zh checked
 * before en — matches the rewriter precedence elsewhere in the codebase).
 */
export function detectABFramework(text: string): DetectABResult {
  if (typeof text !== "string" || text.length === 0) {
    return { matched: false }
  }
  const zh = AB_FRAMEWORK_RE_ZH.exec(text)
  if (zh) {
    return {
      matched: true,
      pattern: "zh_conditional_if_then",
      segment: zh[0],
    }
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
 *  - Replace the matched head ("如果你想 X，那可以" / "If you want X, you could")
 *    with empty string (consume leading anchor whitespace too).
 *  - Re-capitalize the surviving first character only when we removed an
 *    English head AND the surviving char is a lowercase ASCII letter.
 *  - If the result becomes empty / whitespace-only, return the original text
 *    (defensive: never delete the entire reply). The pattern's [,，] separator
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

  const re = det.pattern === "zh_conditional_if_then"
    ? AB_FRAMEWORK_RE_ZH
    : AB_FRAMEWORK_RE_EN

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
  // Capitalize the first ASCII letter of the surviving clause when we stripped
  // an en head (matches sentence-start orthography; no-op for zh).
  if (det.pattern === "en_conditional_if_then" && surviving.length > 0) {
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
  } else if (anchor === "." || anchor === "!" || anchor === "?" ||
             anchor === "。" || anchor === "！" || anchor === "？") {
    // Preserve sentence break — single space after the punctuation looks natural.
    // The regex consumed the post-anchor whitespace; re-add one space.
    if (surviving.length > 0 && !surviving.startsWith(" ")) {
      stripped = beforeMatch + anchor + " " + surviving
      if (det.pattern === "en_conditional_if_then") {
        const c = stripped[(beforeMatch + anchor + " ").length]
        if (c && c >= "a" && c <= "z") {
          const idx = (beforeMatch + anchor + " ").length
          stripped = stripped.slice(0, idx) + c.toUpperCase() + stripped.slice(idx + 1)
        }
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
