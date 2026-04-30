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
 * `note` gloss is bilingual — zh when caller passes `userLang === "zh"`, en
 * otherwise. Directive headers themselves are en-only (system-prompt convention).
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

export const STAGE_GLOSS_ZH: Record<UxState, Record<Stage, Gloss>> = {
  WarmCurious: {
    Exploration: "用户在好奇 / 开场。匹配温度；问一个真问题。",
    Comforting: "用户在参与中。反映 + 肯定；保持开放。",
    Action: "用户在参与中。肯定；只有被问到再给建议。",
  },
  PlayfulTease: {
    Exploration: "用户在玩梗。匹配状态；不要给建议。短一点。",
    Comforting: "继续玩梗。肯定 + 轻自我揭露；不要解决问题。",
    Action: "还在玩梗。肯定 + 接住情绪；不要切换到建议。",
  },
  SoftConcerned: {
    Exploration: "用户透露轻度低落。先反映；温柔提问。",
    Comforting: "用户处于轻度低落。先验证情绪；暂不给建议。",
    Action: "用户处于轻度低落。主要肯定；只有被直接问到再建议。",
  },
  FirmDirect: {
    Exploration: "用户要行动。问一个澄清问题；下回合准备建议。",
    Comforting: "用户要行动。肯定 + 给出一个具体选项。",
    Action: "用户要行动。直接给具体建议。果断。",
  },
  QuietWitness: {
    Exploration: "用户在重情绪里。陪伴。不要提问，不要建议。",
    Comforting: "用户在重情绪里。简短反映；主要是沉默见证。",
    Action: "用户在重情绪里。绝对不要建议行动。在场就好。",
  },
}

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
  /** "zh" | "en" — controls the `note:` line gloss language. Default "en". */
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
  const userLang = opts.userLang ?? "en"
  const allowedArr = Array.from(input.allowedStrategies)

  // Defensive: never emit empty whitelist. Caller's allowedStrategies()
  // already enforces stage-only fallback; this is double-defense.
  if (allowedArr.length === 0) {
    allowedArr.push("Other")
  }

  const glossTable = userLang === "zh" ? STAGE_GLOSS_ZH : STAGE_GLOSS_EN
  const note = glossTable[input.uxState]?.[input.stage] ?? ""

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
