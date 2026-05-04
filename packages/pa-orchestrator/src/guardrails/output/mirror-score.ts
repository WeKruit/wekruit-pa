/**
 * OG-6: mirrorScoreGuardrail — F1 verb-mirror Jaccard wrap.
 *
 * Detail-plan ws-3-6-detail.md §5.2 OG-6 + §7 M-6. NOT a tripwire.
 * V1: log-only `suggestedAction = "strip"` matching today's
 * `runAllDetectors` posture. Parity-tested against
 * `tests/scenarios/lib/voice-axes.mjs:computeMirrorRatio` to 1e-6.
 */
import { detectVerbMirror } from "../../voice/detectors/f1-verb-mirror.js"
import type { OutputGuardrail } from "../types.js"
import { recordGuardrailHit } from "../types.js"

export const mirrorScoreGuardrail: OutputGuardrail = {
  name: "mirrorScore",
  execute: ({ agentOutput, userInput, ctx }) => {
    const t0 = Date.now()
    const reply = agentOutput ?? ""
    try {
      const result = detectVerbMirror({
        turn: { user: userInput ?? "", assistant: reply },
        history: { claireReplies: [] },
      })
      const tripped = result.triggered
      const metadata = {
        score: result.score,
        reason: result.reason,
        suggested_action: result.suggested_action,
      }
      recordGuardrailHit(ctx, {
        name: "mirrorScore",
        type: "output",
        tripped,
        metadata,
        latencyMs: Date.now() - t0,
      })
      return {
        tripwireTriggered: false,
        outputInfo: {
          ...metadata,
          suggestedAction: tripped ? "strip" : undefined,
        },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      recordGuardrailHit(ctx, {
        name: "mirrorScore",
        type: "output",
        tripped: false,
        metadata: { error: msg },
        latencyMs: Date.now() - t0,
      })
      return { tripwireTriggered: false, outputInfo: { error: msg } }
    }
  },
}
