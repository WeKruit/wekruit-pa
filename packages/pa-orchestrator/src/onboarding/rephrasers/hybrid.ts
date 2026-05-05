/**
 * HybridRephraser — variants first, LLM clarifyingQuestion as fallback,
 * then static reaskPrompt as last resort.
 *
 * Use this when you have a few good static phrasings (predictable
 * rotation for first N attempts) AND a smart LLM judge that returns
 * contextual clarifyingQuestions (better tail behavior).
 */
import type { BilingualText, RephraseArgs, Rephraser } from "../question.js"

export interface HybridRephraserOpts {
  /** Ordered list of phrasings — variants[i] used for attempt i+1. */
  variants: BilingualText[]
  /** Final fallback when variants exhausted AND no LLM clarify available. */
  fallback: BilingualText
}

export class HybridRephraser implements Rephraser {
  readonly kind = "hybrid"
  constructor(private readonly opts: HybridRephraserOpts) {}

  async rephrase(args: RephraseArgs): Promise<string> {
    const idx = args.attemptNum - 1
    if (idx >= 0 && idx < this.opts.variants.length) {
      return this.opts.variants[idx]![args.lang]
    }
    if (args.llmClarifyingQuestion) {
      return args.llmClarifyingQuestion
    }
    return this.opts.fallback[args.lang]
  }
}
