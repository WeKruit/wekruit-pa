/**
 * LangJudge — parses the user's preferred language preference (zh / en / mixed).
 *
 * Tolerant of common phrasings:
 *   - 中文 / Chinese / 普通话 / 国语 → "zh"
 *   - English / 英文 / en → "en"
 *   - both / 都行 / 中英文混合 / mixed / 混合 / 都可以 → "mixed"
 *
 * Anything else → reason="irrelevant" (rephraser will ask again).
 */
import type { Judge, JudgeCtx, JudgeResult, Lang } from "../question.js"

export type LangPref = "zh" | "en" | "mixed"

const ZH_RE = /(中文|普通话|国语|chinese|cn|zh|说中文)/i
const EN_RE = /(英文|english|en\b|说英文)/i
const MIXED_RE = /(混合|混着|都可以|都行|both|mixed|两种|中英文|中英)/i

export class LangJudge implements Judge<LangPref> {
  readonly kind = "lang"

  async judge(reply: string, lang: Lang, ctx: JudgeCtx): Promise<JudgeResult<LangPref>> {
    const t = reply.trim().toLowerCase()
    if (!t) return { accept: false, reason: "irrelevant" }

    // Mixed first — "中英文" and "都行" should NOT match zh-only.
    if (MIXED_RE.test(t)) return { accept: true, value: "mixed", confidence: 1.0 }
    const hasZh = ZH_RE.test(t)
    const hasEn = EN_RE.test(t)
    if (hasZh && hasEn) return { accept: true, value: "mixed", confidence: 0.95 }
    if (hasZh) return { accept: true, value: "zh", confidence: 1.0 }
    if (hasEn) return { accept: true, value: "en", confidence: 1.0 }

    return { accept: false, reason: "irrelevant" }
  }
}
