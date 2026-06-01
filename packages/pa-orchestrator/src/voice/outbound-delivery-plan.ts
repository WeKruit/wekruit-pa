/**
 * Adam 2026-05-19 voice polish plan §3 — Unified outbound delivery plan.
 *
 * BACKGROUND
 * ----------
 * The pre-2026-05-19 outbound stack was two parallel paths:
 *
 *   - Main runtime (index.ts handlePaInbound)
 *     decideReplySplit → enqueue 1 or 2 SMS bubbles.
 *     No tapback. No emoji-SMS. Pure split decision.
 *
 *   - Shared onboarding compose (shared-onboarding-outbound.ts)
 *     Optional tapback gated on emotional weight ≥ 2 (reaction-policy.ts).
 *     Then sendMemoryReply → single SMS, no split.
 *
 * Adam directive 2026-05-19: "send a 👍 and then another message", "this is
 * not just tap back, but also directly sending the emoji, but lets keep it
 * agentic and randomized", "this should apply to overall agent runtime the
 * way we send outbound, not just tapback, sometiems 1 sms, sometimes 2,
 * sometiems single emoji + sms". This module is the planner that unifies
 * those two paths under a single seeded-randomized strategy while honoring
 * the hard ≤2-SMS-per-turn invariant.
 *
 * DESIGN
 * ------
 * Inputs:
 *   - reply        — full visible text to ship (already humanized)
 *   - turnId       — deterministic seed (mulberry32, FNV-1a fold)
 *   - profile      — ResolvedVoiceProfile (emoji policy + reactions gate)
 *   - inboundBody  — last user message (for substantive-answer boost)
 *   - force1       — kickoff / crisis / job-rec explanation forces text_only_1
 *   - hasMessageHandle — tapback requires a Sendblue messageHandle
 *
 * Five modes (seeded weighted_random, then defensive snap to legal set):
 *
 *   | mode               | weight (substantive boost) | sms bubbles |
 *   |--------------------|----------------------------|-------------|
 *   | text_only_1        | 0.45  (→ 0.35)             | 1 text      |
 *   | text_split_2       | 0.25  (→ 0.25)             | 2 text      |
 *   | emoji_then_text    | 0.15  (→ 0.20)             | 1 emoji+1 text |
 *   | tapback_then_text  | 0.10  (→ 0.13)             | 1-2 text + free tapback |
 *   | tapback_emoji_text | 0.05  (→ 0.07)             | 1 emoji + 1 text + free tapback |
 *
 * Hard invariant (matches index.ts:3856 invariant_violation guard): SMS
 * bubbles ≤ 2 ALWAYS. Tapback does NOT count toward the SMS cap — it ships
 * on a separate Sendblue endpoint (sendReaction). So emoji + 2 text is
 * forbidden — the planner downgrades to emoji + 1 text whenever emoji is
 * planned.
 *
 * Hard-skip conditions (apply BEFORE mode selection):
 *   - force1 → always text_only_1
 *   - profile.resolvedEmoji === "banned" → strip all emoji modes
 *   - profile.choreography.reactionsAllowed === false → strip all tapback modes
 *   - hasMessageHandle === false → strip all tapback modes (Sendblue API contract)
 *
 * If after stripping no modes survive (extreme corner — e.g. emoji banned
 * AND reactions blocked AND we drew emoji+tapback), we fall back to
 * text_only_1 — never silently fail.
 */
import type { ResolvedVoiceProfile } from "./voice-profiles/index.js"
import { decideReplySplit } from "./probabilistic-split.js"

export type OutboundDeliveryMode =
  | "text_only_1"
  | "text_split_2"
  | "emoji_then_text"
  | "tapback_then_text"
  | "tapback_emoji_text"

export type OutboundReaction = "like" | "love" | "emphasize" | "laugh"

export interface OutboundDeliveryPlan {
  mode: OutboundDeliveryMode
  /** Sendblue tapback to fire BEFORE any SMS. Undefined when not planned. */
  tapback?: OutboundReaction
  /** Single-emoji SMS to ship BEFORE textParts. Undefined when not planned. */
  leadingEmojiSms?: string
  /** SMS text bubbles to ship in order. Length 1 or 2. */
  textParts: string[]
  /** Plain-English explanation for telemetry / debugging. */
  reason: string
  /** Total SMS bubbles (leadingEmojiSms + textParts.length). MUST be ≤ 2. */
  smsCount: number
}

export interface PlanOutboundDeliveryInput {
  reply: string
  turnId: string
  profile: ResolvedVoiceProfile
  /** Latest inbound body — used for substantive-answer boost. */
  inboundBody?: string | null
  /** Kickoff / crisis / job-rec explanation force a single bubble, no flourish. */
  force1?: boolean
  /** Tapback requires a Sendblue messageHandle; without it we skip those modes. */
  hasMessageHandle?: boolean
  /**
   * Caller has already fired (or will fire) tapback elsewhere — strip all
   * tapback modes from the legal set so we don't double-fire. Shared
   * onboarding compose fires tapback inline today; pass `true` from those
   * callsites until the inline fire is fully migrated into this planner.
   */
  disableTapback?: boolean
  /** Reaction to fire if a tapback mode is chosen. Default "like". */
  preferredReaction?: OutboundReaction
  /** Override the default emoji glyph. Default "👍". */
  emojiGlyph?: string
}

/** Default weights — sum to 1.0 over the legal mode set. */
const BASE_WEIGHTS: Record<OutboundDeliveryMode, number> = {
  text_only_1: 0.45,
  text_split_2: 0.25,
  emoji_then_text: 0.15,
  tapback_then_text: 0.1,
  tapback_emoji_text: 0.05,
}

/** Substantive-inbound boost — bias toward warm flourishes on long, real answers. */
const SUBSTANTIVE_WEIGHTS: Record<OutboundDeliveryMode, number> = {
  text_only_1: 0.35,
  text_split_2: 0.25,
  emoji_then_text: 0.2,
  tapback_then_text: 0.13,
  tapback_emoji_text: 0.07,
}

const SUBSTANTIVE_MIN_CHARS = 40

// ---------------------------------------------------------------------------
// Seeded RNG — kept in-module so this file is dependency-light. Mirrors the
// mulberry32 + FNV-1a fold used by probabilistic-split.ts so the same
// turnId reproduces both the split decision and the mode pick.
// ---------------------------------------------------------------------------
function foldStringToUint32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildRng(seed: string | undefined): () => number {
  if (!seed || seed.length === 0) return Math.random
  // Suffix the seed namespace so we don't collide with probabilistic-split's
  // RNG stream (same seed → same draw would make the two decisions correlated
  // in non-obvious ways).
  return mulberry32(foldStringToUint32(`${seed}::outbound-delivery`))
}

function isEmojiModeAllowed(profile: ResolvedVoiceProfile): boolean {
  return profile.resolvedEmoji !== "banned"
}

/**
 * Short / low-information inbound predicate. Mirrors reaction-policy.ts
 * isShortReply so the tapback suppression here stays consistent with the
 * reaction gate. Used to strip tapback-bearing modes when the user only sent a
 * terse ack ("ok", "yes", "k", "got it"), preventing a tapback from co-firing
 * with a substantive text reply.
 */
function isShortInboundReply(inboundBody: string | null | undefined): boolean {
  if (typeof inboundBody !== "string") return false
  const t = inboundBody.trim()
  if (!t) return false
  return t.length <= 12 || /^(ok|okay|k|yeah|yep|yes|sure|got it|okok)$/i.test(t)
}

function isTapbackAllowed(profile: ResolvedVoiceProfile, hasMessageHandle: boolean | undefined): boolean {
  if (!profile.choreography.reactionsAllowed) return false
  if (!hasMessageHandle) return false
  return true
}

function pickModeWeighted(
  rng: () => number,
  weights: ReadonlyArray<[OutboundDeliveryMode, number]>,
): OutboundDeliveryMode {
  if (weights.length === 0) return "text_only_1"
  const total = weights.reduce((acc, [, w]) => acc + w, 0)
  if (total <= 0) return weights[0]![0]
  let draw = rng() * total
  for (const [mode, w] of weights) {
    draw -= w
    if (draw <= 0) return mode
  }
  return weights[weights.length - 1]![0]
}

/**
 * Plan outbound delivery — single seeded decision, returns the full delivery
 * recipe (tapback + emoji + 1-2 text parts) that callers should run sequentially.
 *
 * Callers MUST honor the order: tapback → leadingEmojiSms → textParts[0…].
 * The order is fixed because:
 *   1. tapback wraps the inbound message — must fire before our text lands.
 *   2. emoji bubble lands as a tiny "thinking…" / "got it" beat — text follows.
 */
export function planOutboundDelivery(input: PlanOutboundDeliveryInput): OutboundDeliveryPlan {
  const reply = input.reply ?? ""

  // ── Force-1 short-circuit ──────────────────────────────────────────────
  // Kickoff replies, crisis trailers, and job-rec explanations are all
  // semantically "ship as-is, no flourish". The main path already had
  // jobRecommendationExplanationDirective → split.count=1; we preserve it
  // here as a single mode so the planner is the single source of truth.
  if (input.force1) {
    return {
      mode: "text_only_1",
      textParts: [reply],
      reason: "force1",
      smsCount: 1,
    }
  }

  const rng = buildRng(input.turnId)
  const profile = input.profile

  const emojiAllowed = isEmojiModeAllowed(profile)
  // INTERIM guard (Adam plan: this layer is slated for LLM-decided delivery, P2).
  // A short / low-information inbound ("ok", "yes", "k", "got it") must not draw a
  // tapback-bearing mode, otherwise a heart/like co-fires alongside a substantive
  // text reply. Until delivery becomes LLM-decided, suppress the tapback modes on
  // short inbound replies. Mirrors reaction-policy.ts isShortReply.
  const shortInbound = isShortInboundReply(input.inboundBody)
  const tapbackAllowed =
    !input.disableTapback && !shortInbound && isTapbackAllowed(profile, input.hasMessageHandle)

  // Sentence/length checks — short replies cannot honor 2-bubble modes.
  // We probe the splitter once; if it forces 1 (single sentence, hotline,
  // mem0 marker, etc.), we drop split_2 / tapback_then_text-with-split.
  const split = decideReplySplit(reply, { seed: input.turnId })
  const canSplit2 = split.count === 2 && split.parts.length === 2

  const substantive =
    typeof input.inboundBody === "string" && input.inboundBody.trim().length >= SUBSTANTIVE_MIN_CHARS
  const weightTable = substantive ? SUBSTANTIVE_WEIGHTS : BASE_WEIGHTS

  // Build the legal mode list, filtering modes blocked by profile/handle.
  const legal: Array<[OutboundDeliveryMode, number]> = []
  for (const [mode, w] of Object.entries(weightTable) as Array<[OutboundDeliveryMode, number]>) {
    if (mode === "text_split_2" && !canSplit2) continue
    if ((mode === "emoji_then_text" || mode === "tapback_emoji_text") && !emojiAllowed) continue
    if ((mode === "tapback_then_text" || mode === "tapback_emoji_text") && !tapbackAllowed) continue
    legal.push([mode, w])
  }

  // Defensive: if everything was stripped, fall back to text_only_1.
  if (legal.length === 0) {
    return {
      mode: "text_only_1",
      textParts: [reply],
      reason: "all_modes_stripped",
      smsCount: 1,
    }
  }

  const mode = pickModeWeighted(rng, legal)
  const reaction = input.preferredReaction ?? "like"
  const emoji = input.emojiGlyph ?? "👍"

  switch (mode) {
    case "text_only_1":
      return {
        mode,
        textParts: [reply],
        reason: substantive ? "substantive_text_only" : "weighted_text_only",
        smsCount: 1,
      }
    case "text_split_2":
      return {
        mode,
        textParts: split.parts,
        reason: substantive ? "substantive_split_2" : "weighted_split_2",
        smsCount: 2,
      }
    case "emoji_then_text":
      // Emoji counts toward the ≤2 bubble cap → text MUST be a single part.
      return {
        mode,
        leadingEmojiSms: emoji,
        textParts: [reply],
        reason: substantive ? "substantive_emoji_text" : "weighted_emoji_text",
        smsCount: 2,
      }
    case "tapback_then_text":
      // Tapback does NOT count toward the SMS cap; if reply is splittable,
      // we ride the natural 2-bubble split. Otherwise single text.
      return {
        mode,
        tapback: reaction,
        textParts: canSplit2 ? split.parts : [reply],
        reason: substantive ? "substantive_tapback_text" : "weighted_tapback_text",
        smsCount: canSplit2 ? 2 : 1,
      }
    case "tapback_emoji_text":
      // Tapback + emoji + text. Emoji counts → text must be single part.
      return {
        mode,
        tapback: reaction,
        leadingEmojiSms: emoji,
        textParts: [reply],
        reason: substantive ? "substantive_tapback_emoji_text" : "weighted_tapback_emoji_text",
        smsCount: 2,
      }
  }
}

/**
 * True when the planner intends to send a leading emoji bubble. Compose
 * helpers can use this hint to suppress double-emoji (i.e. if Claire's
 * text body would have led with 👍 anyway).
 */
export function planUsesLeadingEmoji(plan: OutboundDeliveryPlan): boolean {
  return Boolean(plan.leadingEmojiSms)
}

/** Returns total SMS bubbles in the plan (leading emoji + text parts). */
export function countPlanSmsBubbles(plan: OutboundDeliveryPlan): number {
  return (plan.leadingEmojiSms ? 1 : 0) + plan.textParts.length
}

export const __testing = {
  buildRng,
  foldStringToUint32,
  BASE_WEIGHTS,
  SUBSTANTIVE_WEIGHTS,
  SUBSTANTIVE_MIN_CHARS,
}
