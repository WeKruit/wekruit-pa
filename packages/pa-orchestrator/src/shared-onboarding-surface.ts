import {
  buildSharedOnboardingPrompt,
  buildSharedOnboardingResumeAnchor,
  type SharedOnboardingPromptContext,
  type SharedOnboardingQuestionId,
} from "./shared-onboarding.js"
import { buildTangentSurfaceDirective } from "./voice/tangent-detector.js"
import type { ResolvedVoiceProfile } from "./voice/voice-profiles/index.js"

export type OnboardingSurfaceMode = "ask" | "reask"

export function buildOnboardingSurfaceIntent(input: {
  slot: SharedOnboardingQuestionId
  promptContext: SharedOnboardingPromptContext
  mode: OnboardingSurfaceMode
  voiceProfile: ResolvedVoiceProfile
  ackHint?: string | null
  lang?: "en" | "zh"
  /**
   * Set when the inbound was detected as an off-topic question (tangent)
   * rather than an answer. Adam 2026-05-19 voice polish §6 — instructs the
   * LLM to briefly answer the tangent then bring the user back to the slot
   * question instead of robotically re-asking.
   */
  tangentDetected?: boolean
}): string {
  const base =
    input.mode === "reask"
      ? `Re-ask the ${input.slot} onboarding question in friend tone. Prior answer was unclear.`
      : `Ask the ${input.slot} onboarding question in friend Claire tone.`

  const lang: "en" | "zh" = input.lang === "zh" ? "zh" : "en"

  const invariants: string[] = [
    "Compose ONE SMS only. Do not write tags to Firestore.",
    "Friend roommate tone — not HR, not coach.",
    lang === "zh"
      ? "Write the SMS in Chinese only."
      : "Write the SMS in English only.",
    // Adam 2026-05-19 voice polish §6 — when the inbound was a tangent (user
    // asked an off-topic question), the "do not offer job search / do not
    // riff" rail still applies, but we explicitly want a one-beat answer
    // BEFORE the slot question. Surface that as its own directive so the
    // LLM doesn't treat it as a contradiction.
    input.tangentDetected
      ? "User asked something off-topic. Briefly answer (≤1 short sentence) and then re-ask this onboarding slot — do not skip the slot question, do not offer job search, do not write tags."
      : "Ask the onboarding question for this slot — do not offer job search, do not riff on the greeting.",
  ]
  if (input.tangentDetected) {
    invariants.push(buildTangentSurfaceDirective(lang))
  }
  if (input.voiceProfile.invariants.noInterviewPromise) {
    invariants.push("Never promise an interview or pass outcome.")
  }
  if (input.voiceProfile.invariants.noOversellLanguage) {
    invariants.push("No oversell language (perfect fit, guaranteed, definitely).")
  }
  if (input.ackHint) {
    invariants.push(`Ack hint: ${input.ackHint}`)
  }

  // Resume anchor — sexy/personal opener for Q1/Q2 only (Adam 2026-05-19).
  // The LLM is required to use it when present so it cannot regress to a
  // generic template. We don't anchor Q3/Q4/Q5 here — Q3 already pulls
  // industryTags inside buildSharedOnboardingPrompt, Q4 already pulls
  // locationSummary, and Q5 is intentionally generic.
  const resumeAnchor = buildSharedOnboardingResumeAnchor(input.slot, input.promptContext)
  const anchorLine = resumeAnchor ? `Resume anchor (required if present): ${resumeAnchor}` : ""

  // Canonical question text — let the LLM friend-rephrase but preserve meaning.
  // Pulling from the same builder the template path uses keeps the question
  // payload aligned across agentic + template fallbacks.
  const canonical = buildSharedOnboardingPrompt(input.slot, input.promptContext)
  const canonicalLine = canonical
    ? `Canonical question (preserve meaning, friend rephrase OK): ${canonical}`
    : ""

  const ctxBits = Object.entries(input.promptContext)
    .filter(([, v]) => v != null && String(v).trim().length > 0)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join("; ")

  return [
    base,
    ...invariants,
    anchorLine,
    canonicalLine,
    ctxBits ? `Context: ${ctxBits}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}
