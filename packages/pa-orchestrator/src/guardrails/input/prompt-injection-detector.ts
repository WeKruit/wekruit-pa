/**
 * IG-2: promptInjectionDetector — HARD block on prompt-injection.
 *
 * Wraps `pa-safety:checkPromptInjectionV2`. On trip, returns canned
 * `SAFETY_CANNED_REPLIES.escalate[lang]` and halts the SDK chain.
 * Mirrors today's logic at index.ts:2448 inside `checkInboundSafety`.
 *
 * Detail-plan ws-3-6-detail.md §5.1 IG-2.
 */
import {
  checkPromptInjectionV2,
  SAFETY_CANNED_REPLIES,
  pickLangForSafety,
} from "@pa/pa-safety"
import type { InputGuardrail } from "../types.js"
import { recordGuardrailHit } from "../types.js"

export const promptInjectionDetectorGuardrail: InputGuardrail = {
  name: "promptInjectionDetector",
  runInParallel: false,
  execute: ({ input, ctx }) => {
    const t0 = Date.now()
    const text = input ?? ""
    const result = checkPromptInjectionV2(text)
    const tripped = result.matched
    const lang = pickLangForSafety(text)
    const cannedReply = tripped ? SAFETY_CANNED_REPLIES.escalate[lang] : undefined
    const metadata = {
      matched: tripped,
      patterns: result.signals ?? [],
      severity: tripped ? "high" : "low",
      lang,
    }
    if (tripped) {
      ctx.promptInjectionTripped = true
    }
    recordGuardrailHit(ctx, {
      name: "promptInjectionDetector",
      type: "input",
      tripped,
      metadata,
      latencyMs: Date.now() - t0,
    })
    return {
      tripwireTriggered: tripped,
      outputInfo: { ...metadata, cannedReply },
    }
  },
}
