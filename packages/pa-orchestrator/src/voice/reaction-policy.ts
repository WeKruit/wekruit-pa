import type { ChatMessage } from "@pa/core-types"
import type { ResolvedVoiceProfile } from "./voice-profiles/index.js"

export type ReactionPlan = {
  shouldReact: boolean
  reaction?: "love" | "like" | "emphasize" | "laugh"
  reason?: string
}

const POSITIVE_MARKERS_EN = [
  /\bthanks\b/i,
  /\bthank you\b/i,
  /\byou're the best\b/i,
  /\bappreciate\b/i,
  /\blfg\b/i,
]
const POSITIVE_MARKERS_ZH = [/谢谢/, /感谢/, /太好了/, /牛/, /爱了/]

function isShortReply(body: string): boolean {
  const t = body.trim()
  return t.length <= 12 || /^(ok|okay|k|yeah|yep|yes|好|行|嗯|okok)$/i.test(t)
}

function emotionalWeight(body: string): number {
  const t = body.trim()
  if (!t) return 0
  let score = 0
  if (POSITIVE_MARKERS_EN.some((p) => p.test(t)) || POSITIVE_MARKERS_ZH.some((p) => p.test(t))) score += 2
  if (/!{2,}/.test(t) || /！{2,}/.test(t)) score += 1
  if (/\b(lol|lmao|haha|哈哈哈|笑死)\b/i.test(t)) score += 1
  return score
}

export function planReaction(input: {
  profile: ResolvedVoiceProfile
  userMessage: string
  recentAssistantTurns: ChatMessage[]
  confidence?: number
}): ReactionPlan {
  if (!input.profile.choreography.reactionsAllowed) {
    return { shouldReact: false, reason: "profile_disallows" }
  }
  if (process.env.PA_REACTION_TAPBACK_DISABLED === "true") {
    return { shouldReact: false, reason: "env_disabled" }
  }
  const conf = input.confidence ?? 0.85
  if (conf < 0.7) return { shouldReact: false, reason: "low_confidence" }
  const weight = emotionalWeight(input.userMessage)
  if (weight < 2) return { shouldReact: false, reason: "neutral_message" }
  if (isShortReply(input.userMessage)) {
    return { shouldReact: false, reason: "short_reply_no_tap" }
  }

  const maxPerN = input.profile.choreography.reactionMaxPerN ?? 5
  const recentAssistant = input.recentAssistantTurns.filter((m) => m.role === "assistant").slice(-maxPerN)
  const reactedRecently = recentAssistant.some((m) => m.rawMeta?.reactionSent === true)
  if (reactedRecently) return { shouldReact: false, reason: "cap_per_n_turns" }

  const reaction: ReactionPlan["reaction"] = /\b(lol|haha|哈哈哈)\b/i.test(input.userMessage)
    ? "laugh"
    : "like"
  return { shouldReact: true, reaction, reason: "positive_weighted" }
}
