/**
 * YesNoJudge — bilingual yes/no/agree/decline parser.
 *
 * Used for q_tos (privacy + terms acceptance). Three buckets:
 *   - clear yes (同意/agree/yes/可以/ok/...) → accept=true value=true
 *   - clear no (不同意/disagree/no/拒绝/...) → reason="declined"
 *   - anything else (questions, hesitation, irrelevant) → reason="irrelevant"
 *
 * Q's onDeclined hook decides what happens (e.g. q_tos sends a "fine, won't
 * store memory" message and skips rather than halting onboarding).
 */
import type { Judge, JudgeCtx, JudgeResult, Lang } from "../question.js"

const ZH_YES = /^(?:同意|可以|好的|好啊|好啊好啊|行|没问题|ok|yes|y|yep|sure|agree|确认|确定|赞成|嗯|嗯嗯|嗯好|可以的|好嘞|好的好的)\s*[\.\!。]*$/i
const ZH_NO =
  /^(?:不同意|不行|不要|不可以|不|拒绝|反对|disagree|no|nope|n|nah|不愿意|不接受|拒绝接受|算了)\s*[\.\!。]*$/i

const EN_YES = /^(?:yes|y|yep|yeah|sure|agree|agreed|ok|okay|cool|fine|sounds good|of course|absolutely|i agree|yup)\s*[\.\!]*$/i
const EN_NO =
  /^(?:no|n|nope|nah|disagree|i disagree|i don'?t agree|decline|i decline|not really|i'?d rather not)\s*[\.\!]*$/i

export class YesNoJudge implements Judge<boolean> {
  readonly kind = "yesno"

  async judge(reply: string, lang: Lang, ctx: JudgeCtx): Promise<JudgeResult<boolean>> {
    const trimmed = reply.trim()
    if (ZH_YES.test(trimmed) || EN_YES.test(trimmed)) {
      return { accept: true, value: true, confidence: 1.0 }
    }
    if (ZH_NO.test(trimmed) || EN_NO.test(trimmed)) {
      return { accept: false, reason: "declined" }
    }
    return { accept: false, reason: "irrelevant" }
  }
}
