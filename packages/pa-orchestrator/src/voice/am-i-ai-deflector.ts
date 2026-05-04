/**
 * iter30 Wave 3 — am_i_ai post-gen flat-deny re-roll.
 *
 * V2 QA Agent-B (run-1, 2026-05-04) observed an intermittent failure: when
 * a user asks "你是 AI 吗 / Are you AI?", Claire occasionally replies with a
 * flat-deny like:
 *
 *   "嗯，我是真人朋友。"
 *   "我是真人。"
 *   "I'm a real person."
 *   "Not an AI."
 *
 * That's the EXACT pattern the am_i_ai_check addendum forbids ("NEVER:
 * flat-deny — deceptive"). The system prompt + few-shot saturated; the
 * model still leaks a flat-deny ~5-10% of the time when context is long.
 *
 * Solution — deterministic post-gen substitution. After the LLM produces a
 * draft, scan for flat-deny patterns. If matched, substitute with an
 * addendum-aligned friend-tone deflection that doesn't lie. The substitute
 * is short, deflective, and keeps the door open for the user to keep
 * talking ("你接着说什么都行").
 *
 * GATING:
 *   - Umbrella: paHumanizeRuntimeEnabled (Firestore flag, perUser scope)
 *   - Env kill switch: PA_AM_I_AI_REROLL_DISABLED=true
 *   - Idempotent: re-running on already-deflected text is a no-op (the
 *     substitute strings don't match the deny patterns).
 *
 * COST: pure regex, sub-millisecond. 0 net new LLM calls.
 *
 * BILINGUAL: ZH + EN patterns both handled. Lang-pick uses CJK majority on
 * the original draft (same heuristic as ab-probe-strip fallback).
 */

/**
 * ZH flat-deny patterns. Ordered most-specific → most-general so the
 * matcher records the right pattern in telemetry.
 */
const ZH_DENY_PATTERNS: ReadonlyArray<RegExp> = [
  // "嗯，我是真人朋友" / "嗯, 我是真人朋友"
  /^[\s]*(?:嗯[，,]?\s*)?我是真人朋友[。.！!]?[\s]*$/,
  // "我是真人" / "我是真人。" / "嗯，我是真人。" — short standalone deny
  /^[\s]*(?:嗯[，,]?\s*)?我[是为]?真人[\s。.！!]*$/,
  // "我?(?:是)?真人" within first ~5 chars (no other content)
  /^[\s]*我?(?:是)?真人[^，,。.\n]{0,5}[。.！!]?[\s]*$/,
  // "没有，我不是 AI" / "没有 不是AI"
  /^[\s]*没有[，,]?\s*(?:我?(?:不是)?)?\s*AI[\s。.！!]*$/i,
  // Bare "不是 AI" / "我不是 AI"
  /^[\s]*(?:我)?不是\s*(?:一个\s*)?AI[\s。.！!]*$/i,
]

/**
 * EN flat-deny patterns.
 *
 * "I'm" pronoun variants: `i am` / `i'm` / `im`. Pattern fragment
 * `(?:i\s*['']\s*m|i\s+am|im)` covers all three. Curly apostrophes (’)
 * also accepted for iMessage paste-in.
 */
const I_AM_FRAG = "(?:i\\s*[''’]\\s*m|i\\s+am|im)"

const EN_DENY_PATTERNS: ReadonlyArray<RegExp> = [
  // "I'm a real person" / "I am a real human" / "i'm real"
  new RegExp(`^[\\s]*${I_AM_FRAG}\\s*(?:a\\s+)?real\\s+(?:person|human|one)[\\s.!]*$`, "i"),
  // "I'm not an AI" / "not an AI" / "I am not AI"
  new RegExp(`^[\\s]*(?:${I_AM_FRAG}\\s+)?not\\s+(?:an?\\s+)?ai[\\s.!]*$`, "i"),
  // "no I'm not AI" / "nope, real person here"
  new RegExp(
    `^[\\s]*(?:no|nope)[,.\\s]+(?:${I_AM_FRAG}\\s+)?(?:not\\s+(?:an?\\s+)?ai|(?:a\\s+)?real\\s+(?:person|human))[\\s.!]*$`,
    "i"
  ),
]

/**
 * Substitute strings — addendum-aligned deflection that doesn't claim to
 * be human (avoids the deception failure mode).
 */
const ZH_SUBSTITUTE = "你这是测我的话术呢? 不是的话, 你接着说什么都行。"
const EN_SUBSTITUTE = "are you stress-testing me? if not, just keep talking, we good."

export type AmIAiDeflectResult = {
  /** Final text — either the substitute or the original draft unchanged. */
  text: string
  /** True when a flat-deny pattern matched and the substitute was applied. */
  applied: boolean
  /** Source regex string for telemetry. Empty when applied=false. */
  matched_pattern: string
  /** Language picked for the substitute when applied. */
  lang: "zh" | "en" | null
}

/**
 * Lightweight CJK majority detector. Returns "zh" when >= 30% of non-space
 * chars are in the CJK Unified Ideographs blocks; otherwise "en". Tuned for
 * mixed-register (e.g. "我是 a real person" — 30% CJK threshold flips zh).
 */
function pickLang(draft: string): "zh" | "en" {
  const trimmed = draft.replace(/\s/g, "")
  if (trimmed.length === 0) return "en"
  let cjk = 0
  for (const ch of trimmed) {
    if (/[一-鿿]/.test(ch)) cjk++
  }
  return cjk / trimmed.length >= 0.3 ? "zh" : "en"
}

/**
 * Scan draft for flat-deny patterns; substitute when matched.
 *
 * @param draft Cleaned LLM output (post-strip-helpers).
 * @returns Result with `applied=true` when a substitution happened.
 */
export function deflectAmIAiFlatDeny(draft: string): AmIAiDeflectResult {
  if (!draft || !draft.trim()) {
    return { text: draft, applied: false, matched_pattern: "", lang: null }
  }
  const trimmed = draft.trim()
  const lang = pickLang(trimmed)
  const patterns = lang === "zh" ? ZH_DENY_PATTERNS : EN_DENY_PATTERNS
  for (const re of patterns) {
    if (re.test(trimmed)) {
      return {
        text: lang === "zh" ? ZH_SUBSTITUTE : EN_SUBSTITUTE,
        applied: true,
        matched_pattern: re.source,
        lang,
      }
    }
  }
  // Cross-language safety net: if pickLang said EN but draft is short and
  // contains both CJK + flat-deny shape, try the other-lang patterns too.
  const altPatterns = lang === "zh" ? EN_DENY_PATTERNS : ZH_DENY_PATTERNS
  for (const re of altPatterns) {
    if (re.test(trimmed)) {
      return {
        text: lang === "zh" ? ZH_SUBSTITUTE : EN_SUBSTITUTE,
        applied: true,
        matched_pattern: re.source,
        lang,
      }
    }
  }
  return { text: draft, applied: false, matched_pattern: "", lang: null }
}

/**
 * Test helper — exposed substitutes for assertion stability.
 */
export const __substitutes = { zh: ZH_SUBSTITUTE, en: EN_SUBSTITUTE }
