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
 * @returns {{ hit: boolean, phrase?: string, lang?: 'zh'|'en' }}
 */
export function checkFillerBlacklist(text) {
  const lower = text.toLowerCase()
  for (const phrase of FILLER_BLACKLIST_ZH) {
    if (text.includes(phrase)) return { hit: true, phrase, lang: "zh" }
  }
  for (const phrase of FILLER_BLACKLIST_EN) {
    if (lower.includes(phrase.toLowerCase())) return { hit: true, phrase, lang: "en" }
  }
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
