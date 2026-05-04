/**
 * OG-3: slangEnforcerGuardrail — POST-LLM banned-word substitutions.
 *
 * Detail-plan ws-3-6-detail.md §5.2 OG-3 + §7 M-3. Adam preference iter23:
 * "卧 → 卧槽 enforced post-LLM" (today the slang-injector only ran
 * PRE-LLM as a system-prompt directive, which the model could ignore).
 * This is the single-byte safety net.
 *
 * iter30 Wave 3 expand (2026-05-03) — Bible v7 banlist. Beyond `卧→卧槽`,
 * strip these registers when the LLM leaks them through:
 *   - `友好` (corporate-speak; too sales-y for Claire)
 *   - `没问题` (helper-tone / service-rep cadence; replace with friend-tone)
 *
 * Strategy is conservative: prefer STRIPPING rather than complex word-
 * substitution that could break grammar. For `太\s*X\s*了` patterns where X
 * is in banlist, replace the whole pattern with empty string (drops the
 * compliment-shaped construction entirely). For `没问题` standalone or
 * sentence-start, swap to friend-tone "嗯，行" or "好"; mid-sentence is
 * stripped.
 *
 * Context-aware regex: substitute only when 卧 is at end-of-token (followed
 * by space / punctuation / EOS / common slang punctuation). Avoids matching
 * 卧床 / 卧室 / 卧倒 in legitimate contexts.
 *
 * Locale gate: applies when ctx.locale ∈ {zh-CN, mixed}. en-US no-op.
 */
import type { OutputGuardrail } from "../types.js"
import { recordGuardrailHit } from "../types.js"

// 卧 followed by NOT 槽 AND NOT a CJK letter that would form a real word
// (卧床/卧室/卧倒/卧推/卧底/卧具/卧虎/卧龙). We allow any CJK char OTHER
// than this curated bank as still being "slang" usage — keeps the false
// negative rate low.
const NON_SLANG_FOLLOWERS = "槽床室倒推底具虎龙"
const SLANG_RE = new RegExp(`卧(?![${NON_SLANG_FOLLOWERS}])`, "g")

// `太 X 了` corporate-praise pattern — when X is one of the banned words,
// drop the whole "太...了" construction since stripping just X breaks
// grammar ("你真是太了" — broken). Optional whitespace between tokens.
const TAI_BAN_RE = /太\s*(?:友好|nice)\s*了/g

// `没问题` standalone or at sentence start (after sentence boundary or
// at very start, optionally followed by punctuation). Mid-sentence
// occurrences fall through to the broad strip below.
const MEI_WEN_TI_HEAD_RE = /(^|[，,。.；;！!？?\n])\s*没问题\s*[，,。.；;！!？?]?/g

// Bare standalone `没问题` (whole reply or surrounded by whitespace) →
// friend-tone "嗯，行".
const MEI_WEN_TI_BARE_RE = /^[\s]*没问题[\s]*[。.！!]?[\s]*$/

// Mid-sentence `没问题` → strip (rare but defensive). After head/bare
// patterns are handled above.
const MEI_WEN_TI_MID_RE = /没问题/g

// Standalone `友好` mid-sentence — strip (covers "他很友好" etc) only
// when the head TAI_BAN pattern didn't already catch it. Conservative:
// only strip when adjacent to common copula/intensifier; leave neutral
// adjective uses alone.
const YOU_HAO_INTENSIFIER_RE = /(很|非常|挺|蛮|超|特别)友好/g

export const slangEnforcerGuardrail: OutputGuardrail = {
  name: "slangEnforcer",
  execute: ({ agentOutput, ctx }) => {
    const t0 = Date.now()
    const input = agentOutput ?? ""
    const locale = ctx.locale ?? "zh-CN"
    if (locale === "en-US" || !input) {
      const skipReason = locale === "en-US" ? "en_locale" : "empty"
      recordGuardrailHit(ctx, {
        name: "slangEnforcer",
        type: "output",
        tripped: false,
        metadata: { skipped: skipReason },
        latencyMs: Date.now() - t0,
      })
      return { tripwireTriggered: false, outputInfo: { skipped: skipReason } }
    }
    const substitutions: Array<{ from: string; to: string; count: number }> = []
    let text = input

    // Pass 1 — 卧 → 卧槽
    let woCount = 0
    text = text.replace(SLANG_RE, () => {
      woCount++
      return "卧槽"
    })
    if (woCount > 0) substitutions.push({ from: "卧", to: "卧槽", count: woCount })

    // Pass 2 — 太友好了 / 太 nice 了 → "" (drops the corporate-praise frame)
    let taiCount = 0
    text = text.replace(TAI_BAN_RE, () => {
      taiCount++
      return ""
    })
    if (taiCount > 0) substitutions.push({ from: "太友好了", to: "", count: taiCount })

    // Pass 3 — bare-standalone 没问题 → "嗯，行"
    let bareMwt = 0
    if (MEI_WEN_TI_BARE_RE.test(text)) {
      text = "嗯，行"
      bareMwt = 1
    }
    if (bareMwt > 0) substitutions.push({ from: "没问题", to: "嗯，行", count: bareMwt })

    // Pass 4 — sentence-head 没问题, → 好,
    let headMwt = 0
    text = text.replace(MEI_WEN_TI_HEAD_RE, (_m, lead) => {
      headMwt++
      // Preserve the leading boundary (start-of-string, comma, period, ...)
      const prefix = lead ?? ""
      return `${prefix}好，`
    })
    if (headMwt > 0) substitutions.push({ from: "没问题(head)", to: "好，", count: headMwt })

    // Pass 5 — leftover mid-sentence 没问题 → strip
    let midMwt = 0
    text = text.replace(MEI_WEN_TI_MID_RE, () => {
      midMwt++
      return ""
    })
    if (midMwt > 0) substitutions.push({ from: "没问题(mid)", to: "", count: midMwt })

    // Pass 6 — intensifier 友好 → strip the modifier+word together
    let yhCount = 0
    text = text.replace(YOU_HAO_INTENSIFIER_RE, () => {
      yhCount++
      return ""
    })
    if (yhCount > 0) substitutions.push({ from: "(很|非常|挺|蛮|超|特别)友好", to: "", count: yhCount })

    // Cleanup: collapse adjacent punctuation artifacts ("，，" / "。。") and
    // strip leading separators that may form after a strip.
    text = text.replace(/([，,。.；;！!？?])\s*[，,。.；;！!？?]/g, "$1")
    text = text.replace(/^[，,。.；;！!？?\s]+/, "")

    const transformed = substitutions.length > 0 && text !== input
    const metadata = { substitutions, transformed }
    recordGuardrailHit(ctx, {
      name: "slangEnforcer",
      type: "output",
      tripped: false,
      metadata,
      latencyMs: Date.now() - t0,
    })
    return {
      tripwireTriggered: false,
      outputInfo: { ...metadata, transformedOutput: transformed ? text : undefined },
    }
  },
}
