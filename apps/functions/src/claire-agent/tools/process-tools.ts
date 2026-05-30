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
import { Agent, run, tool, z } from "../sdk.js"
import {
  ROLE_FUNCTION_VOCAB,
  INDUSTRY_SECTOR_VOCAB,
  JOB_TYPE_VOCAB,
  CAREER_STAGE_VOCAB,
  VISA_VOCAB,
  COMPANY_SIZE_VOCAB,
  HARDNESS_AXIS_VOCAB,
} from "@wekruit/shared-tags"
import {
  applyPartialUserTags,
  validateOnboardingCanonicalTags,
  type OnboardingCanonicalTagInput,
  type PartialUserTags,
} from "@pa/pa-orchestrator"
import type { ClaireToolContext } from "../types.js"
import {
  DEFAULT_ONBOARDING_SLOTS,
  nextOnboardingSlot,
  onboardingPromptFor,
  recordOnboardingAnswer,
  type OnboardingState,
} from "../reducers/onboarding-fsm.js"

// Rebuild the closed enums on the SDK's zod instance (shared-tags schemas are a
// different zod instance and can't be mixed into a tool param schema — the VOCAB
// arrays are plain strings, instance-agnostic). Mirrors matching-tools.ts.
const RoleFunctionEnum = z.enum(ROLE_FUNCTION_VOCAB)
const IndustrySectorEnum = z.enum(INDUSTRY_SECTOR_VOCAB)
const JobTypeEnum = z.enum(JOB_TYPE_VOCAB)
const CareerStageEnum = z.enum(CAREER_STAGE_VOCAB)
const VisaEnum = z.enum(VISA_VOCAB)
const CompanySizeEnum = z.enum(COMPANY_SIZE_VOCAB)
const HardnessAxisEnum = z.enum(HARDNESS_AXIS_VOCAB)

/** Per-axis hardness/negotiability the agent can attach to a slot answer. */
const HardnessEntryParam = z.object({
  axis: HardnessAxisEnum,
  hardness: z.enum(["hard", "soft"]),
  bufferPct: z.number().min(0).max(1).nullable(),
  bufferSteps: z.number().int().min(0).max(4).nullable(),
})
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

/**
 * Deterministic onboarding net (regex-free). gpt-5.4-nano skips record_onboarding_answer ~1/5 of
 * turns; without a net the slot never advances and onboarding stalls. This guarantees the slot
 * advances + the raw answer is stored so onboarding ALWAYS completes. It does NOT extract canonical
 * tags (no regex, no LLM) — that's the LLM tool's job on the ~4/5 turns it fires; the raw answer is
 * retained for later re-extraction. Caller only invokes it when the LLM tool did NOT record the slot.
 */
export async function persistOnboardingAnswerThrough(
  ctx: ClaireToolContext,
  slot: string,
  answer: string,
): Promise<void> {
  const slots = [...DEFAULT_ONBOARDING_SLOTS]
  const idx = slots.indexOf(slot)
  if (idx < 0) return
  const now = ctx.nowIso()
  const nextSlot = idx + 1 < slots.length ? slots[idx + 1]! : null
  const completed = nextSlot === null
  await ctx.db
    .collection("pa-users")
    .doc(ctx.userId)
    .set(
      {
        onboardingState: completed ? "complete" : "pending",
        onboardingStatus: completed ? "complete" : "invited",
        updatedAt: now,
        sharedOnboarding: {
          status: completed ? "complete" : "active",
          updatedAt: now,
          currentQuestionId: nextSlot,
          completed,
          ...(completed ? { completedAt: now } : {}),
          answers: { [slot]: { answer: answer.trim(), answeredAt: now, questionId: slot } },
        },
      },
      { merge: true },
    )
    .catch((err: unknown) =>
      ctx.log("onboarding.net_write_error", {
        slot,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
}

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
      "Record the candidate's answer to the CURRENT onboarding slot. Reducer advances; you cannot skip slots. " +
      "NO REGEX: YOU (the agent) map the candidate's free text to the canonical enum fields the answer supports — " +
      "fill ONLY what the answer clearly states, leave the rest null, and capture ALL values they mention (arrays = OR, " +
      "e.g. 'a small startup or big tech' → companySize:['early_startup','enterprise']). " +
      "Attach per-axis hardness when they signal strictness/flexibility ('must be NYC'→location hard; " +
      "'need 140k but could flex to 130'→salary soft + bufferPct ~0.07; 'ideally senior, open to mid'→careerStage soft + bufferSteps 1). " +
      "The tool validates your picks against the canonical vocab and writes durable tags to the candidate profile; " +
      "the reducer still owns slot order.",
    parameters: z.object({
      slot: z.string(),
      // Raw answer text — kept for the memory fact / transcript bookkeeping.
      answer: z.string(),
      // Canonical enum fields the agent fills (the set_matching_preferences shape).
      targetRoleFunction: z.array(RoleFunctionEnum).nullable(),
      negativeRoleFunction: z.array(RoleFunctionEnum).nullable(),
      industrySector: z.array(IndustrySectorEnum).nullable(),
      negativeIndustrySector: z.array(IndustrySectorEnum).nullable(),
      companySize: z.array(CompanySizeEnum).nullable(),
      targetJobType: z.array(JobTypeEnum).nullable(),
      targetLocations: z.array(z.string()).nullable(),
      careerStage: CareerStageEnum.nullable(),
      visaStatus: VisaEnum.nullable(),
      minSalary: z.number().int().nonnegative().nullable(),
      preferenceHardness: z.array(HardnessEntryParam).nullable(),
    }),
    async execute({ slot, answer, preferenceHardness, ...canonical }) {
      // 1) Reducer owns ORDER — record the raw answer for the current slot only.
      const result = recordOnboardingAnswer(store.onboarding, slot, answer)
      // 1b) DURABLE ADVANCE — recordOnboardingAnswer only mutates the in-memory `store`; the
      //     mode-selector re-reads sharedOnboarding.currentQuestionId from Firestore on the NEXT
      //     inbound. Without persisting the advance here, durable currentQuestionId never moves on a
      //     tool-fired turn, so the agent re-derives the SAME pendingStep and re-asks the same
      //     question forever (live stall 2026-05-30: Claire stuck on the culture/team slot). The
      //     net (persistOnboardingAnswerThrough) is skipped precisely when this tool fires, so this
      //     is the single durable write — same writer, same positional slot order.
      if (result.ok && ctx.db && ctx.userId) {
        await persistOnboardingAnswerThrough(ctx, slot, answer).catch((err: unknown) =>
          ctx.log("onboarding.tool_advance_error", {
            slot,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
      }
      // 2) Persist the AGENT-extracted canonical tags via the D8 sole writer.
      //    Validated against shared-tags enums (off-vocab dropped). Best-effort;
      //    a tag-write failure never blocks the slot advance. No regex anywhere.
      let tagWriteOk = false
      let writtenKeys: string[] = []
      if (result.ok && ctx.db && ctx.userId) {
        const llmTags: OnboardingCanonicalTagInput = {
          targetRoleFunction: canonical.targetRoleFunction,
          negativeRoleFunction: canonical.negativeRoleFunction,
          industrySector: canonical.industrySector,
          negativeIndustrySector: canonical.negativeIndustrySector,
          companySize: canonical.companySize,
          targetJobType: canonical.targetJobType,
          targetLocations: canonical.targetLocations,
          careerStage: canonical.careerStage,
          visaStatus: canonical.visaStatus,
          minSalary: canonical.minSalary,
          ...(preferenceHardness && preferenceHardness.length > 0
            ? {
                preferenceHardness: Object.fromEntries(
                  preferenceHardness.map((h) => [
                    h.axis,
                    {
                      hardness: h.hardness,
                      ...(h.bufferPct != null ? { bufferPct: h.bufferPct } : {}),
                      ...(h.bufferSteps != null ? { bufferSteps: h.bufferSteps } : {}),
                    },
                  ]),
                ),
              }
            : {}),
        }
        const tags = validateOnboardingCanonicalTags(llmTags, { source: "onboarding" })
        writtenKeys = Object.keys(tags)
        if (writtenKeys.length > 0) {
          const w = await applyPartialUserTags(ctx.db, ctx.userId, tags as PartialUserTags, {
            source: "chat",
            nowIso: ctx.nowIso(),
            log: ctx.log,
          }).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
          tagWriteOk = w.ok
        }
      }
      ctx.log("onboarding.record", {
        slot,
        ok: result.ok,
        reason: result.reason,
        pending: result.pending,
        complete: result.complete,
        tagWriteOk,
        writtenKeys,
      })
      // reducer rejects skip / out-of-order; pass its verdict straight to the LLM.
      return { ...result, tagWriteOk, writtenKeys }
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
