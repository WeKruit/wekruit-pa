/**
 * Phase 38 — Prompt-injector for Phase 3 system prompt addendum.
 *
 * Generates the `[MEMORY-POLICY]...[/MEMORY-POLICY]` block that wire-in
 * caller appends to the rewriter system prompt. Bilingual `note:` gloss
 * switches on `opts.userLang`.
 *
 * Format (per CONTEXT D-38-4):
 *
 *   [MEMORY-POLICY]
 *   already_given_advice (do NOT repeat or paraphrase):
 *     1. <recent[2].text>      <- most recent first
 *     2. <recent[1].text>
 *     3. <recent[0].text>
 *   note: 已经给过的建议 — 不要重复或换皮重说，给新角度。  (zh)
 *   note: Already-given advice — don't repeat or paraphrase; bring a fresh angle.  (en)
 *   [/MEMORY-POLICY]
 *
 * Empty when `recent.length === 0` → returns "" (caller skips appending).
 *
 * Items truncated to 200 chars to avoid prompt bloat. Default `max` = 3.
 */

import type { AdviceTrackerEntry } from "./types.js"

const NOTE_ZH = "已经给过的建议 — 不要重复或换皮重说，给新角度。"
const NOTE_EN = "Already-given advice — don't repeat or paraphrase; bring a fresh angle."

const ITEM_MAX_CHARS = 200

export interface BuildAdviceInjectionOpts {
  userLang?: "zh" | "en" | "mixed"
  /** Max items to include (default 3). */
  max?: number
}

function truncate(s: string, n: number): string {
  if (!s) return ""
  return s.length <= n ? s : `${s.slice(0, n)}...`
}

function pickNote(lang: BuildAdviceInjectionOpts["userLang"]): string {
  // mixed → en (default) — wire-in caller may override via Phase 37 directive note
  if (lang === "zh") return NOTE_ZH
  return NOTE_EN
}

/**
 * Build the [MEMORY-POLICY] system-prompt addendum block.
 *
 * @param recent  Advice tracker entries (oldest-first per `recentAdvice`).
 *                Internally re-ordered most-recent-first for prompt clarity.
 * @param opts    Lang hint + max-items override.
 * @returns       Multi-line directive string, or "" when no items.
 */
export function buildAdviceInjection(
  recent: AdviceTrackerEntry[],
  opts: BuildAdviceInjectionOpts = {}
): string {
  if (!Array.isArray(recent) || recent.length === 0) return ""
  const max = opts.max ?? 3
  // recent is oldest-first → reverse to most-recent-first for the directive.
  const items = [...recent].reverse().slice(0, max)
  if (items.length === 0) return ""

  const lines: string[] = []
  lines.push("[MEMORY-POLICY]")
  lines.push("already_given_advice (do NOT repeat or paraphrase):")
  for (let i = 0; i < items.length; i++) {
    lines.push(`  ${i + 1}. ${truncate(items[i].text, ITEM_MAX_CHARS)}`)
  }
  lines.push(`note: ${pickNote(opts.userLang)}`)
  lines.push("[/MEMORY-POLICY]")
  return lines.join("\n")
}

/** Exposed for tests + cross-module reuse. */
export const MEMORY_POLICY_NOTE_ZH = NOTE_ZH
export const MEMORY_POLICY_NOTE_EN = NOTE_EN
