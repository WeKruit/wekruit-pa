/**
 * reducers/onboarding-fsm.ts — WS-process owns this file.
 *
 * Pure, order-enforcing onboarding FSM (poc-v3 C). Slots come from
 * `SHARED_ONBOARDING_QUESTIONS` (@pa/pa-orchestrator). The reducer:
 *   - hands the earliest pending slot (the LLM cannot skip),
 *   - records an answer ONLY for the expected slot (rejects out-of-order),
 *   - marks complete-once when all slots are filled.
 * No LLM, no I/O — L1-testable.
 */
import { notImplemented } from "../types.js"

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

export function nextOnboardingSlot(state: OnboardingState): OnboardingNext {
  return notImplemented("WS-process", "onboarding-fsm.nextOnboardingSlot")
}

export function recordOnboardingAnswer(
  state: OnboardingState,
  slot: string,
  answer: string,
): OnboardingRecordResult {
  return notImplemented("WS-process", "onboarding-fsm.recordOnboardingAnswer")
}
