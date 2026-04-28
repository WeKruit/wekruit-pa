/**
 * Phase 23 — Onboarding state machine for closed-beta first-contact flow.
 *
 * D-03: Onboarding state lives on pa_users (onboardingState field).
 * D-04: Uses Voice v1 prompt unchanged — synthetic system inputs inject the
 *       onboarding step hint; Claude composes actual replies naturally.
 * D-08: status=invited triggers onboarding flow; auto-promotes to active at complete.
 *
 * State machine:
 *   undefined/pending → send_first_mes → first_mes_sent
 *   first_mes_sent → ask_grounding_q → grounding_q1_asked
 *   grounding_q1_asked → complete → complete
 *   complete → skip (no-op)
 */
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import type { User, AgentDef, OnboardingState } from "@pa/core-types"

export type OnboardingStep = "send_first_mes" | "ask_grounding_q" | "complete" | "skip"

/**
 * Pure function: derive the next onboarding action from user state.
 * Called before every inbound turn; returns "skip" for active/complete users.
 */
export function resolveOnboardingStep(user: Pick<User, "onboardingState">): OnboardingStep {
  const state = user.onboardingState
  if (!state || state === "pending") return "send_first_mes"
  if (state === "first_mes_sent") return "ask_grounding_q"
  if (state === "grounding_q1_asked") return "complete"
  return "skip"
}

/**
 * Compose the synthetic system input hint for the current onboarding step.
 *
 * D-04: These are system inputs injected into the existing Voice v1 prompt
 * context — NOT a separate prompt. The LLM composes the actual reply
 * naturally from the Character Bible v1 personality.
 *
 * Grounding question voice follows Character Bible v1:
 *   - Roommate register, short (1 sentence max)
 *   - No "你好" opener, no "欢迎", no host-mode probing
 *   - Casual curiosity about what brought them here
 */
export function composeOnboardingInput(step: OnboardingStep, agent: AgentDef): string {
  if (step === "send_first_mes") {
    // Extract first_mes from agent systemPrompt if available (Bible v6.4+)
    // Pattern: "First message: <text>" in systemPrompt
    const match = agent.systemPrompt.match(/[Ff]irst\s+message:\s*(.+?)(?:\n|$)/)
    const firstMes = match?.[1]?.trim() ?? "在呢. 今天找你聊点啥? 🍋"
    return `[onboarding_step: send_first_mes] Reply EXACTLY with Claire's first_mes: "${firstMes}". Nothing else. No greeting. No explanation.`
  }
  if (step === "ask_grounding_q") {
    // Character Bible v1 grounding: 1 casual question, roommate register
    // "What brings you here" in Claire's voice — light, not clinical
    return `[onboarding_step: ask_grounding_q] Ask ONE casual question to understand what's going on with the user right now. Roommate register: short, genuine, no "欢迎", no formal opener. Example: "你最近怎么了, 找我有什么事吗" or "今天有什么事?" — Claude picks naturally from Character Bible v1 voice.`
  }
  // complete / skip don't need synthetic inputs
  return ""
}

const ONBOARDING_NEXT_STATE: Partial<Record<OnboardingStep, OnboardingState>> = {
  send_first_mes: "first_mes_sent",
  ask_grounding_q: "grounding_q1_asked",
  complete: "complete",
}

/**
 * Advance the user's onboarding state in Firestore. Idempotent: if the user
 * already has a state >= the target, the write is a no-op.
 *
 * On "complete": also promotes the matching pa_beta_participants row to active
 * and sets onboardedAt + metadata.cohort=beta-v1 (D-07, D-08).
 */
export async function applyOnboardingStep(
  db: Firestore,
  user: Pick<User, "id" | "phoneE164" | "onboardingState">,
  step: OnboardingStep,
  opts: { now?: string } = {}
): Promise<void> {
  if (step === "skip") return

  const nextState = ONBOARDING_NEXT_STATE[step]
  if (!nextState) return

  const currentState = user.onboardingState
  // Idempotency: don't regress state
  const stateOrder: Array<OnboardingState | undefined> = [
    undefined,
    "pending",
    "first_mes_sent",
    "grounding_q1_asked",
    "complete",
  ]
  const currentIdx = stateOrder.indexOf(currentState)
  const nextIdx = stateOrder.indexOf(nextState)
  if (currentIdx >= nextIdx) return // already at or past this state

  const now = opts.now ?? new Date().toISOString()
  const userRef = db.collection(PA_COLLECTIONS.users).doc(user.id)

  if (nextState === "complete") {
    await userRef.set(
      {
        onboardingState: "complete",
        onboardedAt: now,
        updatedAt: now,
        metadata: { cohort: "beta-v1" },
      },
      { merge: true }
    )
    // Auto-promote beta participant: find by userId = user.id and status in (invited, active)
    const snap = await db
      .collection(PA_COLLECTIONS.betaParticipants)
      .where("userId", "==", user.id)
      .limit(10)
      .get()
    for (const doc of snap.docs) {
      const data = doc.data() as { status: string }
      if (data.status === "invited") {
        await doc.ref.set({ status: "active", activatedAt: now, updatedAt: now }, { merge: true })
      }
    }
    // Fallback: also check by normalized phone handle
    if (snap.empty && user.phoneE164) {
      const snapPhone = await db
        .collection(PA_COLLECTIONS.betaParticipants)
        .where("contactHandle", "==", user.phoneE164)
        .limit(5)
        .get()
      for (const doc of snapPhone.docs) {
        const data = doc.data() as { status: string }
        if (data.status === "invited") {
          await doc.ref.set(
            { status: "active", activatedAt: now, updatedAt: now, userId: user.id },
            { merge: true }
          )
        }
      }
    }
  } else {
    await userRef.set(
      { onboardingState: nextState, updatedAt: now },
      { merge: true }
    )
  }
}
