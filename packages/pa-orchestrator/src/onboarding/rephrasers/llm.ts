/**
 * LLMRephraser — generates a fresh re-ask via LLM each retry. Higher cost
 * + nondeterministic, but useful when no curated variants exist or when
 * the user's reply is contextual enough to warrant a tailored clarifier.
 *
 * Most production Qs should prefer HybridRephraser (variants first) for
 * predictability.
 */
import type { Lang, RephraseArgs, Rephraser } from "../question.js"

export type LLMRephraseFn = (args: {
  questionId: string
  originalPrompt: string
  userReply: string
  attemptNum: number
  lang: Lang
}) => Promise<string | null>

export class LLMRephraser implements Rephraser {
  readonly kind = "llm"
  constructor(
    private readonly llmCall: LLMRephraseFn,
    /** Fallback when LLM returns null / threw — never let user see "" */
    private readonly fallbackPhrase: string
  ) {}

  async rephrase(args: RephraseArgs): Promise<string> {
    try {
      const out = await this.llmCall({
        questionId: args.questionId,
        originalPrompt: args.originalPrompt,
        userReply: args.userReply,
        attemptNum: args.attemptNum,
        lang: args.lang,
      })
      if (out && out.trim().length > 0) return out
    } catch {
      // Swallow — fallback below.
    }
    return this.fallbackPhrase
  }
}
