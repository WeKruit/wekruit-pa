/**
 * Phase 19 Adaptive Mirror — positive-framing mirror snippet builder.
 *
 * D-03 (LOAD-BEARING): positive framing ONLY. No "don't", "never",
 * "avoid", "do not", "不要", "别", "禁止", "严禁". Negative tokens are
 * regex-asserted absent in the unit test (D-03 enforcement).
 *
 * D-04: this snippet is consumed by the orchestrator AFTER the Phase 18
 * voice reminder, BEFORE the user turn. Order:
 *   [system prompt] → [history] → [Phase 18 voice reminder]
 *   → [Phase 19 mirror snippet] → [user turn]
 *
 * Output is a single Meta-AI-WhatsApp-style instruction:
 *   "User is currently using <observed style>. Match that — <descriptors>."
 *
 * Returns null when sample_size === 0 (caller skips injection).
 */
import type { StyleSnapshot } from "./style-analyzer.js"

type RegisterBucket = "formal" | "casual" | "slangy"
type LangBucket = "zh" | "en" | "mix"
type EmojiBucket = "none" | "sparse" | "expressive"

function registerBucket(s: StyleSnapshot): RegisterBucket {
  if (s.register_score >= 0.7) return "formal"
  if (s.register_score >= 0.4) return "casual"
  return "slangy"
}

function langBucket(s: StyleSnapshot): LangBucket {
  if (s.zh_char_ratio >= 0.8) return "zh"
  if (s.zh_char_ratio <= 0.2) return "en"
  return "mix"
}

function emojiBucket(s: StyleSnapshot): EmojiBucket {
  if (s.emoji_freq === 0) return "none"
  if (s.emoji_freq <= 1.5) return "sparse"
  return "expressive"
}

const REGISTER_OBSERVED: Record<RegisterBucket, string> = {
  formal: "a formal register",
  casual: "a casual conversational register",
  slangy: "slangy register with internet shorthand",
}

const REGISTER_MATCH: Record<RegisterBucket, string> = {
  formal: "match: formal register, complete sentences, measured tone",
  casual: "match: short casual sentences, friend-texting tone",
  slangy: "match: short, casual, code-switch natural, slang ok in moderation",
}

const LANG_OBSERVED: Record<LangBucket, string> = {
  zh: "primarily 中文",
  en: "primarily English",
  mix: "natural zh-en code-switch",
}

const LANG_MATCH: Record<LangBucket, string> = {
  zh: "primary language: 中文",
  en: "primary language: English",
  mix: "natural zh-en code-switch ok",
}

const EMOJI_OBSERVED: Record<EmojiBucket, string> = {
  none: "no emoji",
  sparse: "occasional emoji",
  expressive: "expressive emoji use",
}

const EMOJI_MATCH: Record<EmojiBucket, string> = {
  none: "no emoji",
  sparse: "up to 1 emoji per turn ok",
  expressive: "1 emoji per turn ok when natural",
}

export function buildMirrorSnippet(s: StyleSnapshot): string | null {
  if (!s || s.sample_size === 0) return null

  const reg = registerBucket(s)
  const lang = langBucket(s)
  const emoji = emojiBucket(s)

  const observed = `${REGISTER_OBSERVED[reg]}, ${LANG_OBSERVED[lang]}, ${EMOJI_OBSERVED[emoji]}`
  const directives = [REGISTER_MATCH[reg], LANG_MATCH[lang], EMOJI_MATCH[emoji]].join("; ")

  return `User is currently using ${observed}. Match that — ${directives}.`
}
