/**
 * OG-3: slangEnforcerGuardrail — POST-LLM banned-word substitutions.
 *
 * Detail-plan ws-3-6-detail.md §5.2 OG-3 + §7 M-3. The banlist this guardrail
 * enforced targeted a non-English register that the product no longer emits;
 * the product is English-only, so there is nothing to substitute. The
 * guardrail is retained as a no-op so the chain wiring, telemetry contract,
 * and SDK shape stay stable, but it never transforms output.
 */
import type { OutputGuardrail } from "../types.js"
import { recordGuardrailHit } from "../types.js"

export const slangEnforcerGuardrail: OutputGuardrail = {
  name: "slangEnforcer",
  execute: ({ agentOutput, ctx }) => {
    const t0 = Date.now()
    const input = agentOutput ?? ""
    // English-only product: no banned-register substitutions to apply.
    const substitutions: Array<{ from: string; to: string; count: number }> = []
    const metadata = { substitutions, transformed: false }
    recordGuardrailHit(ctx, {
      name: "slangEnforcer",
      type: "output",
      tripped: false,
      metadata,
      latencyMs: Date.now() - t0,
    })
    return {
      tripwireTriggered: false,
      outputInfo: { ...metadata, transformedOutput: undefined },
    }
  },
}
