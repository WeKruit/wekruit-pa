/**
 * Input-guardrail chain runner. Replaces the scattered `checkInboundSafety`
 * + per-detector inline calls with a deterministic single-pass executor.
 *
 * Chain order (Adam-locked, detail-plan §6):
 *   crisisDetector → promptInjectionDetector → piiScanner → lengthInputCheck
 *     → openaiModeration (parallel-eligible)
 *
 * Behaviour:
 *   - First HARD trip (`tripwireTriggered=true`) wins; subsequent guardrails
 *     are SKIPPED for cost. Returns `{ allowed: false, cannedReply, ... }`.
 *   - Soft annotations (crisisDetector → ctx.crisisTripped) accumulate even
 *     if a later guardrail trips.
 *   - Single-pass — no re-entry. Detail-plan §6 hard-rule.
 */
import type { ClaireContext } from "../run-context.js"
import type { GuardrailFunctionOutput, InputGuardrail } from "./types.js"

export interface InputChainResult {
  /** True iff no guardrail tripped a hard halt. */
  allowed: boolean
  /** When `allowed=false`, the canned text to ship (or empty for silent_drop). */
  cannedReply?: string
  /** Which guardrail tripped first (or null if all passed). */
  trippedBy: string | null
  /** Cumulative metadata for telemetry. */
  results: Array<{ name: string; output: GuardrailFunctionOutput }>
}

export interface RunInputChainOptions {
  guardrails: InputGuardrail[]
  input: string
  ctx: ClaireContext
}

export async function runInputChain(
  opts: RunInputChainOptions
): Promise<InputChainResult> {
  const results: InputChainResult["results"] = []
  for (const g of opts.guardrails) {
    let out: GuardrailFunctionOutput
    try {
      out = await g.execute({ input: opts.input, ctx: opts.ctx })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      try {
        opts.ctx.log("pa.guardrail.input.error", {
          userId: opts.ctx.userId,
          turnId: opts.ctx.turnId,
          name: g.name,
          error: msg,
        })
      } catch {
        /* logging never escapes */
      }
      // Posture: fail-OPEN on guardrail bug. Adam Q: do not block live users
      // on a guardrail crash; surface in audit + dashboards instead.
      out = { tripwireTriggered: false, outputInfo: { error: msg } }
    }
    results.push({ name: g.name, output: out })
    if (out.tripwireTriggered) {
      const cannedReply = (out.outputInfo?.cannedReply as string | undefined) ?? ""
      return {
        allowed: false,
        cannedReply,
        trippedBy: g.name,
        results,
      }
    }
  }
  return { allowed: true, trippedBy: null, results }
}
