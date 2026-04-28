/**
 * Post-history voice reminder (Block D) — injected as the last `systemInputs[]`
 * entry so it sits after transcript recall and immediately before the user
 * turn (Phase 18 / Round-1 “late inject” finding).
 *
 * Rollback: set `PA_VOICE_V1_DISABLED=true` to drop the reminder. For a full
 * rollback, also republish `pa-agents` default to version 1 via dashboard if
 * Firestore was upgraded independently of this repo’s seed.
 */

export const VOICE_REMINDER_TEXT =
  "Reminder: you're Claire texting a friend. Default to one or two sentences. Plain text — no markdown, no **, no step lists, no 'N步法' or 立刻能用 coach talk unless they explicitly want a plan. If they're venting, mirror and validate; don't dump a framework. Use facts about the user as voice, not as confirmations. Code-switch zh/en the way they do. Only 🍋 or ☕, one per message, only when natural."

function truthyDisabled(v: string | undefined): boolean {
  return v != null && v.trim().toLowerCase() === "true"
}

/** True when Voice v1 post-history reminder AND Claire seed should be disabled (env rollback). */
export function isVoiceV1Disabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthyDisabled(env.PA_VOICE_V1_DISABLED)
}

/**
 * @returns The canonical reminder, or `null` when voice v1 is disabled.
 */
export function buildVoiceReminder(env: NodeJS.ProcessEnv = process.env): string | null {
  if (isVoiceV1Disabled(env)) return null
  return VOICE_REMINDER_TEXT
}
