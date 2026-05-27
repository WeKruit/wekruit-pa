import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, type AgentDef, type InboundEvent } from "@pa/core-types"
import { getFlag } from "@pa/pa-persistence"
import { detectLang } from "./voice/imperfection-injector/index.js"
import type { ConnectorName } from "@pa/pa-connectors"
import { buildMatchConnectorHooks, type GenerateJobRecsFn } from "./match-connector-hooks.js"
import { startPostMatchRetentionAfterJobRecs } from "./post-match-retention.js"
import {
  frameConnectorResult,
  isConnectorNarrationEnabled,
  runConnectorWithNarration,
} from "./run-connector-with-narration.js"
import {
  buildSharedOnboardingOpeningPrompt,
  buildSharedOnboardingPostPrescreenOpeningPrompt,
  buildSharedOnboardingPrompt,
  buildSharedOnboardingReask,
  isSharedOnboardingGreetingOrKickoff,
  type SharedOnboardingPostPrescreenContext,
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
import { detectOnboardingTangent } from "./voice/tangent-detector.js"
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

export async function isCollabMatchToolEnabled(
  db: Firestore | undefined,
  userId: string
): Promise<boolean> {
  if (!db) return false
  try {
    return (await getFlag(db, "paCollabMatchToolEnabled", { userId, env: process.env })) === true
  } catch {
    return false
  }
}

/** Agent allowlist with per-user connector flags applied. */
export async function resolveAgentAllowedConnectors(
  db: Firestore | undefined,
  userId: string,
  allowedConnectors: string[] | undefined
): Promise<string[]> {
  const base = allowedConnectors ?? []
  if (base.length === 0) return []
  const withRuntimeRequired = base.includes("set-daily-job-recommendation-subscription")
    ? base
    : [...base, "set-daily-job-recommendation-subscription"]
  const collabOn = await isCollabMatchToolEnabled(db, userId)
  if (collabOn) return [...withRuntimeRequired]
  return withRuntimeRequired.filter((name) => name !== "match-against-collab-jobs")
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

/** Cap on the FIFO of slang picks we keep on the user doc (Adam 2026-05-19). */
export const SHARED_ONBOARDING_SLANG_PICK_CAP = 12

/**
 * Read recent slang picks for cross-turn dedupe. Reads from
 * `pa-users.sharedOnboarding.voice.recentSlangPicks`. Tolerant of missing
 * fields (returns []) so we never block compose on a state-read hiccup.
 */
export function extractRecentSlangPicks(
  onboardingUser: { sharedOnboarding?: Record<string, unknown> | null } | null,
): string[] {
  if (!onboardingUser?.sharedOnboarding) return []
  const voice = (onboardingUser.sharedOnboarding as { voice?: unknown }).voice
  if (!voice || typeof voice !== "object") return []
  const raw = (voice as { recentSlangPicks?: unknown }).recentSlangPicks
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0 && out.length < SHARED_ONBOARDING_SLANG_PICK_CAP) {
      out.push(entry)
    }
  }
  return out
}

function dedupAppend(prev: readonly string[], next: readonly string[], cap: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const term of [...prev, ...next]) {
    if (typeof term !== "string" || term.length === 0) continue
    if (seen.has(term)) continue
    seen.add(term)
    out.push(term)
  }
  // FIFO cap — newer entries (passed in next, listed last) should stay; drop oldest.
  if (out.length > cap) return out.slice(out.length - cap)
  return out
}

/**
 * Merge fresh slang picks into the user's `sharedOnboarding.voice.recentSlangPicks`
 * FIFO. Caller passes the picks surfaced this turn — we read the cached prior
 * list, dedupe, cap at 12, and merge-write. Never throws; failures emit a log
 * event so the inbound turn can still succeed.
 */
export async function persistSharedOnboardingSlangPicks(input: {
  db: Firestore | undefined
  userId: string
  priorPicks: readonly string[]
  newPicks: readonly string[]
  nowIso: string
  log?: (name: string, payload?: Record<string, unknown>) => void
}): Promise<string[]> {
  const next = dedupAppend(input.priorPicks, input.newPicks, SHARED_ONBOARDING_SLANG_PICK_CAP)
  if (next.length === 0) return next
  const sameAsPrior =
    next.length === input.priorPicks.length &&
    next.every((t, i) => t === input.priorPicks[i])
  if (sameAsPrior) return next
  if (!input.db) return next
  try {
    await input.db.collection(PA_COLLECTIONS.users).doc(input.userId).set(
      {
        sharedOnboarding: {
          voice: {
            recentSlangPicks: next,
            updatedAt: input.nowIso,
          },
        },
      },
      { merge: true },
    )
  } catch (err) {
    input.log?.("pa.shared_onboarding.voice.persist_failed", {
      userId: input.userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return next
}

/** Router-resolved compose contract — single chain from index handlers → agentic surface. */
export type SharedOnboardingInboundKind =
  | "greeting_kickoff"
  | "post_prescreen_kickoff"
  | "user_answer"
  | "runtime_event"

export type SharedOnboardingRouterResult =
  | "bootstrapped_q1_inline"
  | "asked_question"
  | "reasked_question"
  | "advanced_despite_judge"
  | "ignored_non_answer"
  | "sent_recs"
  | "saved_without_recs"

export type SharedOnboardingComposeContext = {
  inboundKind: SharedOnboardingInboundKind
  routerResult: SharedOnboardingRouterResult
  slot: SharedOnboardingQuestionId
  mode: OnboardingSurfaceMode
  /** Router-resolved; compose must not re-infer lang from raw greeting on kickoff. */
  lang: "en" | "zh"
  postPrescreenContext?: SharedOnboardingPostPrescreenContext | null
}

export function buildSharedOnboardingComposeContext(input: {
  inboundKind: SharedOnboardingInboundKind
  routerResult: SharedOnboardingRouterResult
  slot: SharedOnboardingQuestionId
  mode: OnboardingSurfaceMode
  /** Used for lang when inboundKind is user_answer; ignored on kickoff/runtime. */
  userMessage?: string
  postPrescreenContext?: SharedOnboardingPostPrescreenContext | null
}): SharedOnboardingComposeContext {
  const lang =
    input.inboundKind === "greeting_kickoff" || input.inboundKind === "post_prescreen_kickoff" || input.inboundKind === "runtime_event"
      ? "en"
      : detectLang(input.userMessage ?? "") === "zh"
        ? "zh"
        : "en"
  return {
    inboundKind: input.inboundKind,
    routerResult: input.routerResult,
    slot: input.slot,
    mode: input.mode,
    lang,
    postPrescreenContext: input.postPrescreenContext ?? null,
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
  recentMessages?: readonly SharedOnboardingConversationMessage[]
  /** Router decision — authoritative for synthetic user turn + lang lock. */
  composeContext: SharedOnboardingComposeContext
  agent: AgentDef
  reaskReason?: string
  reaskClarifyingQuestion?: string
  /** Force the agentic wording path for recovery turns that must not feel templated. */
  forceAgentic?: boolean
  inboundMessageHandle?: string
  toE164?: string
  /**
   * Recent slang picks surfaced on prior turns for this user. Threaded
   * to the slang injector so the palette rotates across turns and the
   * LLM cannot lead with the same opener twice in a row. Caller is
   * responsible for persisting the returned `slangPicked` back to the
   * user doc after compose succeeds.
   */
  recentSlangPicks?: readonly string[]
}

export type SharedOnboardingConversationMessage = {
  role?: "assistant" | "user" | "system"
  body: string
  createdAt?: string
}

/**
 * Compose result — `text` is the SMS body to enqueue, `slangPicked` are
 * the palette terms surfaced this turn (cross-turn dedupe input for the
 * NEXT turn). Empty array when the slang injector did not run (template
 * fallback or choreographer disabled).
 */
export type ComposedSharedOnboardingReply = {
  text: string
  slangPicked: string[]
}

function isKickoffComposeKind(kind: SharedOnboardingInboundKind): boolean {
  return kind === "greeting_kickoff" || kind === "post_prescreen_kickoff" || kind === "runtime_event"
}

/** Greeting/kickoff must not become the agent user turn — bootstrap should ask canonical Q1. */
export function effectiveOnboardingComposeUserMessage(input: {
  mode: OnboardingSurfaceMode
  userMessage: string
  composeContext?: SharedOnboardingComposeContext
}): string {
  const trimmed = input.userMessage.trim()
  if (input.composeContext && isKickoffComposeKind(input.composeContext.inboundKind)) {
    return ""
  }
  if (!input.composeContext && input.mode === "ask" && isSharedOnboardingGreetingOrKickoff(trimmed)) {
    return ""
  }
  return trimmed
}

function quoteForInstruction(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim()
  return clean.length > 180 ? `${clean.slice(0, 177)}...` : clean
}

function buildSyntheticOnboardingUserInstruction(
  slot: SharedOnboardingQuestionId,
  input?: {
    mode?: OnboardingSurfaceMode
    routerResult?: SharedOnboardingRouterResult
    userMessage?: string
  },
): string {
  const label = sharedOnboardingSlotCopyLabel(slot)
  const current = input?.userMessage?.trim()
  if (input?.mode === "reask") {
    return [
      `[ONBOARDING CONTINUATION] The candidate just replied${current ? `: "${quoteForInstruction(current)}"` : "."}`,
      `That did not answer the active ${label} slot.`,
      "Continue from the existing SMS thread. Do not restart the conversation, do not welcome them again, do not say their resume came through, and do not introduce Claire again.",
      `Briefly re-ask the ${label} question only. Do not extract tags; only compose the SMS.`,
    ].join(" ")
  }
  if (input?.routerResult === "asked_question" || input?.routerResult === "advanced_despite_judge") {
    return [
      `[ONBOARDING CONTINUATION] The candidate just answered the previous onboarding slot${current ? `: "${quoteForInstruction(current)}"` : "."}`,
      "Continue from the existing SMS thread. Do not restart the conversation, do not welcome them again, do not say their resume came through, and do not introduce Claire again.",
      "Start with one short acknowledgement grounded in that exact answer, then ask the next question.",
      "Keep the visible SMS short: one acknowledgement clause, then one compact question.",
      `Ask the next ${label} question only after that acknowledgement. Do not extract tags; only compose the SMS.`,
    ].join(" ")
  }
  return `[ONBOARDING CONTINUATION] Ask the candidate the ${label} onboarding question in friend tone. Continue from the existing SMS thread; do not restart, welcome, introduce Claire, or mention resume intake. Do not extract tags; only compose the SMS.`
}

function buildSyntheticOpeningUserInstruction(slot: SharedOnboardingQuestionId): string {
  return `[ONBOARDING] Compose the opening welcome and ${sharedOnboardingSlotCopyLabel(slot)} onboarding question in warm SMS tone. The candidate already sent the required opener with their user id. Do not extract tags; only compose the SMS.`
}

function buildSyntheticPostPrescreenOpeningUserInstruction(
  slot: SharedOnboardingQuestionId,
  context?: SharedOnboardingPostPrescreenContext | null,
): string {
  const jobTitle = context?.jobTitle ? ` Role: ${context.jobTitle}.` : ""
  const company = context?.company ? ` Company: ${context.company}.` : ""
  return `[ONBOARDING] Compose the post-prescreen opening and ${sharedOnboardingSlotCopyLabel(slot)} onboarding question in warm SMS tone. The candidate just completed the role-fit screen.${jobTitle}${company} Do not extract tags; only compose the SMS. Do not use first-time resume-ingest copy.`
}

function sharedOnboardingSlotCopyLabel(slot: SharedOnboardingQuestionId): string {
  if (slot === "main_goal") return "main goal for the next company"
  if (slot === "culture_stage") return "company culture and size or stage"
  if (slot === "industry_interest") return "industry or domain"
  if (slot === "location_relocation") return "location and work style"
  return "extra context before matching"
}

function buildRecentTranscriptSystemInput(input: {
  messages?: readonly SharedOnboardingConversationMessage[]
  userMessage: string
  opening: boolean
}): string | null {
  if (input.opening) return null
  const lines = (input.messages ?? [])
    .filter((message) => message.role === "assistant" || message.role === "user")
    .map((message) => {
      const body = message.body.replace(/\s+/g, " ").trim()
      if (!body) return null
      const speaker = message.role === "assistant" ? "Claire" : "Candidate"
      const clipped = body.length > 240 ? `${body.slice(0, 237)}...` : body
      return `${speaker}: ${clipped}`
    })
    .filter((line): line is string => Boolean(line))
    .slice(-8)
  const current = input.userMessage.replace(/\s+/g, " ").trim()
  if (current && !lines.some((line) => line.endsWith(current))) {
    lines.push(`Candidate: ${current.length > 240 ? `${current.slice(0, 237)}...` : current}`)
  }
  if (lines.length === 0 && !current) return null
  return [
    "Recent SMS transcript, oldest to newest:",
    ...lines,
    "",
    "Use this transcript as the conversation state. The next reply must continue from the latest Claire bubble, not restart onboarding.",
    "Do not copy odd prior Claire phrasing; if the previous Claire bubble used slang or a performative opener, correct course and reply plainly.",
    "If the candidate's latest message is a short ambiguous acknowledgment, treat it as unclear for the active slot and re-ask plainly.",
  ].join("\n")
}

function violatesSharedOnboardingContinuationDraft(text: string): boolean {
  return /\b(?:lowkey|manifest|manifesting|deadass|delulu|npc|fr fr)\b/i.test(text) ||
    /\b(?:saw|seen)\s+your\s+resume\s+(?:come|came)\s+through\b/i.test(text) ||
    /\bi['’]?m\s+claire\b/i.test(text) ||
    /\bwelcome\b.{0,30}\b(?:wekruit|claire)\b/i.test(text)
}

const PROTECTED_VISIBLE_TOKEN_SEGMENT_RE =
  /(https?:\/\/[^\s)]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi

const VISIBLE_SNAKE_TOKEN_RE = /\b(?=[a-z0-9_]*[a-z])[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gi
const VISIBLE_KEBAB_TOKEN_RE = /\b(?=[a-z0-9-]*[a-z])[a-z][a-z0-9]*(?:-[a-z0-9]+){2,}\b/gi

const VISIBLE_TOKEN_ACRONYMS: Readonly<Record<string, string>> = {
  ai: "AI",
  api: "API",
  cpt: "CPT",
  h1b: "H1B",
  h1: "H1",
  ios: "iOS",
  ml: "ML",
  opt: "OPT",
  qa: "QA",
  swe: "SWE",
  ui: "UI",
  uk: "UK",
  us: "US",
  usa: "USA",
  ux: "UX",
}

function humanizeInternalTokenPart(part: string): string {
  const key = part.trim().toLowerCase()
  return VISIBLE_TOKEN_ACRONYMS[key] ?? key
}

function humanizeVisibleInternalToken(token: string): string {
  return token
    .split(/[_-]+/g)
    .map(humanizeInternalTokenPart)
    .filter(Boolean)
    .join(" ")
}

export function humanizeVisibleInternalTokens(text: string): string {
  if (!text.trim()) return text
  return text
    .split(PROTECTED_VISIBLE_TOKEN_SEGMENT_RE)
    .map((segment) => {
      if (PROTECTED_VISIBLE_TOKEN_SEGMENT_RE.test(segment)) {
        PROTECTED_VISIBLE_TOKEN_SEGMENT_RE.lastIndex = 0
        return segment
      }
      PROTECTED_VISIBLE_TOKEN_SEGMENT_RE.lastIndex = 0
      return segment
        .replace(VISIBLE_SNAKE_TOKEN_RE, humanizeVisibleInternalToken)
        .replace(VISIBLE_KEBAB_TOKEN_RE, humanizeVisibleInternalToken)
    })
    .join("")
}

function finalizeSharedOnboardingSmsText(text: string): string {
  return humanizeVisibleInternalTokens(text)
}

export async function composeSharedOnboardingReply(
  input: ComposeSharedOnboardingReplyInput
): Promise<ComposedSharedOnboardingReply> {
  const composeUserMessage = effectiveOnboardingComposeUserMessage({
    mode: input.mode,
    userMessage: input.userMessage,
    composeContext: input.composeContext,
  })
  const lang = input.composeContext.lang
  const opening =
    input.mode === "ask" &&
    input.slot === "main_goal" &&
    isKickoffComposeKind(input.composeContext.inboundKind)
  const postPrescreenOpening = opening && input.composeContext.inboundKind === "post_prescreen_kickoff"
  const template =
    opening
      ? postPrescreenOpening
        ? buildSharedOnboardingPostPrescreenOpeningPrompt(input.promptContext, input.composeContext.postPrescreenContext)
        : buildSharedOnboardingOpeningPrompt(input.promptContext)
      : input.mode === "reask"
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

  const agentic = input.forceAgentic === true || await isSharedOnboardingAgenticSurfaceEnabled(input.store.db, input.userId)
  if (!agentic || !input.store.runAgentTurn) {
    if (input.forceAgentic === true) {
      throw new Error("shared_onboarding_agentic_surface_required")
    }
    const { text } = await applyTemplateOutboundHumanize({
      body: template,
      userId: input.userId,
      turnId: input.turnId,
      db: input.store.db,
      allowImperfection: false,
    })
    return { text: finalizeSharedOnboardingSmsText(text), slangPicked: [] }
  }

  try {
    const profile = await resolveProfileForUser("friend_onboarding", input.userId)
    const choreoOn = await isBehaviorChoreographerEnabled(input.store.db, input.userId)
    // Upgrade choreographer mode to ack_then_ask for culture_stage when we're
    // about to ask Q2 right after the user answered Q1 (or any prior slot).
    // This lets the friend roommate briefly mirror what they volunteered
    // before pivoting to the next question — Adam 2026-05-19 plan §2 ack_then_ask.
    // We don't touch reask / runtime_event / kickoff branches; only the
    // user_answer → ask transition into culture_stage qualifies.
    const choreoMode: "ask" | "reask" | "ack_then_ask" | "tangent_then_ask" | "deliver" =
      input.mode === "ask" && input.composeContext.inboundKind === "user_answer"
        ? "ack_then_ask"
        : input.mode
    const choreography = buildBehaviorChoreographyPlan({
      profile,
      turnId: input.turnId,
      userMessage: composeUserMessage || input.userMessage,
      recentHistory: [],
      mode: choreoMode,
      recentSlangPicks: input.recentSlangPicks,
    })
    if (choreoOn) {
      input.store.log(
        choreography.reactionPlan.shouldReact
          ? "pa.choreo.reaction.planned"
          : "pa.choreo.reaction.suppressed",
        {
          userId: input.userId,
          turnId: input.turnId,
          reason: choreography.reactionPlan.reason,
          delivery: "outbound_delivery_plan",
        },
      )
    }

    // Adam 2026-05-19 voice polish §6 — tangent detection.
    // We only run the detector when the inbound was an actual user_answer
    // AND we're in reask mode (judge already said the answer wasn't valid
    // for the slot). That gate prevents the detector from misclassifying
    // legitimate question-shaped answers on the happy path (e.g. "growth?
    // probably comp tbh").
    const tangent =
      input.mode === "reask" &&
      input.composeContext.inboundKind === "user_answer"
        ? detectOnboardingTangent({
            body: input.userMessage ?? "",
            lang,
          })
        : { isTangent: false, reason: "not_eligible" as const }
    if (tangent.isTangent) {
      input.store.log("pa.onboarding.tangent_detected", {
        userId: input.userId,
        turnId: input.turnId,
        slot: input.slot,
        reason: tangent.reason,
      })
    }

    const surfaceIntent = buildOnboardingSurfaceIntent({
      slot: input.slot,
      promptContext: input.promptContext,
      mode: input.mode,
      voiceProfile: profile,
      ackHint: choreography.ackHint,
      lang,
      tangentDetected: tangent.isTangent,
      opening,
      postPrescreenContext: input.composeContext.postPrescreenContext,
    })

    // Adam 2026-05-19 voice polish §4 — when the outbound delivery planner
    // might prepend a 👍 bubble before our SMS lands (emoji not banned +
    // choreographer on), instruct the LLM NOT to lead with the same glyph
    // in the body. The defensive strip in sendPlannedOutbound handles slips,
    // but a clean LLM body avoids the strip + log churn entirely.
    //
    // We can't pre-flight the exact mode here (planner needs the final text
    // for canSplit2), so the hint is bias-toward-no-emoji-opener regardless
    // of whether emoji actually ships this turn. Bilingual phrasing matches
    // the active language and follows the existing slangDirective register.
    const emojiHintCandidate =
      choreoOn && profile.resolvedEmoji !== "banned"
        ? lang === "zh"
          ? "用户可能先收到一个独立的 👍 表情消息——你的正文不要再以 👍 / 大拇指 / 点赞 开头，直接进入问题或确认。"
          : "User may receive a separate 👍 bubble first — do NOT open your SMS with 👍 / thumbs-up. Lead with the question or a one-beat ack instead."
        : null

    // Shared onboarding needs to feel human, not performatively casual. Random
    // slang palettes have produced visible openers like "lowkey manifest",
    // which is worse than a plain contextual re-ask.
    const slangDirective = null
    const slangPicked: string[] = []
    const transcriptInput = buildRecentTranscriptSystemInput({
      messages: input.recentMessages,
      userMessage: input.userMessage,
      opening,
    })
    const systemInputs = [
      injectVoiceProfilePrefix("", profile, lang),
      surfaceIntent,
      transcriptInput,
      slangDirective,
      emojiHintCandidate,
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0)

    const findMatchOn = await isFindMatchToolEnabled(input.store.db, input.userId)
    let tools = input.store.buildTurnTools
      ? await input.store.buildTurnTools(input.agent, {
          turnId: input.turnId,
          userId: input.userId,
          sessionId: input.sessionId,
        })
      : []
    const collabOn = await isCollabMatchToolEnabled(input.store.db, input.userId)
    if (!findMatchOn) {
      tools = tools.filter((t) => t.name !== "find-match")
    }
    if (!collabOn) {
      tools = tools.filter((t) => t.name !== "match-against-collab-jobs")
    }

    const systemPrompt = injectVoiceProfilePrefix(input.agent.systemPrompt, profile, lang)
    const syntheticUser =
      opening
        ? postPrescreenOpening
          ? buildSyntheticPostPrescreenOpeningUserInstruction(input.slot, input.composeContext.postPrescreenContext)
          : buildSyntheticOpeningUserInstruction(input.slot)
        : buildSyntheticOnboardingUserInstruction(input.slot, {
            mode: input.mode,
            routerResult: input.composeContext.routerResult,
            userMessage: composeUserMessage || input.userMessage,
          })

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
      history: SharedOnboardingConversationMessage[]
      memoryBlock: string
      session: AgentsSdkSession
      systemInputs: string[]
      tools: AgentTurnTool[]
    }) => Promise<{ text?: string | null }>
    const firstTurn = await runTurn({
      agent: input.agent,
      systemPrompt,
      userMessage: syntheticUser,
      history: [...(input.recentMessages ?? [])],
      memoryBlock: "",
      session,
      systemInputs,
      tools,
    })

    let trimmed = (firstTurn.text ?? "").trim()
    if (!trimmed) throw new Error("empty_agent_reply")
    if (!opening && violatesSharedOnboardingContinuationDraft(trimmed)) {
      input.store.log("pa.shared_onboarding.agentic_surface.retry_continuation", {
        userId: input.userId,
        turnId: input.turnId,
        slot: input.slot,
        mode: input.mode,
      })
      try {
        await session.popItem()
      } catch (popErr) {
        input.store.log("pa.shared_onboarding.agentic_surface.retry_pop_failed", {
          userId: input.userId,
          turnId: input.turnId,
          error: popErr instanceof Error ? popErr.message : String(popErr),
        })
      }
      const retry = await runTurn({
        agent: input.agent,
        systemPrompt,
        userMessage: [
          syntheticUser,
          "Your previous draft restarted the conversation or copied awkward prior wording. Rewrite it as a continuation only: no welcome, no resume-intake line, no Claire intro, no slang. One plain re-ask for the active slot.",
        ].join("\n\n"),
        history: [...(input.recentMessages ?? [])],
        memoryBlock: "",
        session,
        systemInputs,
        tools,
      })
      trimmed = (retry.text ?? "").trim()
      if (!trimmed) throw new Error("empty_agent_retry_reply")
      if (violatesSharedOnboardingContinuationDraft(trimmed)) {
        input.store.log("pa.shared_onboarding.agentic_surface.retry_rejected", {
          userId: input.userId,
          turnId: input.turnId,
          slot: input.slot,
          mode: input.mode,
        })
        trimmed = template
      }
    }
    const { text: safe } = await applyTemplateOutboundHumanize({
      body: trimmed,
      userId: input.userId,
      turnId: input.turnId,
      db: input.store.db,
      maxLength: profile.invariants.lengthCapChars,
      allowImperfection: false,
    })
    input.store.log("pa.shared_onboarding.agentic_surface.applied", {
      userId: input.userId,
      turnId: input.turnId,
      slot: input.slot,
      mode: input.mode,
      inboundKind: input.composeContext.inboundKind,
      routerResult: input.composeContext.routerResult,
      slangPaletteSize: slangPicked.length,
    })
    return { text: finalizeSharedOnboardingSmsText(safe), slangPicked }
  } catch (err) {
    input.store.log("pa.shared_onboarding.agentic_surface.fallback", {
      userId: input.userId,
      turnId: input.turnId,
      error: err instanceof Error ? err.message : String(err),
    })
    if (input.forceAgentic === true) {
      throw err
    }
    if (process.env.PA_SHARED_ONBOARDING_TEMPLATE_FALLBACK === "false") {
      throw err
    }
    const { text } = await applyTemplateOutboundHumanize({
      body: template,
      userId: input.userId,
      turnId: input.turnId,
      db: input.store.db,
      allowImperfection: false,
    })
    return { text: finalizeSharedOnboardingSmsText(text), slangPicked: [] }
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
        args: {
          lang,
          requestedCount: 2,
          source: "shared_onboarding_complete",
          roleFocus: null,
          hardConstraintsActive: false,
          allowBroadFallback: false,
        },
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
            await input.store.enqueueOutbound!(input.event.userId, input.event.from, finalizeSharedOnboardingSmsText(text), {
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
      await startPostMatchRetentionAfterJobRecs({
        db: input.db,
        userId: input.event.userId,
        recCount: jobCount,
        sessionId: input.event.sessionId,
        toE164: input.event.from,
        lang,
        enqueueOutbound: input.store.enqueueOutbound,
      })
      return { recCount: jobCount, reply: finalizeSharedOnboardingSmsText(text) }
    } catch (err) {
      input.store.log("pa.shared_onboarding.find_match.fallback", {
        userId: input.event.userId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const recs = await gen(input.event.userId, lang, { force: true, requestedCount: 2, allowBroadFallback: false })
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
  await startPostMatchRetentionAfterJobRecs({
    db: input.db,
    userId: input.event.userId,
    recCount,
    sessionId: input.event.sessionId,
    toE164: input.event.from,
    lang,
    enqueueOutbound: input.store.enqueueOutbound,
  })
  return { recCount, reply: finalizeSharedOnboardingSmsText(text) }
}
