/**
 * YesNoJudge — yes/no/agree/decline parser.
 *
 * Used for q_tos (privacy + terms acceptance). Three buckets:
 *   - clear yes (agree/yes/ok/...) → accept=true value=true
 *   - clear no (disagree/no/decline/...) → reason="declined"
 *   - anything else (questions, hesitation, irrelevant) → reason="irrelevant"
 *
 * Q's onDeclined hook decides what happens (e.g. q_tos sends a "fine, won't
 * store memory" message and skips rather than halting onboarding).
 */
import type { Judge, JudgeCtx, JudgeResult, Lang } from "../question.js"

const EN_YES = /^(?:yes|y|yep|yeah|sure|agree|agreed|ok|okay|cool|fine|sounds good|of course|absolutely|i agree|yup)\s*[\.\!]*$/i
const EN_NO =
  /^(?:no|n|nope|nah|disagree|i disagree|i don'?t agree|decline|i decline|not really|i'?d rather not)\s*[\.\!]*$/i

export class YesNoJudge implements Judge<boolean> {
  readonly kind = "yesno"

  async judge(reply: string, lang: Lang, ctx: JudgeCtx): Promise<JudgeResult<boolean>> {
    const trimmed = reply.trim()
    if (EN_YES.test(trimmed)) {
      return { accept: true, value: true, confidence: 1.0 }
    }
    if (EN_NO.test(trimmed)) {
      return { accept: false, reason: "declined" }
    }
    return { accept: false, reason: "irrelevant" }
  }
}
