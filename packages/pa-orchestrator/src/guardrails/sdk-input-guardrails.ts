/**
 * P8 — bridge the deterministic INPUT_GUARDRAIL_CHAIN to an `@openai/agents`
 * SDK-native input guardrail.
 *
 * The architecture mandates safety via SDK `inputGuardrails` (run before the
 * agent, can tripwire) rather than scattered hand-written pre-filters. The
 * agent-runtime adapter accepts `AgentInputGuardrailSpec[]` on the turn context
 * and wires each as an SDK `inputGuardrail` with `runInParallel: false` — so a
 * HARD trip halts the turn BEFORE the model runs (safety must never race the
 * LLM). This helper produces that spec from the existing, already-tested chain.
 *
 * Chain semantics preserved (run-input-chain.ts):
 *   - crisisDetector — annotate-only (never hard-trips here; the hotline trailer
 *     is an OUTPUT guardrail by design).
 *   - promptInjectionDetector / piiScanner / lengthInput — HARD trips that halt
 *     the turn and carry a `cannedReply` for the caller to ship.
 *   - fail-OPEN on a guardrail crash (a guardrail bug never blocks live users).
 *
 * `ctxFactory` builds the per-input `ClaireContext`; the agentic call site
 * already constructs the real run-context, so it passes a thin factory. Keeping
 * the factory injected means this module has no Firestore / mock coupling.
 */
import type { AgentInputGuardrailSpec } from "@pa/agent-runtime"
import type { ClaireContext } from "../run-context.js"
import { INPUT_GUARDRAIL_CHAIN } from "./index.js"
import { runInputChain } from "./run-input-chain.js"
import type { InputGuardrail } from "./types.js"

export function buildSafetyInputGuardrails(
  ctxFactory: (input: string) => ClaireContext,
  guardrails: InputGuardrail[] = INPUT_GUARDRAIL_CHAIN
): AgentInputGuardrailSpec[] {
  return [
    {
      name: "input-safety-chain",
      execute: async (input: string) => {
        const result = await runInputChain({ guardrails, input, ctx: ctxFactory(input) })
        return {
          tripwireTriggered: !result.allowed,
          outputInfo: {
            trippedBy: result.trippedBy,
            cannedReply: result.cannedReply ?? "",
          },
        }
      },
    },
  ]
}
