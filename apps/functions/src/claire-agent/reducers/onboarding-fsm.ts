/**
 * reducers/onboarding-fsm.ts — WS-process owns this file.
 *
 * Pure, order-enforcing onboarding FSM (poc-v3 C). Slots default to
 * `SHARED_ONBOARDING_QUESTIONS` (@pa/pa-orchestrator) ids, but `state.slots`
 * is authoritative so tests/eval can inject a smaller set. The reducer:
 *   - hands the earliest pending slot (the LLM cannot skip),
 *   - records an answer ONLY for the expected slot (rejects out-of-order),
 *   - marks complete-once when all slots are filled.
 * No LLM, no I/O — L1-testable.
 *
 * KEYSTONE: the LLM (in the tool) only PROPOSES the answer text; this reducer
 * DECIDES which slot is pending and whether the answer is accepted. The model
 * cannot jump ahead, re-order, or declare onboarding complete on its own.
 */
import { SHARED_ONBOARDING_QUESTIONS } from "@pa/pa-orchestrator"

/** Canonical default slot ids + their iMessage-short prompts (poc-v3 C parity). */
export const DEFAULT_ONBOARDING_SLOTS: readonly string[] = SHARED_ONBOARDING_QUESTIONS.map(
  (q) => q.id,
)

const DEFAULT_ONBOARDING_PROMPTS: Record<string, string> = Object.fromEntries(
  SHARED_ONBOARDING_QUESTIONS.map((q) => [q.id, q.prompt]),
)

export interface OnboardingState {
  slots: string[]
  answers: Record<string, string>
  complete: boolean
}

export interface OnboardingNext {
  pending: string | null
  complete: boolean
  prompt?: string
}

export interface OnboardingRecordResult {
  ok: boolean
  reason?: string
  recorded?: string
  pending: string | null
  complete: boolean
}

/** Resolve the effective slot list — fall back to the canonical default set. */
function slotsOf(state: OnboardingState): string[] {
  return state.slots && state.slots.length > 0 ? state.slots : [...DEFAULT_ONBOARDING_SLOTS]
}

/** Earliest slot not yet in `answers` — the single source of "what's next". */
function earliestPending(state: OnboardingState): string | null {
  const slots = slotsOf(state)
  return slots.find((s) => !(s in state.answers)) ?? null
}

/** The prompt the LLM should phrase for a given slot (canonical default; slot id fallback). */
export function onboardingPromptFor(slot: string): string {
  return DEFAULT_ONBOARDING_PROMPTS[slot] ?? slot
}

/**
 * Hand the earliest pending slot + its prompt, or signal complete. The LLM
 * routes off this — it never picks the slot itself.
 */
export function nextOnboardingSlot(state: OnboardingState): OnboardingNext {
  const pending = earliestPending(state)
  if (!pending) return { pending: null, complete: true }
  return { pending, complete: false, prompt: onboardingPromptFor(pending) }
}

/**
 * Record the candidate's answer for the CURRENT (earliest-pending) slot only.
 * Rejects any out-of-order slot (no skip). Advances + marks complete-once.
 * Mutates `state` in place (the per-session store owns the object), consistent
 * with the poc-v3 C reducer.
 */
export function recordOnboardingAnswer(
  state: OnboardingState,
  slot: string,
  answer: string,
): OnboardingRecordResult {
  const expected = earliestPending(state)

  // Already complete — nothing pending to record.
  if (!expected) {
    return { ok: false, reason: "already_complete", pending: null, complete: true }
  }

  // No-skip guard: the reducer only accepts the expected slot.
  if (slot !== expected) {
    return {
      ok: false,
      reason: `out_of_order: expected ${expected}, not ${slot}`,
      pending: expected,
      complete: false,
    }
  }

  state.answers[slot] = answer
  const next = earliestPending(state)
  state.complete = next === null
  return { ok: true, recorded: slot, pending: next, complete: state.complete }
}
