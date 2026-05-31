/**
 * Adam 2026-05-19 voice polish §6 — tangent detector for shared onboarding.
 *
 * Problem: during onboarding, a user sometimes replies with a *question* of
 * their own ("wait, are you AI?", "can you help me with my resume?",
 * "what jobs do you have?") instead of an actual slot answer. Today the
 * answer judge rejects those as `irrelevant`/`unclear` and the reask copy
 * just nudges them back to the slot question. That feels robotic — a real
 * friend would briefly answer, then circle back.
 *
 * This module is a tiny deterministic detector that returns
 *   { isTangent: boolean, reason: string }
 * given the raw inbound text + lang. The detector is intentionally
 * conservative — false positives are worse than false negatives because a
 * false positive could pull the LLM into a multi-paragraph derailment.
 *
 * Heuristics (en + zh):
 *   1. message contains a question mark (?, full-width ?) — and is short enough that
 *      it's not just a long answer with a trailing rhetorical "?";
 *   2. message starts with a wh-word / modal in en (what, when, where, who,
 *      why, how, can, could, would, should, do, does, did, is, are, were)
 *      OR a legacy zh interrogative opener (detected via codepoint set);
 *   3. message is short (<= 220 chars). Long monologues that happen to
 *      include a question are usually still answers (Adam often types
 *      "I want X, Y, and Z — make sense?").
 *
 * The judge rejection signal is independent — we still rely on
 * `judgeResult.accept === false` to gate calling this detector. So the only
 * downside of an FP here is that the surface intent gets a "briefly answer
 * their question" hint when the user wasn't actually asking one; the LLM
 * is also instructed to fall back to the slot question, so it self-corrects.
 */

const ALPHA_RE = /[a-zA-Z\u4e00-\u9fff]/
const QUESTION_MARK_RE = /[?\uff1f]/

const EN_INTERROGATIVE_OPENERS = new Set([
  "what",
  "whats",
  "when",
  "where",
  "whos",
  "who",
  "why",
  "how",
  "hows",
  "can",
  "could",
  "would",
  "should",
  "do",
  "does",
  "did",
  "is",
  "are",
  "was",
  "were",
  "am",
  "may",
  "might",
  "will",
])

// Common zh interrogative leading characters — we only need to look at the
// first non-whitespace char(s) since Chinese sentences don't space-delimit.
const ZH_INTERROGATIVE_CHARS = [
  "\u4f60", "\u6709", "\u80fd", "\u53ef", "\u4e3a", "\u600e",
  "\u4ec0", "\u8c01", "\u54ea", "\u51e0", "\u5417", "\u5462",
]

const MAX_TANGENT_LENGTH = 220

export type TangentDetectionResult = {
  isTangent: boolean
  /** Human-readable reason — flows into telemetry, never into the SMS. */
  reason: string
}

export function detectOnboardingTangent(input: {
  body: string
  lang: "en" | "zh"
}): TangentDetectionResult {
  const raw = (input.body ?? "").trim()
  if (raw.length === 0) return { isTangent: false, reason: "empty" }
  if (raw.length > MAX_TANGENT_LENGTH) {
    return { isTangent: false, reason: "too_long" }
  }
  if (!ALPHA_RE.test(raw)) {
    return { isTangent: false, reason: "no_alpha" }
  }

  const hasQuestionMark = QUESTION_MARK_RE.test(raw)

  if (input.lang === "zh") {
    const firstChar = raw[0] ?? ""
    const opensWithInterrogative = ZH_INTERROGATIVE_CHARS.includes(firstChar)
    // Legacy zh yes/no particles commonly appear at end-of-sentence.
    const endsWithYesNo = /[\u5417\u5462][?\uff1f]?$/.test(raw)
    if (hasQuestionMark && (opensWithInterrogative || endsWithYesNo)) {
      return { isTangent: true, reason: "zh_question_mark+interrogative" }
    }
    if (opensWithInterrogative && endsWithYesNo) {
      return { isTangent: true, reason: "zh_interrogative_yesno" }
    }
    return { isTangent: false, reason: "zh_no_match" }
  }

  // EN path. Strip apostrophes when normalising the first word so contractions
  // ("what's", "who's", "how's") collapse onto the canonical opener set.
  const firstWordRaw = raw.toLowerCase().match(/^[a-z']+/)?.[0] ?? ""
  const firstWord = firstWordRaw.replace(/'/g, "")
  const opensWithInterrogative = EN_INTERROGATIVE_OPENERS.has(firstWord)
  if (hasQuestionMark && opensWithInterrogative) {
    return { isTangent: true, reason: "en_question_mark+opener" }
  }
  // Standalone "?" without interrogative opener is too noisy (e.g. "really?"
  // mid-answer). Require BOTH to flag.
  return { isTangent: false, reason: "en_no_match" }
}

/**
 * Surface intent directive injected when a tangent is detected. Kept short
 * because surface intent already has many invariants; we want the LLM to
 * comply, not to drown.
 */
export function buildTangentSurfaceDirective(lang: "en" | "zh"): string {
  // Product is English-only — same directive regardless of legacy lang value.
  void lang
  return "User asked an off-topic question. First, briefly answer them in ONE short sentence (no essay). Then gently bring the conversation back to the current onboarding question."
}
