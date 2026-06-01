/**
 * LLMRelevanceJudge — calls an extractIntent function (defined per-step in
 * orchestrator-deps.ts) to decide whether the user's reply is a usable
 * answer to the question.
 *
 * Returns:
 *   accept=true  with the canonical value when LLM returns "provided" + confidence ≥ threshold
 *   reason=unclear with clarifyingQuestion when LLM returns "unclear"
 *   reason=irrelevant when LLM returns null / threw / unrecognized shape
 *
 * The 5 default probe Qs (q_role, q_yoe, q_visa, q_startup_pref, q_location)
 * use this judge.
 */
import type { Judge, JudgeCtx, JudgeResult, Lang } from "../question.js"

/** Shape produced by extractAnswerIntent in orchestrator-deps.ts. */
export type IntentResult<TValue> =
  | { intent: "provided"; value: TValue; confidence: number }
  | { intent: "unclear"; clarifyingQuestion: string }

export type ExtractIntentFn<TValue = unknown> = (
  step:
    | "ask_q_role"
    | "ask_q_yoe"
    | "ask_q_visa"
    | "ask_q_startup_pref"
    | "ask_q_location",
  reply: string,
  lang: Lang
) => Promise<IntentResult<TValue> | null>

export interface LLMRelevanceJudgeOpts<TValue> {
  step: NonNullable<Parameters<ExtractIntentFn>[0]>
  extractIntent: ExtractIntentFn<TValue>
  /** Min confidence to accept "provided". Default 0.6. */
  confidenceThreshold?: number
  /**
   * Cheap noise filter: skip the LLM call when reply has fewer than this
   * many letter/digit/CJK chars. Saves cost on pure-punct / empty replies.
   */
  minMeaningfulChars?: number
}

export class LLMRelevanceJudge<TValue> implements Judge<TValue> {
  readonly kind = "llm-relevance"

  constructor(private readonly opts: LLMRelevanceJudgeOpts<TValue>) {}

  async judge(reply: string, lang: Lang, ctx: JudgeCtx): Promise<JudgeResult<TValue>> {
    const trimmed = reply.trim()
    const minChars = this.opts.minMeaningfulChars ?? 2
    const hasContent = trimmed.length >= minChars && /[A-Za-z0-9]/.test(trimmed)
    if (!hasContent) {
      return { accept: false, reason: "irrelevant" }
    }

    let intent: IntentResult<TValue> | null = null
    try {
      ctx.log?.("pa.onboarding.judge.llm_relevance.invoke", {
        step: this.opts.step,
        userId: ctx.userId,
        turnId: ctx.turnId,
        replyLen: trimmed.length,
      })
      intent = await this.opts.extractIntent(this.opts.step, reply, lang)
    } catch (err) {
      ctx.log?.("pa.onboarding.judge.llm_relevance.error", {
        step: this.opts.step,
        userId: ctx.userId,
        turnId: ctx.turnId,
        error: err instanceof Error ? err.message : String(err),
      })
      return { accept: false, reason: "irrelevant" }
    }

    if (!intent) return { accept: false, reason: "irrelevant" }

    const threshold = this.opts.confidenceThreshold ?? 0.6
    if (intent.intent === "provided" && intent.confidence >= threshold) {
      ctx.log?.("pa.onboarding.judge.llm_relevance.accept", {
        step: this.opts.step,
        userId: ctx.userId,
        turnId: ctx.turnId,
        confidence: intent.confidence,
      })
      return { accept: true, value: intent.value, confidence: intent.confidence }
    }
    if (intent.intent === "unclear") {
      return {
        accept: false,
        reason: "unclear",
        clarifyingQuestion: intent.clarifyingQuestion,
      }
    }
    // provided-but-low-confidence: treat as unclear (no clarifyingQuestion
    // available since LLM was confident enough to return "provided").
    return { accept: false, reason: "unclear" }
  }
}
