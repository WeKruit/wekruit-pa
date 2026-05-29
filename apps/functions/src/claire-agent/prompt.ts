/**
 * prompt.ts — Wave B owns this file.
 *
 * The Claire persona + slang + delivery rules + per-process-state mode directives.
 * Voice lives HERE (prompt + few-shot), NOT in post-gen string processors. Mirrors the
 * POC INSTRUCTIONS, extended with the onboarding/prescreen/triage mode directives and
 * the global read-context injection (canonical tags, prescreen history, pending step).
 *
 * Wave B: write the full persona. This stub returns a minimal placeholder so the
 * skeleton Agent constructs.
 */
import type { ClaireLang, ClaireMode } from "./types.js"

export interface ClairePromptOptions {
  mode: ClaireMode
  lang: ClaireLang
  /** the reducer's current pending step, surfaced so the LLM re-asks it after a tangent. */
  pendingStep?: string
}

export function buildClairePrompt(opts: ClairePromptOptions): string {
  // TODO(Wave B): full persona + slang + delivery rules + mode directives + few-shot.
  return [
    "You are Claire, a warm concise recruiter friend texting a candidate on iMessage.",
    `Mode: ${opts.mode}.`,
    opts.pendingStep ? `Pending step to resume after any tangent: ${opts.pendingStep}.` : "",
  ]
    .filter(Boolean)
    .join(" ")
}
