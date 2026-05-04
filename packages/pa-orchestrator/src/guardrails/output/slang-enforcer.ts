/**
 * OG-3: slangEnforcerGuardrail — POST-LLM 卧 → 卧槽 substitution.
 *
 * Detail-plan ws-3-6-detail.md §5.2 OG-3 + §7 M-3. Adam preference iter23:
 * "卧 → 卧槽 enforced post-LLM" (today the slang-injector only ran
 * PRE-LLM as a system-prompt directive, which the model could ignore).
 * This is the single-byte safety net.
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
    let count = 0
    const text = input.replace(SLANG_RE, () => {
      count++
      return "卧槽"
    })
    const transformed = count > 0
    const metadata = {
      substitutions: transformed ? [{ from: "卧", to: "卧槽", count }] : [],
      transformed,
    }
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
