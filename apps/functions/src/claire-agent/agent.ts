/**
 * agent.ts — Wave B owns this file (assembly + the inbound turn loop + cutover).
 *
 * `buildClaireAgent` constructs the single @openai/agents Agent (one agent, dynamic
 * mode-scoping — NO handoffs). `runClaireTurn` is the entry the inbound handler calls
 * behind `paThinClaireEnabled`: mark-read reflex → run(agent, text, {session}) →
 * post-run delivery decision. Wave B wires guardrails, the typing reflex, mode
 * directives, and the global read-context.
 *
 * Wave 0 stub: buildClaireAgent constructs a minimal real Agent (validates the SDK in
 * the functions bundle); runClaireTurn is not implemented yet.
 */
import { Agent } from "@openai/agents"
import type { ClaireRunResult, ClaireToolContext, ClaireTurnInput } from "./types.js"
import { notImplemented } from "./types.js"
import { buildClaireTools } from "./tools/index.js"
import { buildClairePrompt } from "./prompt.js"

/** Main conversation model (the judge model is configured separately per-tool). */
export const CLAIRE_MODEL = "gpt-5.4-nano"

export function buildClaireAgent(ctx: ClaireToolContext) {
  // TODO(Wave B): mode directives per process state, inputGuardrails/outputGuardrails,
  // typing reflex (agent.on), global read-context injection, model settings.
  return new Agent({
    name: "Claire",
    model: CLAIRE_MODEL,
    instructions: buildClairePrompt({ mode: "triage", lang: ctx.lang }),
    tools: buildClaireTools(ctx),
  })
}

export interface RunClaireTurnDeps extends ClaireToolContext {
  /** the @openai/agents Session (Firestore-backed) for durable memory. */
  session: unknown
}

export async function runClaireTurn(
  input: ClaireTurnInput,
  deps: RunClaireTurnDeps,
): Promise<ClaireRunResult> {
  return notImplemented("Wave B", "agent.runClaireTurn")
}
