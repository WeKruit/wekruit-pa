/**
 * Phase 37 T3 — Phase 3 prompt directive generator.
 *
 * Emits a `[FSM-DIRECTIVE]...[/FSM-DIRECTIVE]` block to be appended to the
 * existing Phase 3 system prompt by the wire-in caller (Adam-owed via
 * WIRE-IN-PATCH.md).
 *
 * Format (per CONTEXT D-37-3):
 *
 *   [FSM-DIRECTIVE]
 *   current_ux_state: SoftConcerned
 *   current_stage: Comforting
 *   allowed_strategies: Reflection, Affirmation, SelfDisclosure
 *   preferred_next: Reflection
 *   note: User is in soft distress. Lead with validation; no advice yet.
 *   [/FSM-DIRECTIVE]
 *
 * `note` gloss is English-only. Directive headers themselves are en-only
 * (system-prompt convention).
 */

import type { Stage, Strategy, UxState } from "./types.js"

// ---------------------------------------------------------------------------
// Bilingual gloss tables — keyed by (uxState, stage).
// ---------------------------------------------------------------------------

type Gloss = string

export const STAGE_GLOSS_EN: Record<UxState, Record<Stage, Gloss>> = {
  WarmCurious: {
    Exploration: "User is curious / opening. Match warmth; ask a real question.",
    Comforting: "User is engaged. Reflect + affirm; stay open.",
    Action: "User is engaged. Affirm; soft suggestions only if asked.",
  },
  PlayfulTease: {
    Exploration: "User is in banter mode. Match register; no advice. Keep it short.",
    Comforting: "Banter continues. Affirm + light self-disclosure; no problem-solving.",
    Action: "Still banter. Affirm + ride the energy; no pivots to advice.",
  },
  SoftConcerned: {
    Exploration: "User shares mild distress. Reflect first; ask gently.",
    Comforting: "User is in soft distress. Lead with validation; no advice yet.",
    Action: "User is in soft distress. Mostly affirm; suggestions only if directly asked.",
  },
  FirmDirect: {
    Exploration: "User wants action. Ask one clarifying question; prep for advice next turn.",
    Comforting: "User wants action. Affirm + offer one concrete option.",
    Action: "User wants action. Lead with the concrete suggestion. Be decisive.",
  },
  QuietWitness: {
    Exploration: "User is in heavy emotion. Sit with it. NO questions, NO advice.",
    Comforting: "User is in heavy emotion. Reflect briefly; mostly silent witness.",
    Action: "User is in heavy emotion. NEVER suggest action. Just be present.",
  },
}

/**
 * Retained for back-compat with importers that reference the legacy zh table.
 * The product is English-only, so this now aliases the English gloss table.
 */
export const STAGE_GLOSS_ZH: Record<UxState, Record<Stage, Gloss>> = STAGE_GLOSS_EN

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildDirectiveInput {
  uxState: UxState
  stage: Stage
  allowedStrategies: Strategy[] | ReadonlySet<Strategy>
  preferredNext: Strategy
}

export interface BuildDirectiveOpts {
  /**
   * Retained for back-compat. The product is English-only, so the `note:`
   * gloss is always English regardless of this value.
   */
  userLang?: "zh" | "en" | "mixed"
}

/**
 * Build the `[FSM-DIRECTIVE]...[/FSM-DIRECTIVE]` block.
 *
 * @param input  `{ uxState, stage, allowedStrategies, preferredNext }`
 * @param opts   `{ userLang?: "zh" | "en" | "mixed" }`
 */
export function buildFsmDirective(
  input: BuildDirectiveInput,
  opts: BuildDirectiveOpts = {}
): string {
  // userLang retained for back-compat; gloss is always English (product is
  // English-only).
  void opts.userLang
  const allowedArr = Array.from(input.allowedStrategies)

  // Defensive: never emit empty whitelist. Caller's allowedStrategies()
  // already enforces stage-only fallback; this is double-defense.
  if (allowedArr.length === 0) {
    allowedArr.push("Other")
  }

  const note = STAGE_GLOSS_EN[input.uxState]?.[input.stage] ?? ""

  return [
    "[FSM-DIRECTIVE]",
    `current_ux_state: ${input.uxState}`,
    `current_stage: ${input.stage}`,
    `allowed_strategies: ${allowedArr.join(", ")}`,
    `preferred_next: ${input.preferredNext}`,
    `note: ${note}`,
    "[/FSM-DIRECTIVE]",
  ].join("\n")
}
