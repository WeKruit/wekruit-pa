import type { ChatMessage } from "@pa/core-types"
import { buildSlangInjection } from "./slang-injector.js"
import { planReaction, type ReactionPlan } from "./reaction-policy.js"
import type { ResolvedVoiceProfile } from "./voice-profiles/index.js"

export type ChoreographyPlan = {
  reactionPlan: ReactionPlan
  ackHint: string | null
  slangDirective: string | null
  /**
   * Terms the slang injector surfaced this turn. Callers should append
   * these to their per-user `recentSlangPicks` window so subsequent turns
   * can exclude them and avoid back-to-back identical openers.
   */
  slangPicked: string[]
  splitSeed: string
  imperfectionRate: number
}

function parseRate(env: string | undefined, fallback: number): number {
  const n = Number(env)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

export function buildBehaviorChoreographyPlan(input: {
  profile: ResolvedVoiceProfile
  turnId: string
  userMessage: string
  recentHistory: ChatMessage[]
  mode?: "ask" | "reask" | "ack_then_ask" | "tangent_then_ask" | "deliver"
  /**
   * Slang terms surfaced on recent turns; passed straight to the slang
   * injector so the palette rotates instead of resurfacing the same
   * candidates twice in a row.
   */
  recentSlangPicks?: readonly string[]
}): ChoreographyPlan {
  const reactionPlan = planReaction({
    profile: input.profile,
    userMessage: input.userMessage,
    recentAssistantTurns: input.recentHistory,
  })

  let ackHint: string | null = null
  const ackRate =
    input.mode === "ack_then_ask"
      ? input.profile.choreography.ackThenAsk.rate
      : parseRate(process.env.PA_CHOREO_ACK_RATE, input.profile.choreography.ackThenAsk.rate)
  if (input.profile.choreography.ackThenAsk.allowed && ackRate > 0) {
    const volunteered = input.userMessage.trim().length > 80
    if (volunteered && Math.random() < ackRate) {
      ackHint =
        /[一-鿿]/.test(input.userMessage)
          ? "先简短接住对方刚说的信息，再自然问下一个问题。"
          : "Briefly acknowledge what they volunteered, then ask the next question."
    }
  }

  const slangDecision =
    input.profile.choreography.slangBudget === "off"
      ? { directive: null as string | null, picked: [] as string[] }
      : buildSlangInjection({
          userMessage: input.userMessage,
          seed: input.turnId,
          excludeTerms: input.recentSlangPicks,
        })

  const imperfectionRate = parseRate(
    process.env.PA_IMPERFECTION_RATE,
    input.profile.choreography.imperfectionRate
  )

  return {
    reactionPlan,
    ackHint,
    slangDirective: slangDecision.directive,
    slangPicked: slangDecision.picked,
    splitSeed: input.turnId,
    imperfectionRate,
  }
}
