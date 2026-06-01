/**
 * v1.9 Phase 89 — Feedback survey pipeline.
 *
 * After PiiConfirmPipeline closure, optionally sends 1-2 Question survey:
 *   Q1: rating 1-5 (MUST_HAVE)
 *   Q2: freeform comment (GOOD_TO_HAVE)
 *
 * Reply "skip" / "no thanks" exits gracefully.
 *
 * Writes pa-prescreen-sessions.{sessionId}.feedback = {rating, freeform,
 * completedAt} via injected hook.
 */

import { OnboardingPipeline } from "../onboarding/pipeline.js"
import type { PipelineStateProvider } from "../onboarding/pipeline.js"
import {
  makeQuestion,
  type AcceptedCtx,
  type BilingualText,
  type Judge,
  type JudgeCtx,
  type JudgeResult,
  type Lang,
  type Question,
  type RephraseArgs,
  type Rephraser,
} from "../onboarding/question.js"

const SKIP_RE = /^\s*(skip|no\s+thanks?|nope|pass)\s*\.?$/i

export function isSkipReply(reply: string): boolean {
  return SKIP_RE.test(reply.trim())
}

class RatingJudge implements Judge<number> {
  readonly kind = "feedback-rating"
  async judge(reply: string, _lang: Lang, _ctx: JudgeCtx): Promise<JudgeResult<number>> {
    if (isSkipReply(reply)) return { accept: true, value: 0 }
    const m = reply.match(/[1-5]/)
    if (!m) return { accept: false, reason: "irrelevant" }
    return { accept: true, value: parseInt(m[0], 10) }
  }
}

class FreeformJudge implements Judge<string> {
  readonly kind = "feedback-freeform"
  async judge(reply: string, _lang: Lang, _ctx: JudgeCtx): Promise<JudgeResult<string>> {
    if (isSkipReply(reply)) return { accept: true, value: "" }
    const v = reply.trim()
    if (v.length === 0) return { accept: false, reason: "irrelevant" }
    return { accept: true, value: v.slice(0, 1000) }
  }
}

class FeedbackRephraser implements Rephraser {
  readonly kind = "feedback-static"
  constructor(private readonly variants: BilingualText[]) {}
  async rephrase({ attemptNum, lang }: RephraseArgs): Promise<string> {
    const idx = Math.min(attemptNum - 1, this.variants.length - 1)
    return this.variants[idx][lang]
  }
}

const Q_RATING_PROMPT: BilingualText = {
  en: "Last quick thing — on 1-5, how was the screening experience? (Reply 'skip' to skip)",
  zh: "Last quick thing — on 1-5, how was the screening experience? (Reply 'skip' to skip)",
}
const Q_RATING_RETRIES: BilingualText[] = [
  { en: "Need a number 1-5, or 'skip'.", zh: "Need a number 1-5, or 'skip'." },
]
const Q_FREEFORM_PROMPT: BilingualText = {
  en: "Any feedback you'd like to share? (Optional — reply 'skip' to finish)",
  zh: "Any feedback you'd like to share? (Optional — reply 'skip' to finish)",
}
const Q_FREEFORM_RETRIES: BilingualText[] = [
  { en: "Type something or 'skip'.", zh: "Type something or 'skip'." },
]

export interface FeedbackHooks {
  /** Persists rating + freeform back to pa-prescreen-sessions doc. */
  onFeedbackCollected: (
    args: { rating: number; freeform: string },
    ctx: AcceptedCtx
  ) => Promise<void>
}

export interface FeedbackSurveyOpts {
  state: PipelineStateProvider
  hooks: FeedbackHooks
  emit: (text: string, meta: { qId: string | null; kind: string }) => Promise<void>
  log?: (event: string, payload: Record<string, unknown>) => void
}

export function createFeedbackSurveyPipeline(opts: FeedbackSurveyOpts): OnboardingPipeline {
  const qRating: Question<number> = makeQuestion<number>({
    id: "q_feedback_rating",
    prompt: Q_RATING_PROMPT,
    judge: new RatingJudge(),
    rephraser: new FeedbackRephraser(Q_RATING_RETRIES),
    maxAttempts: 2,
  })
  const qFreeform: Question<string> = makeQuestion<string>({
    id: "q_feedback_freeform",
    prompt: Q_FREEFORM_PROMPT,
    judge: new FreeformJudge(),
    rephraser: new FeedbackRephraser(Q_FREEFORM_RETRIES),
    type: "GOOD_TO_HAVE",
    maxAttempts: 2,
  })

  return new OnboardingPipeline({
    questions: [qRating as Question<unknown>, qFreeform as Question<unknown>],
    state: opts.state,
    haltMessageDefault: {
      en: "All good — thanks for your time.",
      zh: "All good — thanks for your time.",
    },
    emit: opts.emit,
    postCollect: async (collected: Record<string, unknown>, ctx: AcceptedCtx) => {
      await opts.hooks.onFeedbackCollected(
        {
          rating: Number(collected.q_feedback_rating ?? 0),
          freeform: String(collected.q_feedback_freeform ?? ""),
        },
        ctx
      )
    },
    log: opts.log,
  })
}
