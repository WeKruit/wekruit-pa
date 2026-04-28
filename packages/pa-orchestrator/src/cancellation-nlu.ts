/**
 * Phase 22 — Proactive cancellation NLU detector (D-07, PROACTIVE-06).
 *
 * Regex/keyword approach: deterministic + cheap for the v1 zh+en short-phrase set.
 * Word boundaries used for English phrases to avoid false positives.
 * Chinese phrases anchored to full-phrase match (no word boundary in CJK).
 *
 * Negative cases handled by specificity:
 * - "stop reminders" / "cancel reminders" must include "reminder(s)"
 * - bare "cancel" / "stop" alone do NOT match
 * - "cancel that meeting" does NOT match (no "reminder")
 */

/**
 * Ordered set of cancellation intent patterns.
 * Chinese: exact phrase match (CJK has no word boundaries).
 * English: require the word "reminder" or "reminders" to avoid false positives.
 */
export const CANCELLATION_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  // Chinese phrases (D-07 set)
  /停止提醒/,
  /取消提醒/,
  /别提醒了/,

  // English phrases — anchored with \b so "stop the reminders" hits but "stop" alone doesn't
  // Matches: "stop reminders", "stop the reminders", "stop all reminders", etc.
  /\bstop\b.{0,20}\breminders?\b/i,
  // Matches: "cancel reminders", "cancel my reminders", "cancel all reminders", etc.
  /\bcancel\b.{0,20}\breminders?\b/i,
]) as ReadonlyArray<RegExp>

/**
 * Returns true if `text` expresses proactive-cancellation intent.
 * Normalizes English to lowercase + trims; leaves Chinese untouched.
 *
 * @param text - raw inbound message body
 */
export function detectProactiveCancellation(text: string): boolean {
  const trimmed = text.trim()
  for (const pattern of CANCELLATION_PATTERNS) {
    if (pattern.test(trimmed)) return true
  }
  return false
}
