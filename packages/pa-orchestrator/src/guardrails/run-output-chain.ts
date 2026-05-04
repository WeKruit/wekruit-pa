/**
 * Output-guardrail chain runner. Single-pass; chain order (detail-plan §6):
 *
 *   lengthCap → abStrip → slangEnforcer → adviceRepeat → crisisTrailer
 *     → mirrorScore → outputNormalizer
 *
 * Each guardrail receives the LATEST in-flight text (post any prior
 * transform). Soft transforms emit `outputInfo.transformedOutput`; the
 * runner replaces the in-flight text and continues. Hard tripwires
 * (`tripwireTriggered=true`) HALT the chain (used by future guardrails;
 * none of the current 7 OGs trip hard).
 *
 * SDK gotcha (detail-plan R-5): the SDK's only first-agent guardrails-on-
 * handoff caveat is irrelevant here — iter30 design uses prompt-stacking,
 * not handoffs. This runner is also the single point where we enforce
 * "no re-entry" (§6 hard rule): one call = one chain pass.
 */
import type { ClaireContext } from "../run-context.js"
import type { GuardrailFunctionOutput, OutputGuardrail } from "./types.js"

export interface OutputChainResult {
  /** Final text after all soft transforms. */
  text: string
  /** Did at least one guardrail mutate the text? */
  transformed: boolean
  /** Suggested actions surfaced (e.g. `reject_resample`) — V1 caller-ignored. */
  suggestedActions: Array<{ name: string; action: string }>
  results: Array<{ name: string; output: GuardrailFunctionOutput }>
}

export interface RunOutputChainOptions {
  guardrails: OutputGuardrail[]
  agentOutput: string
  userInput: string
  ctx: ClaireContext
}

export async function runOutputChain(
  opts: RunOutputChainOptions
): Promise<OutputChainResult> {
  const results: OutputChainResult["results"] = []
  const suggestedActions: OutputChainResult["suggestedActions"] = []
  let text = opts.agentOutput
  let transformed = false
  for (const g of opts.guardrails) {
    let out: GuardrailFunctionOutput
    try {
      out = await g.execute({ agentOutput: text, userInput: opts.userInput, ctx: opts.ctx })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      try {
        opts.ctx.log("pa.guardrail.output.error", {
          userId: opts.ctx.userId,
          turnId: opts.ctx.turnId,
          name: g.name,
          error: msg,
        })
      } catch {
        /* never */
      }
      out = { tripwireTriggered: false, outputInfo: { error: msg } }
    }
    results.push({ name: g.name, output: out })
    const next = out.outputInfo?.transformedOutput as string | undefined
    if (typeof next === "string" && next !== text) {
      text = next
      transformed = true
    }
    const action = out.outputInfo?.suggestedAction as string | undefined
    if (action) suggestedActions.push({ name: g.name, action })
    if (out.tripwireTriggered) {
      // Future use — none of the current 7 OGs trip hard. Halt to be safe.
      const canned = out.outputInfo?.cannedReply as string | undefined
      if (typeof canned === "string") {
        text = canned
        transformed = true
      }
      break
    }
  }
  return { text, transformed, suggestedActions, results }
}
