/**
 * OG-2: abStripGuardrail — soft transform; strips AB-probe tails AND
 * AB-framework heads. Merged into one guardrail (two passes) per
 * detail-plan §5.2 OG-2 + §7 M-1/M-2.
 *
 * Migrates index.ts:1623-1680 (humanize + framework strip patches) to
 * a single SDK-shaped guardrail. Pure functions (`stripABProbeFromTail`,
 * `stripABFramework`) STAY in their respective modules — guardrail is a
 * thin wrapper. Mutates `ctx.abStripApplied` for downstream telemetry.
 */
import { stripABProbeFromTail } from "../../output-normalizer.js"
import { stripABFramework } from "../../voice/ab-framework-detector.js"
import type { OutputGuardrail } from "../types.js"
import { recordGuardrailHit } from "../types.js"

export const abStripGuardrail: OutputGuardrail = {
  name: "abStrip",
  execute: ({ agentOutput, ctx }) => {
    const t0 = Date.now()
    const input = agentOutput ?? ""
    let text = input
    const patterns: string[] = []
    // Pass 1 — tail probe (X or Y?).
    const tail = stripABProbeFromTail(text)
    if (tail.hits.length > 0) {
      text = tail.stripped
      for (const h of tail.hits) patterns.push(h)
    }
    // Pass 2 — framework head (If you want X, you could Y).
    const fw = stripABFramework(text)
    if (fw.applied) {
      text = fw.text
      if (fw.pattern) patterns.push(fw.pattern)
    }
    const transformed = text !== input
    if (transformed) ctx.abStripApplied = true
    const metadata = {
      patterns,
      beforeLen: input.length,
      afterLen: text.length,
      transformed,
    }
    recordGuardrailHit(ctx, {
      name: "abStrip",
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
