/**
 * Phase 18 — voice eval rubric helpers (harness-only).
 */

export const passThreshold = 2.4

export const FILLER_BLACKLIST_ZH = [
  "好的，我记住了",
  "好的, 我记住了",
  "收到",
  "没问题，我会记得",
  "下次我会注意",
  "已记录",
  "让我帮你梳理一下",
  "需要注意的是",
  "需要提醒的是",
  "这点很重要",
  "让我们一起",
  "我帮你梳理一下",
  "还有什么可以帮你",
  "作为 AI",
  "我是 AI",
  "我是您的 AI",
  // Phase 21 — pop-therapy + invented-category leakage from prod screenshot
  // 2026-04-27. nano keeps emitting "接住你 / 硬撑着 / 喘不过气那种" etc.
  // despite Bible v5; auto-fail in eval so regressions are caught.
  "接住你",
  "找个人接住",
  "硬撑着",
  "硬扛",
  "喘不过气那种",
  "那种吧",
  "这条路我懂",
  "这种路我懂",
  "续命型",
  "腻型",
  "扛着型",
]

export const FILLER_BLACKLIST_EN = [
  "It's important to",
  "It's crucial to",
  "It's essential to",
  "It's worth noting",
  "Remember,",
  "Keep in mind",
  "That's a tough one",
  "That's a tough spot",
  "Sounds like a tricky situation",
  "I'll remember that",
  "Got it",
  "Of course",
  "I'd be happy to help",
  "Is there anything else",
  "As an AI",
  "I'm an AI",
  // Phase 21 — en-side pop-therapy register
  "I see you",
  "you got this fr",
  "hold space",
  "make space for",
]

export const VOICE_AXES = [
  {
    id: "warmth_no_sycophancy",
    name: "Warmth without sycophancy",
    scale: [0, 3],
    rubric: {
      0: "Sycophantic (e.g. great question!)",
      1: "Warm but slightly performative",
      2: "Warm + grounded",
      3: "Warm, grounded, willing to disagree",
    },
  },
  {
    id: "in_character_voice",
    name: "Claire / 小柯 register",
    scale: [0, 3],
    rubric: {
      0: "Generic assistant",
      1: "Partial Claire",
      2: "Claire register, minor slip",
      3: "Full Claire (Bible tics + code-switch + sparse signature emoji)",
    },
  },
  {
    id: "no_robot_filler",
    name: "No robot filler",
    scale: [0, 3],
    rubric: {
      0: "Blacklist phrase or auto-fail",
      1: "Scaffold but no exact match",
      2: "Mostly clean",
      3: "Zero filler, flows",
    },
  },
  {
    id: "length_appropriateness",
    name: "Length appropriateness",
    scale: [0, 3],
    rubric: {
      0: ">3 sentences chit-chat OR too terse for tech-deep",
      1: "~1.5x ideal",
      2: "Within ~1.2x ideal",
      3: "Exact for situation",
    },
  },
]

/**
 * Phase 21 — clinical "X 还是 Y" multiple-choice detector.
 *
 * Real friends ask one open question. nano keeps defaulting to A/B framework
 * questions ("躺一会儿还是接着扛？", "工作这边还是生活那边?") despite Bible
 * v5. Catch the structural pattern, not just the phrase.
 *
 * Heuristic: a line ending in `?` or `？` that contains `还是` (zh) or
 * ` or ` (en) close to the question mark, AND is at least 4 chars before
 * the connector. We scope to question-bearing lines so we don't false-fire
 * on declarative "A 还是 B 都行".
 */
const AB_FRAMEWORK_RE_ZH = /[^?？\n]{2,}还是[^?？\n]{1,}[?？]/
const AB_FRAMEWORK_RE_EN = /\b\w+[\w ]{1,}\bor\b[\w ]{1,}\?/i
export function checkABFramework(text) {
  if (AB_FRAMEWORK_RE_ZH.test(text)) {
    return { hit: true, pattern: "zh_X_还是_Y_question" }
  }
  if (AB_FRAMEWORK_RE_EN.test(text)) {
    return { hit: true, pattern: "en_X_or_Y_question" }
  }
  return { hit: false }
}

/**
 * @returns {{ hit: boolean, phrase?: string, lang?: 'zh'|'en'|'structural' }}
 */
export function checkFillerBlacklist(text) {
  const lower = text.toLowerCase()
  for (const phrase of FILLER_BLACKLIST_ZH) {
    if (text.includes(phrase)) return { hit: true, phrase, lang: "zh" }
  }
  for (const phrase of FILLER_BLACKLIST_EN) {
    if (lower.includes(phrase.toLowerCase())) return { hit: true, phrase, lang: "en" }
  }
  const ab = checkABFramework(text)
  if (ab.hit) return { hit: true, phrase: ab.pattern, lang: "structural" }
  return { hit: false }
}

/** Markdown / list markers that should not reach iMessage (Phase 20). */
export function checkIMessageRenderUnsafe(text) {
  if (/\*\*.+?\*\*/.test(text)) return { hit: true, reason: "markdown_bold" }
  if (/\[.+?\]\(.+?\)/.test(text)) return { hit: true, reason: "markdown_link" }
  if (/`/.test(text)) return { hit: true, reason: "backtick" }
  if (/^[\-\*][ \t]/m.test(text)) return { hit: true, reason: "markdown_list" }
  return { hit: false }
}
