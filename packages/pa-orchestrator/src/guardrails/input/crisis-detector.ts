/**
 * IG-1: crisisDetector — annotates `ctx.crisisTripped` (NEVER halts).
 *
 * Detail-plan ws-3-6-detail.md §5.1 IG-1. The detect call is a thin
 * wrap of `pa-safety/src/crisis-detector.ts:detectCrisisInInput`. Output
 * trailer injection is handled later by OG-5 `crisisTrailerGuardrail`.
 *
 * Single source of truth for detection — replaces the dual-call pattern
 * today where `runCrisisHotlineGuard` runs both detect + inject in one
 * shot at index.ts:1896 + onboarding cold-start branch.
 */
import { detectCrisisInInput, hashForAudit } from "@pa/pa-safety"
import type { InputGuardrail } from "../types.js"
import { recordGuardrailHit } from "../types.js"

export const crisisDetectorGuardrail: InputGuardrail = {
  name: "crisisDetector",
  runInParallel: false,
  execute: ({ input, ctx }) => {
    const t0 = Date.now()
    const detection = detectCrisisInInput(input ?? "")
    const tripped = detection.detected
    if (tripped) {
      ctx.crisisTripped = true
    }
    const metadata = {
      language: detection.language,
      confidence: detection.confidence,
      patterns: detection.signals,
      inputHash: hashForAudit(input ?? ""),
    }
    recordGuardrailHit(ctx, {
      name: "crisisDetector",
      type: "input",
      tripped,
      metadata,
      latencyMs: Date.now() - t0,
    })
    if (tripped) {
      try {
        ctx.log("pa.safety.crisis_detected", {
          userId: ctx.userId,
          turnId: ctx.turnId,
          ...metadata,
        })
      } catch {
        /* never let logging failures escape into the chain */
      }
    }
    // We deliberately DO NOT trip the wire — annotation only.
    return { tripwireTriggered: false, outputInfo: metadata }
  },
}
