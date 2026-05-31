/**
 * StaticVariantsRephraser — picks variants[attempt-1] (1-indexed → 0-indexed).
 *
 * Rationale: deterministic rotation. User sees a different phrasing every
 * retry without LLM cost. Falls back through the chain when variants run out.
 *
 * Adam directive 2026-05-05: "when re-asking, vary the phrasing" — variants are
 * the cheapest, most predictable way to comply.
 */
import type { BilingualText, RephraseArgs, Rephraser } from "../question.js"

export class StaticVariantsRephraser implements Rephraser {
  readonly kind = "variants"
  constructor(private readonly variants: BilingualText[]) {}

  async rephrase(args: RephraseArgs): Promise<string> {
    const idx = args.attemptNum - 1
    if (idx >= 0 && idx < this.variants.length) {
      return this.variants[idx]![args.lang]
    }
    // Exhausted variants → echo original prompt (last-resort, pipeline
    // halt logic should fire before reaching this for sane maxAttempts).
    return args.originalPrompt
  }
}
