/**
 * tools/process-tools.ts — WS-process owns this file.
 *
 * Reducer-owned onboarding + prescreen flow tools. Mirrors poc-v3 C/C2/C3:
 *   ask_next_onboarding_question / record_onboarding_answer  (onboarding-fsm reducer)
 *   ask_next_prescreen_question  / score_prescreen_answer    (prescreen-fsm + LLM judge in the tool)
 *   explain_prescreen_outcome                                (reads stored scores; no re-run)
 *
 * The LLM proposes the answer text + (via an in-tool judge sub-agent) a score; the
 * reducer DECIDES the next question, the PASS/FAIL rollup, commit-once, and rejects
 * out-of-order / post-terminal calls. The LLM never declares pass/fail or skips a slot.
 *
 * WS-process: replace the body — return an array of `tool({...})` (let TS infer).
 */
import { tool } from "@openai/agents"
import type { ClaireToolContext } from "../types.js"

void tool

export function buildProcessTools(_ctx: ClaireToolContext) {
  // TODO(WS-process): onboarding + prescreen FSM tools, wrapping the reducers
  // in reducers/onboarding-fsm.ts + reducers/prescreen-fsm.ts.
  return [] as ReturnType<typeof tool>[]
}
