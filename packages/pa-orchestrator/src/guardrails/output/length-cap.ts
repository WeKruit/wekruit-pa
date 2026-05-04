/**
 * OG-1: lengthCapGuardrail — soft transform (sentence-cap + char-cap).
 *
 * Detail-plan ws-3-6-detail.md §5.2 OG-1. Wraps existing pure functions
 * `stripToSentenceCap` + `stripToCharCap` from `voice/detectors/f2-length-cap.ts`.
 * Bypass when reply is structured (CV plan, numbered list) OR when crisis
 * trailer is queued (`ctx.crisisTripped=true`).
 *
 * Migration of M-5 from index.ts:1942-1976.
 */
import {
  stripToSentenceCap,
  stripToCharCap,
  isStructuredReply,
} from "../../voice/detectors/f2-length-cap.js"
import type { OutputGuardrail } from "../types.js"
import { recordGuardrailHit } from "../types.js"

export const lengthCapGuardrail: OutputGuardrail = {
  name: "lengthCap",
  execute: ({ agentOutput, ctx }) => {
    const t0 = Date.now()
    const input = agentOutput ?? ""
    if (!input) {
      recordGuardrailHit(ctx, {
        name: "lengthCap",
        type: "output",
        tripped: false,
        metadata: { skipped: "empty" },
        latencyMs: Date.now() - t0,
      })
      return { tripwireTriggered: false, outputInfo: { skipped: "empty" } }
    }
    const structured = isStructuredReply(input)
    if (structured || ctx.crisisTripped) {
      const reason = ctx.crisisTripped ? "crisis_injected" : "structured"
      recordGuardrailHit(ctx, {
        name: "lengthCap",
        type: "output",
        tripped: false,
        metadata: { bypassReason: reason },
        latencyMs: Date.now() - t0,
      })
      return {
        tripwireTriggered: false,
        outputInfo: { bypassReason: reason },
      }
    }
    let text = input
    const sentencesBefore = countSentences(text)
    const charsBefore = text.length
    const sCap = stripToSentenceCap(text)
    if (sCap.stripped) text = sCap.text
    const cCap = stripToCharCap(text)
    if (cCap.stripped) text = cCap.text
    const sentencesAfter = countSentences(text)
    const charsAfter = text.length
    const transformed = text !== input
    const metadata = {
      sentencesBefore,
      sentencesAfter,
      charsBefore,
      charsAfter,
      transformed,
    }
    recordGuardrailHit(ctx, {
      name: "lengthCap",
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

function countSentences(text: string): number {
  if (!text) return 0
  // Match Bible v7.5 sentence-counter heuristic — simple terminal-punct split.
  return text.split(/[。！？.!?]+/u).filter((s) => s.trim().length > 0).length
}
