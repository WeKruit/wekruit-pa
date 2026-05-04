/**
 * OG-7: outputNormalizerGuardrail — wraps `normalizeForIMessage`.
 *
 * Detail-plan ws-3-6-detail.md §5.2 OG-7. ALWAYS LAST in the output chain.
 * iMessage transport contract enforcement: strip code fences, markdown,
 * citations, emphasis, list markers, normalize whitespace, max-length to
 * 600. The pure function in `output-normalizer.ts` is idempotent so
 * re-running a stripped reply is safe (acceptance gate per §5.2 OG-7).
 *
 * Hard regression-lock: ALL existing `output-normalizer.test.ts` cases
 * must still pass after this migration (tests reference the pure
 * function directly; this wrapper does not change their behaviour).
 */
import { normalizeForIMessage } from "../../output-normalizer.js"
import type { OutputGuardrail } from "../types.js"
import { recordGuardrailHit } from "../types.js"

export const outputNormalizerGuardrail: OutputGuardrail = {
  name: "outputNormalizer",
  execute: ({ agentOutput, ctx }) => {
    const t0 = Date.now()
    const input = agentOutput ?? ""
    if (!input) {
      recordGuardrailHit(ctx, {
        name: "outputNormalizer",
        type: "output",
        tripped: false,
        metadata: { skipped: "empty" },
        latencyMs: Date.now() - t0,
      })
      return { tripwireTriggered: false, outputInfo: {} }
    }
    const result = normalizeForIMessage(input, { maxLength: 600 })
    const transformed = result.text !== input
    const metadata = {
      wasOverLength: result.wasOverLength,
      droppedTracking: result.droppedTracking,
      chunkCount: result.chunks?.length ?? 1,
      transformed,
    }
    recordGuardrailHit(ctx, {
      name: "outputNormalizer",
      type: "output",
      tripped: false,
      metadata,
      latencyMs: Date.now() - t0,
    })
    return {
      tripwireTriggered: false,
      outputInfo: {
        ...metadata,
        transformedOutput: transformed ? result.text : undefined,
      },
    }
  },
}
