import type { SharedOnboardingPromptContext, SharedOnboardingQuestionId } from "./shared-onboarding.js"
import type { ResolvedVoiceProfile } from "./voice/voice-profiles/index.js"

export type OnboardingSurfaceMode = "ask" | "reask"

export function buildOnboardingSurfaceIntent(input: {
  slot: SharedOnboardingQuestionId
  promptContext: SharedOnboardingPromptContext
  mode: OnboardingSurfaceMode
  voiceProfile: ResolvedVoiceProfile
  ackHint?: string | null
}): string {
  const base =
    input.mode === "reask"
      ? `Re-ask the ${input.slot} onboarding question in friend tone. Prior answer was unclear.`
      : `Ask the ${input.slot} onboarding question in friend Claire tone.`

  const invariants: string[] = [
    "Compose ONE SMS only. Do not write tags to Firestore.",
    "Friend roommate tone — not HR, not coach.",
  ]
  if (input.voiceProfile.invariants.noInterviewPromise) {
    invariants.push("Never promise an interview or pass outcome.")
  }
  if (input.voiceProfile.invariants.noOversellLanguage) {
    invariants.push("No oversell language (perfect fit, guaranteed, definitely).")
  }
  if (input.ackHint) {
    invariants.push(`Ack hint: ${input.ackHint}`)
  }

  const ctxBits = Object.entries(input.promptContext)
    .filter(([, v]) => v != null && String(v).trim().length > 0)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join("; ")

  return [base, ...invariants, ctxBits ? `Context: ${ctxBits}` : ""].filter(Boolean).join("\n")
}
