/**
 * LangJudge — parses the user's preferred language preference.
 *
 * Product is English-only; the parser tolerates a few common phrasings and
 * always resolves to "en" / "mixed" (which is treated as en downstream).
 *
 *   - English / en → "en"
 *   - both / mixed → "mixed"
 *
 * Anything else → reason="irrelevant" (rephraser will ask again).
 */
import type { Judge, JudgeCtx, JudgeResult, Lang } from "../question.js"

export type LangPref = "zh" | "en" | "mixed"

const EN_RE = /(english|en\b)/i
const MIXED_RE = /(mixed|both)/i

export class LangJudge implements Judge<LangPref> {
  readonly kind = "lang"

  async judge(reply: string, lang: Lang, ctx: JudgeCtx): Promise<JudgeResult<LangPref>> {
    const t = reply.trim().toLowerCase()
    if (!t) return { accept: false, reason: "irrelevant" }

    if (MIXED_RE.test(t)) return { accept: true, value: "mixed", confidence: 0.95 }
    if (EN_RE.test(t)) return { accept: true, value: "en", confidence: 1.0 }

    return { accept: false, reason: "irrelevant" }
  }
}
