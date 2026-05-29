/**
 * tools/process-tools.ts — WS-process owns this file.
 *
 * Reducer-owned onboarding + prescreen flow tools. Mirrors poc-v3 C/C2/C3:
 *   ask_next_onboarding_question / record_onboarding_answer  (onboarding-fsm reducer)
 *   ask_next_prescreen_question  / score_prescreen_answer    (prescreen-fsm + LLM judge in the tool)
 *   explain_prescreen_outcome                                (reads stored scores; no re-run)
 *
 * KEYSTONE: the LLM proposes the answer text + (via an in-tool judge sub-agent) a
 * score; the deterministic REDUCER DECIDES the next question, the PASS/FAIL
 * rollup, commit-once, and rejects out-of-order / post-terminal calls. The LLM
 * never declares pass/fail or skips a slot. The score tool returns the reducer's
 * verdict; it never says pass/fail itself.
 *
 * State lives in a per-session `ProcessSessionStore` (onboarding + prescreen
 * FSM state). Evals inject an in-memory store; production wires a db-backed one
 * (seam below). Either way the reducers in reducers/onboarding-fsm.ts +
 * reducers/prescreen-fsm.ts are the sole authority on every transition.
 */
import { Agent, run, tool } from "@openai/agents"
import { z } from "zod"
import type { ClaireToolContext } from "../types.js"
import {
  DEFAULT_ONBOARDING_SLOTS,
  nextOnboardingSlot,
  onboardingPromptFor,
  recordOnboardingAnswer,
  type OnboardingState,
} from "../reducers/onboarding-fsm.js"
import {
  DEFAULT_PRESCREEN_THRESHOLD,
  nextPrescreenQuestion,
  recordPrescreenScore,
  type PrescreenState,
} from "../reducers/prescreen-fsm.js"

/**
 * Per-session process state the tools read/write. Onboarding + prescreen FSM
 * state, exactly the shape the reducers reduce over (poc-v3 makeDb mirror).
 */
export interface ProcessSessionStore {
  onboarding: OnboardingState
  prescreen: PrescreenState
}

/** ctx + the (optionally injected) per-session process store. */
export type ProcessToolContext = ClaireToolContext & {
  /** Injected by evals + the production turn handler; default seeded from config. */
  processStore?: ProcessSessionStore
}

/** A natural-language prompt per prescreen question id (config-supplied or id fallback). */
export type PrescreenPrompts = Record<string, string>

/** Seed an empty store from the canonical onboarding slots + an empty prescreen. */
export function emptyProcessStore(): ProcessSessionStore {
  return {
    onboarding: { slots: [...DEFAULT_ONBOARDING_SLOTS], answers: {}, complete: false },
    prescreen: {
      questions: [],
      scores: {},
      threshold: DEFAULT_PRESCREEN_THRESHOLD,
      terminal: null,
      terminalCommits: 0,
    },
  }
}

/**
 * The in-tool LLM JUDGE. A small @openai/agents Agent that PROPOSES a score for
 * a single competency answer (poc-v3 C judge verbatim). The reducer consumes the
 * number; this agent never decides PASS/FAIL.
 */
function makeJudge(model: string) {
  return new Agent({
    name: "prescreen-judge",
    model,
    instructions:
      "You grade a candidate's interview answer for the given competency. " +
      "Return score 0-1 (1=strong, concrete, owned), evidence (quote), reasoning.",
    outputType: z.object({
      score: z.number().min(0).max(1),
      evidence: z.string(),
      reasoning: z.string(),
    }),
  })
}

/**
 * Build the onboarding + prescreen FSM tools. `prescreenPrompts` lets the
 * production wiring pass the config's natural-language question text; the eval
 * passes its own. Falls back to the question id when no prompt is supplied.
 */
export function buildProcessTools(
  ctx: ProcessToolContext,
  prescreenPrompts: PrescreenPrompts = {},
) {
  // The store is the single mutable seam: injected for evals, default for prod.
  const store: ProcessSessionStore = ctx.processStore ?? emptyProcessStore()
  if (!ctx.processStore) ctx.processStore = store
  const judge = makeJudge(ctx.judgeModel)

  // ── C: onboarding FSM (reducer-owned; LLM only phrases) ──
  const askNextOnboarding = tool({
    name: "ask_next_onboarding_question",
    description:
      "Get the next onboarding slot to ask. Returns the pending slot id + prompt, or done.",
    parameters: z.object({}),
    async execute() {
      const next = nextOnboardingSlot(store.onboarding)
      ctx.log("onboarding.ask_next", { pending: next.pending, complete: next.complete })
      return next.pending
        ? { pending: next.pending, prompt: next.prompt }
        : { pending: null, complete: true }
    },
  })
  const recordOnboarding = tool({
    name: "record_onboarding_answer",
    description:
      "Record the candidate's answer to the CURRENT onboarding slot. Reducer advances; you cannot skip slots.",
    parameters: z.object({ slot: z.string(), answer: z.string() }),
    async execute({ slot, answer }) {
      const result = recordOnboardingAnswer(store.onboarding, slot, answer)
      ctx.log("onboarding.record", {
        slot,
        ok: result.ok,
        reason: result.reason,
        pending: result.pending,
        complete: result.complete,
      })
      // reducer rejects skip / out-of-order; pass its verdict straight to the LLM.
      return result
    },
  })

  // ── C: prescreen FSM + LLM-judge scoring (reducer rollup, commit-once) ──
  const askNextPrescreen = tool({
    name: "ask_next_prescreen_question",
    description:
      "Get the next prescreen question. Returns pending question id, or terminal if all scored.",
    parameters: z.object({}),
    async execute() {
      const next = nextPrescreenQuestion(store.prescreen)
      ctx.log("prescreen.ask_next", { pending: next.pending, terminal: next.terminal })
      if (next.terminal) return { terminal: next.terminal }
      return next.pending
        ? { pending: next.pending, prompt: prescreenPrompts[next.pending] ?? next.pending }
        : { pending: null }
    },
  })
  const scorePrescreen = tool({
    name: "score_prescreen_answer",
    description:
      "Submit the candidate's answer to the CURRENT prescreen question. An LLM judge scores it; " +
      "the reducer records the score, advances, and at the end computes PASS/FAIL. You do NOT decide " +
      "pass/fail or skip — the reducer does.",
    parameters: z.object({ question: z.string(), answer: z.string() }),
    async execute({ question, answer }) {
      const p = store.prescreen
      // idempotency: reducer rejects post-terminal re-score; short-circuit the judge call too.
      if (p.terminal) {
        ctx.log("prescreen.score.rejected", { reason: "already_terminal", terminal: p.terminal })
        return { ok: false, reason: "already_terminal", terminal: p.terminal }
      }
      // no-skip: reject before spending a judge call on an out-of-order question.
      const expected = p.questions.find((q) => !(q in p.scores)) ?? null
      if (question !== expected) {
        ctx.log("prescreen.score.rejected", { reason: "out_of_order", expected, got: question })
        return { ok: false, reason: `out_of_order: expected ${expected}`, pending: expected }
      }
      // ── LLM JUDGE proposes the score (side-effect = evidence); reducer consumes it ──
      const jr = await run(judge, `Competency: ${question}\nCandidate answer: ${answer}`)
      const proposed = jr.finalOutput?.score ?? 0
      const evidence = jr.finalOutput?.evidence ?? ""
      // reducer records + (when last) does the DETERMINISTIC PASS/FAIL rollup, commit-once.
      const result = recordPrescreenScore(p, question, { score: proposed, evidence })
      ctx.log("prescreen.score.recorded", {
        question,
        score: result.score,
        pending: result.pending,
        terminal: result.terminal,
        terminalCommits: p.terminalCommits,
      })
      // return the REDUCER's verdict — never declare pass/fail here.
      return result
    },
  })
  const explainOutcome = tool({
    name: "explain_prescreen_outcome",
    description:
      "Explain the prescreen result (uses stored scores/evidence). Does NOT re-run the screen.",
    parameters: z.object({}),
    async execute() {
      const p = store.prescreen
      ctx.log("prescreen.explain", { terminal: p.terminal, scored: Object.keys(p.scores).length })
      return { terminal: p.terminal, scores: p.scores }
    },
  })

  return [
    askNextOnboarding,
    recordOnboarding,
    askNextPrescreen,
    scorePrescreen,
    explainOutcome,
  ]
}
