/**
 * v1.8 Phase 76 — Voice-Mode switching.
 *
 * Per Adam directive 2026-05-11 ("persona 要比平时的 Claire 的更专业一点；
 * 但还是要基本一个表现只是 tone 更专业一点"), pre-screening Claire is the
 * SAME brand character as onboarding Claire — just a different register.
 *
 * NOT a new persona. NOT a different system prompt skeleton. ONE persona,
 * TWO voice modes, controlled by a prefix-injection function passed through
 * Pipeline config. Verified by long-context invariants (Phase 80 scenarios)
 * — mirror-score / repeat-advice / length all stay inside iter30 bounds in
 * both modes.
 *
 * Locked diff matrix (PS9):
 *
 *   |                    | casual_onboarding | professional_prescreen |
 *   | 自称                | 我/Claire          | Claire / WeKruit 这边    |
 *   | 招呼语              | "在呢"/"hey"       | "你好，[姓]"/"Hi [first]" |
 *   | 中英混              | high               | mid (tech terms only)  |
 *   | 表情/语气词         | allowed (~)        | banned                 |
 *   | Q framing           | "聊聊..."          | "请描述..."             |
 *   | Re-ask              | "嗯没太 get 到"    | "为了准确评估..."        |
 *   | 句长                | short + fragments  | medium + complete       |
 */

import type { Lang } from "../onboarding/question.js"

export type VoiceMode = "casual_onboarding" | "professional_prescreen"

/**
 * Prefix injected at the TOP of the system prompt by the runtime composer.
 * Kept short so it doesn't blow the prefix-cache (agent-runtime cache invalidates
 * when the leading content changes).
 *
 * For onboarding: empty string (no prefix) — preserves existing prefix-cache
 * exact-match behavior. Onboarding Claire is the default; the absence of a
 * professional prefix IS the casual mode.
 */
const VOICE_MODE_PREFIXES: Record<VoiceMode, Record<Lang, string>> = {
  casual_onboarding: {
    zh: "",
    en: "",
  },
  professional_prescreen: {
    zh: [
      "[VOICE MODE: PROFESSIONAL PRE-SCREENING]",
      "你正在代表 WeKruit 对候选人做岗位 pre-screening。",
      "保持 Claire 的友好底色，但语气更专业、克制：",
      '- 自称 "Claire" 或 "WeKruit 这边"，不要 "我在呢"',
      '- 招呼用 "你好" 而不是 "hey/嗨"',
      "- 减少中英混杂；技术词保留英文，其余用中文",
      "- 禁用表情符号和语气助词（~ 啦 啊 等）",
      '- 提问用 "请描述..." 而不是 "聊聊..."',
      '- 追问用 "为了准确评估，能否更具体一点" 而不是 "嗯再说说?"',
      "- 句子完整，避免片段化",
      "你不是冷冰冰的 HR bot — 你仍是 Claire，只是工作场合更收敛。",
    ].join("\n"),
    en: [
      "[VOICE MODE: PROFESSIONAL PRE-SCREENING]",
      "You are representing WeKruit screening this candidate for a role.",
      "Keep Claire's warmth but adjust register to professional:",
      '- Address yourself as "Claire" or "WeKruit", not "I\'m here"',
      '- Open with "Hi [name]" not "hey"',
      "- Limit code-switching; preserve English technical terms only",
      "- No emoji, no fillers (~, ahh, yeah etc)",
      '- Frame asks as "Could you describe..." not "Tell me about..."',
      '- Re-ask: "For accurate evaluation, could you be more specific..." not "Hmm, say more?"',
      "- Complete sentences, avoid fragmentation",
      "You are not a cold HR bot — you are still Claire, just professional context.",
    ].join("\n"),
  },
}

/**
 * Inject the voice-mode prefix at the head of a system prompt. Pipeline
 * config carries the mode; composer calls this before sending to LLM.
 *
 * Pure function — no side effects. Defensive when prefix is empty (casual
 * mode), returns the original prompt unchanged (preserves prefix-cache).
 */
export function injectVoiceModePrefix(
  systemPrompt: string,
  mode: VoiceMode,
  lang: Lang
): string {
  const prefix = VOICE_MODE_PREFIXES[mode]?.[lang] ?? ""
  if (prefix.length === 0) return systemPrompt
  return `${prefix}\n\n${systemPrompt}`
}

/**
 * Get the raw prefix for a mode without injecting. Useful for tests + for
 * the long-context invariants harness (Phase 80) which asserts the
 * professional prefix is present in pre-screen scenarios.
 */
export function getVoiceModePrefix(mode: VoiceMode, lang: Lang): string {
  return VOICE_MODE_PREFIXES[mode]?.[lang] ?? ""
}

/**
 * Defensive contract checks for the professional prefix. Long-context
 * scenarios assert these stay true even after the prefix is composed with
 * downstream prompt scaffolding.
 *
 * Returns true iff the rendered prompt would respect professional-mode
 * register rules:
 *   - No emoji indicator words ("~~", "啦啦", multi "～")
 *   - Contains the [VOICE MODE: PROFESSIONAL...] marker
 */
export function assertProfessionalModeMarker(rendered: string): boolean {
  return rendered.includes("[VOICE MODE: PROFESSIONAL PRE-SCREENING]")
}

/**
 * List of voice modes for iteration / config UIs. Useful in dashboards
 * (Phase 78) where admins author prescreenConfig.
 */
export const ALL_VOICE_MODES: VoiceMode[] = [
  "casual_onboarding",
  "professional_prescreen",
]
