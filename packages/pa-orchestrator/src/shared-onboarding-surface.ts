import {
  buildSharedOnboardingOpeningPrompt,
  buildSharedOnboardingPrompt,
  buildSharedOnboardingResumeAnchor,
  type SharedOnboardingPromptContext,
  type SharedOnboardingQuestionId,
} from "./shared-onboarding.js"
import { buildTangentSurfaceDirective } from "./voice/tangent-detector.js"
import type { ResolvedVoiceProfile } from "./voice/voice-profiles/index.js"

export type OnboardingSurfaceMode = "ask" | "reask"

function onboardingSlotLabel(slot: SharedOnboardingQuestionId): string {
  if (slot === "main_goal") return "main goal for the next company"
  if (slot === "culture_stage") return "company culture and size or stage"
  if (slot === "industry_interest") return "industry or domain"
  if (slot === "location_relocation") return "location and work style"
  return "extra context before matching"
}

function promptContextLabel(key: string): string {
  if (key === "firstName") return "first name"
  if (key === "currentLocation") return "current location"
  if (key === "recentLocations") return "recent locations"
  if (key === "recentTitles") return "recent roles"
  if (key === "recentCompanies") return "recent companies"
  if (key === "skills") return "skills"
  if (key === "industryTags") return "industries"
  if (key === "resumeSummary") return "resume summary"
  return key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
}

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
  /** True only for the first SMS after `Hello, WeKruit! {userId}` / runtime kickoff. */
  opening?: boolean
}): string {
  const slotLabel = onboardingSlotLabel(input.slot)
  const base =
    input.opening
      ? "Compose the opening shared-onboarding SMS in Claire's personal job-hunting assistant tone."
      : input.mode === "reask"
      ? `Re-ask the ${slotLabel} onboarding question in friend tone. Prior answer was unclear.`
      : `Ask the ${slotLabel} onboarding question in friend Claire tone.`

  const lang: "en" | "zh" = input.lang === "zh" ? "zh" : "en"

  const invariants: string[] = [
    "Compose ONE SMS only. Do not write tags to Firestore.",
    input.opening
      ? "Write like you're texting a friend: warm, familiar, concise, and human."
      : "Friend roommate tone — not HR, not coach.",
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
    "Preserve the canonical question's topic exactly; do not swap it for a different preference question.",
  ]
  if (input.tangentDetected) {
    invariants.push(buildTangentSurfaceDirective(lang))
  }
  if (input.opening) {
    invariants.push(
      "Claire is a personal job-hunting assistant, not a recruiter, bot, corporate tool, or email writer.",
      "One question at a time. Do not pile up questions.",
      "No headers, bullets, markdown, or lists.",
      "No corporate speak such as leverage, synergy, or optimize your candidacy.",
      "No internal enum tokens, underscores, placeholders, or missing spaces; rewrite them into plain human words.",
      "Brief natural reactions are okay, like got it, makes sense, or oh nice.",
      "Light emoji is okay, max one per SMS and not every message.",
      "Never mention being AI.",
      "This is the first SMS after the candidate opened with Hello, WeKruit! {userId}.",
      "Open with a short welcome that uses their first name when available and one real resume or profile detail when available.",
      "Mention that Claire connects them directly with the hiring manager when a strong fit appears.",
      "Mention that Claire will ask a few quick questions to tune matches.",
      "Mention https://candidate.wekruit.com/me/profile and that they can just tell Claire here instead.",
      "Do not copy a fixed template; vary the wording while preserving those ingredients.",
      "If profile context is missing, stay natural and do not invent details.",
    )
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
  const canonical = input.opening
    ? buildSharedOnboardingOpeningPrompt(input.promptContext)
    : buildSharedOnboardingPrompt(input.slot, input.promptContext)
  const canonicalLine = canonical
    ? `Canonical question (must preserve this topic exactly; friend rephrase OK): ${canonical}`
    : ""

  const renderContextValue = (value: unknown): string => {
    if (Array.isArray(value)) {
      return value
        .map((item) => String(item).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(", ")
    }
    return String(value).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()
  }
  const ctxBits = Object.entries(input.promptContext)
    .filter(([, v]) => v != null && String(v).trim().length > 0)
    .map(([k, v]) => `${promptContextLabel(k)}: ${renderContextValue(v)}`)
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
