import type { Firestore } from "firebase-admin/firestore"
import type { AgentDef, InboundEvent } from "@pa/core-types"
import { getFlag } from "@pa/pa-persistence"
import { detectLang } from "./voice/imperfection-injector/index.js"
import type { ConnectorName } from "@pa/pa-connectors"
import { buildMatchConnectorHooks, type GenerateJobRecsFn } from "./match-connector-hooks.js"
import {
  frameConnectorResult,
  isConnectorNarrationEnabled,
  runConnectorWithNarration,
} from "./run-connector-with-narration.js"
import {
  buildSharedOnboardingPrompt,
  buildSharedOnboardingReask,
  type SharedOnboardingPromptContext,
  type SharedOnboardingQuestionId,
} from "./shared-onboarding.js"
import { buildOnboardingSurfaceIntent, type OnboardingSurfaceMode } from "./shared-onboarding-surface.js"
import { applyTemplateOutboundHumanize } from "./outbound-template-humanize.js"
import {
  injectVoiceProfilePrefix,
  resolveProfileForUser,
} from "./voice/voice-profiles/index.js"
import { buildBehaviorChoreographyPlan } from "./voice/behavior-choreographer.js"
import type { AgentTurnTool, AgentsSdkSession } from "@pa/agent-runtime"

export type SharedOnboardingRunAgentTurn = (
  input: {
    agent: AgentDef
    systemPrompt: string
    userMessage: string
    history: unknown[]
    memoryBlock: string
    session: { sessionId: string; userId: string }
    systemInputs?: string[]
    tools?: AgentTurnTool[]
  }
) => Promise<{ text?: string | null }>

export type SharedOnboardingOutboundStore = {
  db?: Firestore
  log: (name: string, payload?: Record<string, unknown>) => void
  runAgentTurn?: SharedOnboardingRunAgentTurn
  createSession?: (input: { sessionId: string; userId: string }) => AgentsSdkSession
  generateJobRecs?: GenerateJobRecsFn
  enqueueOutbound?: (
    userId: string,
    toE164: string,
    body: string,
    input?: Record<string, unknown>
  ) => Promise<void>
  sendReaction?: (input: {
    toE164: string
    messageHandle: string
    reaction: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question"
  }) => Promise<void>
  buildTurnTools?: (
    agent: AgentDef,
    turn: { turnId: string; userId: string; sessionId: string }
  ) => Promise<AgentTurnTool[]>
}

export async function isSharedOnboardingAgenticSurfaceEnabled(
  db: Firestore | undefined,
  userId: string
): Promise<boolean> {
  if (process.env.PA_SHARED_ONBOARDING_TEMPLATE_FALLBACK === "true") return false
  if (!db) return false
  try {
    return (await getFlag(db, "paSharedOnboardingAgenticSurface", { userId, env: process.env })) === true
  } catch {
    return false
  }
}

export async function isFindMatchToolEnabled(
  db: Firestore | undefined,
  userId: string
): Promise<boolean> {
  if (!db) return false
  try {
    return (await getFlag(db, "paFindMatchToolEnabled", { userId, env: process.env })) === true
  } catch {
    return false
  }
}

export async function isBehaviorChoreographerEnabled(
  db: Firestore | undefined,
  userId: string
): Promise<boolean> {
  if (!db) return false
  try {
    return (await getFlag(db, "paBehaviorChoreographerEnabled", { userId, env: process.env })) === true
  } catch {
    return false
  }
}

export async function isReactionTapbackEnabled(
  db: Firestore | undefined,
  userId: string
): Promise<boolean> {
  if (process.env.PA_REACTION_TAPBACK_DISABLED === "true") return false
  if (!db) return false
  try {
    return (await getFlag(db, "paReactionTapbackEnabled", { userId, env: process.env })) === true
  } catch {
    return false
  }
}

export type ComposeSharedOnboardingReplyInput = {
  store: SharedOnboardingOutboundStore
  userId: string
  sessionId: string
  turnId: string
  slot: SharedOnboardingQuestionId
  mode: OnboardingSurfaceMode
  promptContext: SharedOnboardingPromptContext
  userMessage: string
  agent: AgentDef
  reaskReason?: string
  reaskClarifyingQuestion?: string
  inboundMessageHandle?: string
  toE164?: string
}

export async function composeSharedOnboardingReply(
  input: ComposeSharedOnboardingReplyInput
): Promise<string> {
  const lang = detectLang(input.userMessage) === "zh" ? "zh" : "en"
  const template =
    input.mode === "reask"
      ? buildSharedOnboardingReask(input.slot, input.promptContext, {
          accept: false,
          reason:
            input.reaskReason === "declined" ||
            input.reaskReason === "irrelevant" ||
            input.reaskReason === "typo"
              ? input.reaskReason
              : "unclear",
          clarifyingQuestion: input.reaskClarifyingQuestion,
        })
      : buildSharedOnboardingPrompt(input.slot, input.promptContext)

  const agentic = await isSharedOnboardingAgenticSurfaceEnabled(input.store.db, input.userId)
  if (!agentic || !input.store.runAgentTurn) {
    const { text } = await applyTemplateOutboundHumanize({
      body: template,
      userId: input.userId,
      turnId: input.turnId,
      db: input.store.db,
    })
    return text
  }

  try {
    const profile = await resolveProfileForUser("friend_onboarding", input.userId)
    const choreoOn = await isBehaviorChoreographerEnabled(input.store.db, input.userId)
    const choreography = buildBehaviorChoreographyPlan({
      profile,
      turnId: input.turnId,
      userMessage: input.userMessage,
      recentHistory: [],
      mode: input.mode,
    })
    if (choreoOn) {
      const reactionEvent = choreography.reactionPlan.shouldReact
        ? "pa.choreo.reaction.fired"
        : "pa.choreo.reaction.suppressed"
      input.store.log(reactionEvent, {
        userId: input.userId,
        turnId: input.turnId,
        reason: choreography.reactionPlan.reason,
      })
      if (
        choreography.reactionPlan.shouldReact &&
        input.inboundMessageHandle &&
        input.toE164 &&
        input.store.sendReaction &&
        (await isReactionTapbackEnabled(input.store.db, input.userId))
      ) {
        const reaction = choreography.reactionPlan.reaction ?? "like"
        try {
          await input.store.sendReaction({
            toE164: input.toE164,
            messageHandle: input.inboundMessageHandle,
            reaction,
          })
          input.store.log("pa.choreo.reaction.tapback_sent", {
            userId: input.userId,
            turnId: input.turnId,
            reaction,
          })
        } catch (err) {
          input.store.log("pa.choreo.reaction.tapback_failed", {
            userId: input.userId,
            turnId: input.turnId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    const surfaceIntent = buildOnboardingSurfaceIntent({
      slot: input.slot,
      promptContext: input.promptContext,
      mode: input.mode,
      voiceProfile: profile,
      ackHint: choreography.ackHint,
    })

    const systemInputs = [
      injectVoiceProfilePrefix("", profile, lang),
      surfaceIntent,
      choreography.slangDirective,
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0)

    const findMatchOn = await isFindMatchToolEnabled(input.store.db, input.userId)
    let tools = input.store.buildTurnTools
      ? await input.store.buildTurnTools(input.agent, {
          turnId: input.turnId,
          userId: input.userId,
          sessionId: input.sessionId,
        })
      : []
    if (!findMatchOn) {
      tools = tools.filter((t) => t.name !== "find-match")
    }

    const systemPrompt = injectVoiceProfilePrefix(input.agent.systemPrompt, profile, lang)
    const syntheticUser =
      input.userMessage.trim() ||
      `[ONBOARDING] Ask the candidate the ${input.slot} question in friend tone. Do not extract tags — only compose the SMS.`

    const session =
      input.store.createSession?.({
        sessionId: input.sessionId,
        userId: input.userId,
      }) ?? null
    if (!session) throw new Error("createSession_not_configured")

    const runTurn = input.store.runAgentTurn as unknown as (ctx: {
      agent: AgentDef
      systemPrompt: string
      userMessage: string
      history: []
      memoryBlock: string
      session: AgentsSdkSession
      systemInputs: string[]
      tools: AgentTurnTool[]
    }) => Promise<{ text?: string | null }>
    const { text } = await runTurn({
      agent: input.agent,
      systemPrompt,
      userMessage: syntheticUser,
      history: [],
      memoryBlock: "",
      session,
      systemInputs,
      tools,
    })

    const trimmed = (text ?? "").trim()
    if (!trimmed) throw new Error("empty_agent_reply")
    const { text: safe } = await applyTemplateOutboundHumanize({
      body: trimmed,
      userId: input.userId,
      turnId: input.turnId,
      db: input.store.db,
      maxLength: profile.invariants.lengthCapChars,
    })
    input.store.log("pa.shared_onboarding.agentic_surface.applied", {
      userId: input.userId,
      turnId: input.turnId,
      slot: input.slot,
      mode: input.mode,
    })
    return safe
  } catch (err) {
    input.store.log("pa.shared_onboarding.agentic_surface.fallback", {
      userId: input.userId,
      turnId: input.turnId,
      error: err instanceof Error ? err.message : String(err),
    })
    if (process.env.PA_SHARED_ONBOARDING_TEMPLATE_FALLBACK === "false") {
      throw err
    }
    const { text } = await applyTemplateOutboundHumanize({
      body: template,
      userId: input.userId,
      turnId: input.turnId,
      db: input.store.db,
    })
    return text
  }
}

export async function deliverSharedOnboardingJobRecs(input: {
  store: SharedOnboardingOutboundStore
  db: Firestore
  event: InboundEvent
  turnId: string
  agent: AgentDef
  userMessage: string
}): Promise<{ recCount: number; reply: string }> {
  const lang =
    detectLang(`${input.userMessage}\n${input.event.body}`) === "zh" ? "zh" : "en"
  const gen = input.store.generateJobRecs
  if (!gen) {
    return {
      recCount: 0,
      reply:
        lang === "zh"
          ? "收到。我会尽快给你推两个具体岗位。"
          : "Got it. I saved that context and will send two concrete roles once I pull a fresh batch.",
    }
  }

  const findMatchOn = await isFindMatchToolEnabled(input.db, input.event.userId)
  const narrationOn = await isConnectorNarrationEnabled(input.db, input.event.userId)
  const connectorName: ConnectorName = "find-match"

  if (findMatchOn && narrationOn && input.store.enqueueOutbound) {
    try {
      const hooks = buildMatchConnectorHooks({ db: input.db, generateJobRecs: gen })
      const { result } = await runConnectorWithNarration({
        db: input.db,
        connectorName,
        args: { lang, requestedCount: 2, source: "shared_onboarding_complete" },
        lang,
        source: "shared_onboarding_complete",
        ctx: {
          db: input.db,
          agent: input.agent,
          turnId: input.turnId,
          userId: input.event.userId,
          sessionId: input.event.sessionId,
          hooks,
        },
        outbound: {
          sendPreCallBubble: async (text) => {
            await input.store.enqueueOutbound!(input.event.userId, input.event.from, text, {
              sessionId: input.event.sessionId,
              role: "assistant",
              idempotencyKey: `outbound-pre-${input.event.id}`,
            })
          },
          pulseTyping: async () => {
            /* typing indicator best-effort — broker may not support yet */
          },
        },
        log: (name, payload) => input.store.log(name, payload),
      })
      const parsed = result as { jobCount?: number; message?: string | null }
      const jobCount = parsed.jobCount ?? 0
      const frame = frameConnectorResult(connectorName, lang, jobCount)
      const body =
        jobCount > 0 && parsed.message
          ? [frame, parsed.message].filter(Boolean).join("\n")
          : lang === "zh"
            ? "收到。我这边还在捞更合适的岗，有匹配的第一时间发你。"
            : "Got it — still pulling a tighter batch; I'll ping you when two look right."
      const { text } = await applyTemplateOutboundHumanize({
        body,
        userId: input.event.userId,
        turnId: input.turnId,
        db: input.db,
      })
      return { recCount: jobCount, reply: text }
    } catch (err) {
      input.store.log("pa.shared_onboarding.find_match.fallback", {
        userId: input.event.userId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const recs = await gen(input.event.userId, lang, { force: true, requestedCount: 2 })
  const recCount = recs?.recCount ?? 0
  const reply =
    recs && recCount > 0
      ? recs.message
      : lang === "zh"
        ? "收到。我会尽快给你推两个具体岗位。"
        : "Got it. I saved that context and will send two concrete roles once I pull a fresh batch."
  const { text } = await applyTemplateOutboundHumanize({
    body: reply,
    userId: input.event.userId,
    turnId: input.turnId,
    db: input.db,
  })
  return { recCount, reply: text }
}
