/**
 * Phase 18 VOICE-07 slang lexicon — shipped form.
 *
 * Source of truth (verbatim copy):
 *   .planning/phases/17-pre-launch-hardening/17-RESEARCH-raw-artifacts.md
 *   § "Slang lexicon (curated — only 1-2 per turn, not stacked)"
 *
 * Why this lives here (Phase 19 / D-08): Phase 18 referenced VOICE-07 in
 * the prompt copy but never extracted a TS module. Phase 19's analyzer
 * MUST count slang hits programmatically (slang_hits feature, D-10), so
 * the curated list is materialized once here and re-used by:
 *   - packages/pa-orchestrator/src/voice/style-analyzer.ts (slang_hits)
 *   - packages/pa-orchestrator/src/voice/mirror-snippet.ts (positive bucketing)
 *
 * D-08 contract: this lexicon MUST stay in sync with the research
 * artifact. Do NOT add terms here without also updating
 * 17-RESEARCH-raw-artifacts.md. Do NOT re-author from scratch.
 */

/** zh terms — 求职 + 海外华人 register. ≤ 10 entries per VOICE-07 cap. */
export const ZH_SLANG: readonly string[] = Object.freeze([
  "emo了",
  "破防",
  "听劝",
  "i人",
  "e人",
  "测评",
  "躺平",
  "卷",
  "显眼包",
  "遥遥领先",
  "yyds",
  "芭比Q",
  "芭比q",
])

/** en terms — Gen-Z + corporate-millennial sass. ≤ 7 entries per VOICE-07 cap. */
export const EN_SLANG: readonly string[] = Object.freeze([
  "lowkey",
  "fr fr",
  "fr",
  "mid",
  "delulu",
  "deadass",
  "npc",
  "manifest",
  "manifesting",
])

/**
 * Count case-insensitive lexicon matches in a single text blob.
 * - zh terms are matched literally (no case fold; CJK has no case).
 * - en terms are matched word-bounded and case-insensitive.
 * - "fr fr" is matched before "fr" so the bigram doesn't double-count.
 */
export function countSlangHits(text: string): number {
  if (!text) return 0
  let hits = 0
  // zh: literal substring count (CJK; case-insensitivity is moot).
  for (const term of ZH_SLANG) {
    let i = 0
    while ((i = text.indexOf(term, i)) !== -1) {
      hits += 1
      i += term.length
    }
  }
  // en: word-bounded, case-insensitive. Match longer phrases first to
  // avoid "fr fr" being counted as 2× "fr".
  const lower = text.toLowerCase()
  // Mask out matched bigram regions so single-word "fr" doesn't re-count them.
  let masked = lower
  for (const term of EN_SLANG) {
    if (!term.includes(" ")) continue
    const re = new RegExp(`\\b${term.replace(/\s+/g, "\\s+")}\\b`, "g")
    masked = masked.replace(re, (m) => {
      hits += 1
      return " ".repeat(m.length)
    })
  }
  for (const term of EN_SLANG) {
    if (term.includes(" ")) continue
    const re = new RegExp(`\\b${term}\\b`, "g")
    const matches = masked.match(re)
    if (matches) hits += matches.length
  }
  return hits
}
