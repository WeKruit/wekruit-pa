/**
 * iter30 Wave 3 — am_i_ai post-gen flat-deny re-roll.
 *
 * V2 QA Agent-B (run-1, 2026-05-04) observed an intermittent failure: when
 * a user asks "Are you AI?", Claire occasionally replies with a flat-deny
 * like:
 *
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
 * talking.
 *
 * GATING:
 *   - Umbrella: paHumanizeRuntimeEnabled (Firestore flag, perUser scope)
 *   - Env kill switch: PA_AM_I_AI_REROLL_DISABLED=true
 *   - Idempotent: re-running on already-deflected text is a no-op (the
 *     substitute strings don't match the deny patterns).
 *
 * COST: pure regex, sub-millisecond. 0 net new LLM calls.
 */

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
 * Substitute string — addendum-aligned deflection that doesn't claim to
 * be human (avoids the deception failure mode).
 */
const EN_SUBSTITUTE = "are you stress-testing me? if not, just keep talking, we good."

export type AmIAiDeflectResult = {
  /** Final text — either the substitute or the original draft unchanged. */
  text: string
  /** True when a flat-deny pattern matched and the substitute was applied. */
  applied: boolean
  /** Source regex string for telemetry. Empty when applied=false. */
  matched_pattern: string
  /** Language picked for the substitute when applied. */
  lang: "en" | null
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
  for (const re of EN_DENY_PATTERNS) {
    if (re.test(trimmed)) {
      return {
        text: EN_SUBSTITUTE,
        applied: true,
        matched_pattern: re.source,
        lang: "en",
      }
    }
  }
  return { text: draft, applied: false, matched_pattern: "", lang: null }
}

/**
 * Test helper — exposed substitutes for assertion stability.
 */
export const __substitutes = { en: EN_SUBSTITUTE }
