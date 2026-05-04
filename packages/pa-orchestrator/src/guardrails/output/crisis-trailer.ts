/**
 * OG-5: crisisTrailerGuardrail — append safety hotline trailer when
 * `ctx.crisisTripped === true` (set by IG-1 crisisDetector).
 *
 * Detail-plan ws-3-6-detail.md §5.2 OG-5 + §7 M-4. Replaces the
 * detect-AND-inject duplication today: input-detection annotates ctx,
 * output-trailer reads ctx → single source of truth for detection.
 *
 * Gated by `ctx.featureFlags.paCrisisHotlineInjectionEnabled` (default
 * true). When the flag is off, this guardrail is a no-op even if
 * `crisisTripped=true` — gives Adam a kill-switch without dropping the
 * detection telemetry.
 */
import { appendHotlineIfMissing, detectCrisisLanguage } from "@pa/pa-safety"
import type { OutputGuardrail } from "../types.js"
import { recordGuardrailHit } from "../types.js"

export const crisisTrailerGuardrail: OutputGuardrail = {
  name: "crisisTrailer",
  execute: ({ agentOutput, ctx, userInput }) => {
    const t0 = Date.now()
    const reply = agentOutput ?? ""
    const flagOn = ctx.featureFlags.paCrisisHotlineInjectionEnabled !== false
    if (!ctx.crisisTripped || !flagOn || !reply) {
      const reason = !flagOn
        ? "flag_off"
        : !ctx.crisisTripped
          ? "no_crisis"
          : "empty_reply"
      const noopMeta = { injected: false, reason }
      recordGuardrailHit(ctx, {
        name: "crisisTrailer",
        type: "output",
        tripped: false,
        metadata: noopMeta,
        latencyMs: Date.now() - t0,
      })
      return { tripwireTriggered: false, outputInfo: noopMeta }
    }
    // Lang derived from raw user input — keeps trailer-language consistent
    // with the user's chosen tongue, not the (sometimes-translated) reply.
    const language = detectCrisisLanguage(userInput ?? "")
    const result = appendHotlineIfMissing({ reply, language })
    const transformed = result.appended
    const metadata = {
      injected: result.appended,
      language,
      reason: result.reason,
    }
    recordGuardrailHit(ctx, {
      name: "crisisTrailer",
      type: "output",
      tripped: false,
      metadata,
      latencyMs: Date.now() - t0,
    })
    if (transformed) {
      try {
        ctx.log("pa.safety.crisis_trailer_injected", {
          userId: ctx.userId,
          turnId: ctx.turnId,
          language,
          reason: result.reason,
        })
      } catch {
        /* logging failures never escape */
      }
    }
    return {
      tripwireTriggered: false,
      outputInfo: {
        ...metadata,
        transformedOutput: transformed ? result.text : undefined,
      },
    }
  },
}
