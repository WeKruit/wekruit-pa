/**
 * OG-4: adviceRepeatGuardrail — F4 BGE-M3 cos-sim wrap.
 *
 * Detail-plan ws-3-6-detail.md §5.2 OG-4 + §7 M-7. NOT a tripwire — V1
 * is fail-open log-only matching today's `runAllDetectors` posture.
 * Surfaces `outputInfo.suggestedAction = "reject_resample"` so the
 * orchestrator can opt into resample-on-trip in V2.
 */
import { detectAdviceRepeat } from "../../voice/detectors/f4-advice-repeat.js"
import type { OutputGuardrail } from "../types.js"
import { recordGuardrailHit } from "../types.js"

export const adviceRepeatGuardrail: OutputGuardrail = {
  name: "adviceRepeat",
  execute: async ({ agentOutput, userInput, ctx }) => {
    const t0 = Date.now()
    const reply = agentOutput ?? ""
    const recent = ctx.recentTurnsForMirror ?? []
    const claireReplies = recent
      .filter((m) => (m as { role?: string }).role === "assistant")
      .map((m) => (m as { content?: string }).content ?? "")
      .filter(Boolean)
    try {
      const result = await detectAdviceRepeat({
        turn: { user: userInput ?? "", assistant: reply },
        history: { claireReplies },
      })
      const tripped = result.triggered
      const metadata = {
        score: result.score,
        reason: result.reason,
        suggested_action: result.suggested_action,
      }
      recordGuardrailHit(ctx, {
        name: "adviceRepeat",
        type: "output",
        tripped,
        metadata,
        latencyMs: Date.now() - t0,
      })
      return {
        tripwireTriggered: false, // V1 log-only
        outputInfo: {
          ...metadata,
          suggestedAction: tripped ? "reject_resample" : undefined,
        },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      recordGuardrailHit(ctx, {
        name: "adviceRepeat",
        type: "output",
        tripped: false,
        metadata: { error: msg, posture: "fail_open" },
        latencyMs: Date.now() - t0,
      })
      return { tripwireTriggered: false, outputInfo: { error: msg } }
    }
  },
}
