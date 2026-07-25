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
  isSharedOnboardingGreetingOrKickoff,
  validateOnboardingCanonicalTags,
  mergeUserPrescreenSharedAnswers,
  isRegisteredSharedKey,
  AI_USAGE_SHARED_KEY,
  type OnboardingCanonicalTagInput,
  type PartialUserTags,
  YC_MATCH_DELIVERY_WHEN,
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
import { AI_QUESTION_QID } from "../prescreen-ai-question.js"

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
  /**
   * qId → the per-question RUBRIC the judge scores against (== buildThinPrescreenSeed().judgeContext:
   * the config's keyword hints + clarify cue). Injected alongside processStore by the same seeder.
   * The judge uses rubric[question] so a resume-grounded probing answer still maps to the job's real
   * must-haves. Absent → judge falls back to the generic competency grade (legacy behavior). NO REGEX:
   * passed as natural-language guidance to the LLM judge, never token-matched.
   *
   * (Also threaded as the 3rd positional arg to buildProcessTools so the live wiring + eval can pass
   * it next to prescreenPrompts; ctx is the fallback when the positional arg is absent.)
   */
  prescreenJudgeContext?: Record<string, string>
  /**
   * Short candidate resume blurb (work history + recent role + top skills) so the judge can credit
   * concrete, owned, resume-consistent answers and discount vague/contradictory ones. Built from the
   * SAME pa-users.tags fields loadGlobalContext reads (workHistorySummary, recentRoleTitle,
   * recentCompany, skills). Absent → judge scores on the answer alone.
   */
  prescreenResumeSnippet?: string
  /**
   * REAL pa-prescreen-sessions doc id of the active session (NOT ctx.sessionId, which is the iMessage
   * session). Threaded so the score tool can write the per-question score back to the live session doc
   * (resume + memory read it) and the post-turn terminal hook can fire the legacy terminal action on
   * the correct doc. Absent (e.g. onboarding-only ctx) → no write-back (eval reuses one in-memory store).
   */
  prescreenSessionId?: string
  /**
   * REAL pa-jobs job id of the active prescreen. Threaded so the shared-answer sole writer
   * (mergeUserPrescreenSharedAnswers) can stamp `sourceJobId` on the global record. Absent → the
   * shared-answer write is skipped (the record requires a source job for provenance + carry-over).
   */
  prescreenJobId?: string
  /**
   * qId → authored `sharedKey` for the active session's questions (== buildThinPrescreenSeed's
   * sharedKeys, from the job config + the appended AI question). When a finalized question's qId is
   * in this map AND the key is a registered sharedKey, its answer is persisted to the GLOBAL
   * cross-session store (pa-users.prescreenSharedAnswers) so future sessions skip + carry it. Absent
   * → no question is shared (dormant; legacy behavior).
   */
  prescreenSharedKeys?: Record<string, string>
  /**
   * Per-turn latch (set on ctx, which is fresh each inbound turn). score_prescreen_answer flips it true
   * after the FIRST successful score, and rejects any further score call IN THE SAME TURN. This is the
   * deterministic guard against the agent SCORING AHEAD — judging q2/q3 with fabricated answers the
   * candidate never gave (the reducer's out_of_order guard only blocks SKIPS, not ahead-of-turn scores).
   * One candidate message → at most one scored question. Resets every turn (ctx is rebuilt). NO REGEX.
   */
  prescreenScoredThisTurn?: boolean
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
 *
 * The optional `rubric` (the job's per-question must-haves, from buildThinPrescreenSeed.judgeContext)
 * and `resumeSnippet` (the candidate's résumé on file) go in the JUDGE INSTRUCTIONS (system-level), not
 * the user turn, so they FRAME grading rather than being treated as answer content. Empty opts →
 * byte-for-byte the legacy generic grade, so any path that doesn't set them is unchanged. NO REGEX:
 * rubric/resume are natural-language LLM guidance, never token-matched.
 */
function makeJudge(model: string, opts: { rubric?: string; resumeSnippet?: string } = {}) {
  const rubricBlock = opts.rubric
    ? `\n\nSCORE THIS ANSWER AGAINST THIS RUBRIC (the must-haves this question really tests). ` +
      `Reward answers that concretely demonstrate these signals; do not require the candidate to ` +
      `echo the exact words — judge the substance:\n${opts.rubric}`
    : ""
  const resumeBlock = opts.resumeSnippet
    ? `\n\nCANDIDATE RESUME ON FILE (use ONLY to verify the answer is concrete, owned, and consistent ` +
      `with real experience — a specific, resume-grounded answer scores higher than a vague or ` +
      `contradictory one; do NOT score the resume itself, score the answer):\n${opts.resumeSnippet}`
    : ""
  return new Agent({
    name: "prescreen-judge",
    model,
    instructions:
      "You grade a candidate's interview answer for the given competency. " +
      "Return score 0-1 (1=strong, concrete, owned, first-person specifics; " +
      "0=evasive, generic, or off-topic), evidence (a short quote from the answer), and reasoning. " +
      "You only PROPOSE a number — you never decide pass/fail." +
      rubricBlock +
      resumeBlock,
    outputType: z.object({
      score: z.number().min(0).max(1),
      evidence: z.string(),
      reasoning: z.string(),
    }),
  })
}

/**
 * Build the onboarding + prescreen FSM tools.
 *
 * `prescreenPrompts` (qId → DIRECTION text) lets the production wiring pass the config's
 * natural-language question text; the eval passes its own; falls back to the question id when absent.
 *
 * `judgeContext` (qId → RUBRIC = keyword hints + clarify cue from buildThinPrescreenSeed.judgeContext)
 * is the per-question rubric the score tool's judge grades against. Optional 3rd positional arg so the
 * existing 2-arg eval call (eval-process.mjs) stays valid; defaults to {} (legacy generic grade). When
 * absent here the score tool falls back to ctx.prescreenJudgeContext, then to the bare competency grade.
 * NO REGEX — the rubric is natural-language guidance handed to the LLM judge, never token-matched.
 */
export function buildProcessTools(
  ctx: ProcessToolContext,
  prescreenPrompts: PrescreenPrompts = {},
  judgeContext: Record<string, string> = {},
) {
  // The store is the single mutable seam: injected for evals, default for prod.
  const store: ProcessSessionStore = ctx.processStore ?? emptyProcessStore()
  if (!ctx.processStore) ctx.processStore = store
  // The judge now VARIES per question (rubric is qId-keyed) + per session (resume), so it's
  // constructed inside score_prescreen_answer.execute, not once here. Onboarding tools never used it.

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
      // targetLocations is a closed canonical vocab, but too large to inline as a zod enum, so it's a
      // string array gated by validateOnboardingCanonicalTags (off-vocab tokens are DROPPED). The model
      // can't pick a token it can't see — without this mapping it guessed 'new_york'/'remote' (both
      // off-vocab) and the location silently vanished (2026-05-30 capture gap). Surface the common-US
      // mapping so the LLM emits the EXACT canonical token (still LLM-picks-enum, no regex).
      targetLocations: z
        .array(z.string())
        .nullable()
        .describe(
          "Canonical US location tokens — pick the EXACT token (off-vocab is dropped). City → its metro " +
            "token: NYC/New York → 'new_york_metro'; SF/Bay Area → 'san_francisco_bay_area'; LA → " +
            "'los_angeles_metro'; Seattle → 'seattle_metro'; Boston → 'boston_metro'; Chicago → " +
            "'chicago_metro'; Austin → 'austin_metro'; DC → 'washington_dc_metro'. Remote: US-remote / " +
            "work-from-home → 'remote_united_states'; fully remote / anywhere / no preference / open to " +
            "any location → 'remote_anywhere'. Capture EVERY location they mention (e.g. 'NYC or remote' → " +
            "['new_york_metro','remote_united_states']). Only use a metro token for a city, never the bare city name.",
        ),
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
                  preferenceHardness.map((h: { axis: string; hardness: "hard" | "soft"; bufferPct: number | null; bufferSteps: number | null }) => [
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
      // ONE-SCORE-PER-TURN: the candidate gave exactly one message this turn → at most one question may
      // be scored. Reject a 2nd score call in the same turn so the agent can't grade q2/q3 with answers
      // the candidate never gave (the cause of premature FAIL). Deterministic, not a judge/regex call.
      if (ctx.prescreenScoredThisTurn) {
        const stillPending = p.questions.find((q) => !(q in p.scores)) ?? null
        ctx.log("prescreen.score.rejected", { reason: "already_scored_this_turn", pending: stillPending })
        return {
          ok: false,
          reason: "already_scored_this_turn: ask this pending question and wait for the candidate's reply",
          pending: stillPending,
        }
      }
      // no-skip: reject before spending a judge call on an out-of-order question.
      const expected = p.questions.find((q) => !(q in p.scores)) ?? null
      if (question !== expected) {
        ctx.log("prescreen.score.rejected", { reason: "out_of_order", expected, got: question })
        return { ok: false, reason: `out_of_order: expected ${expected}`, pending: expected }
      }
      // ── LLM JUDGE proposes the score (side-effect = evidence); reducer consumes it ──
      // Rubric is keyed by the SAME qId the reducer gates on; resume is per-session. Both optional →
      // absent = legacy generic grade. The 3rd positional `judgeContext` arg wins; ctx is the fallback
      // (the live wiring sets the positional arg; older callers may set ctx only). NO REGEX: rubric is
      // natural-language judge guidance only.
      const rubric = judgeContext[question] ?? ctx.prescreenJudgeContext?.[question]
      const resumeSnippet = ctx.prescreenResumeSnippet
      const judge = makeJudge(ctx.judgeModel, { rubric, resumeSnippet })
      // Use the human DIRECTION question text when available so the judge grades against the actual
      // asked competency, not a bare slot id (strict improvement; harmless when prompts is {}).
      const judgePrompt = rubric
        ? `Competency (interview question asked): ${prescreenPrompts[question] ?? question}\n` +
          `What a strong answer must demonstrate (rubric): ${rubric}\n` +
          `Candidate answer: ${answer}\n` +
          `Score how well the answer demonstrates the rubric.`
        : `Competency: ${prescreenPrompts[question] ?? question}\nCandidate answer: ${answer}`
      const jr = await run(judge, judgePrompt)
      const proposed = jr.finalOutput?.score ?? 0
      const evidence = jr.finalOutput?.evidence ?? ""
      // reducer records + (when last) does the DETERMINISTIC PASS/FAIL rollup, commit-once.
      const result = recordPrescreenScore(p, question, { score: proposed, evidence })
      // latch the per-turn guard the moment a question is actually recorded → any further score call
      // this turn is rejected (the agent must ask the next question and wait for the next message).
      ctx.prescreenScoredThisTurn = true
      // PERSIST the score back to the live pa-prescreen-sessions doc (resume + memory read it). The
      // store is re-seeded fresh each inbound turn from the session doc (buildThinPrescreenSeed reads
      // session.scored); without this write-back, turn 2 re-seeds with NO scores and the FSM thinks
      // q1 is still pending → the screen never advances in prod. Best-effort; never blocks the verdict.
      // Mirrors onboarding's persistOnboardingAnswerThrough. Only when a real session id is threaded.
      if (ctx.prescreenSessionId && ctx.db) {
        await ctx.db
          .collection("pa-prescreen-sessions")
          .doc(ctx.prescreenSessionId)
          .set(
            {
              scored: { [question]: { score: result.score ?? proposed, evidence } },
              ...(result.terminal ? { terminal: result.terminal } : {}),
              updatedAt: ctx.nowIso(),
            },
            { merge: true },
          )
          .catch((err: unknown) =>
            ctx.log("prescreen.score.writeback_error", {
              question,
              error: err instanceof Error ? err.message : String(err),
            }),
          )
      }
      // CROSS-SESSION SHARED-ANSWER capture (SPEC §6 — generalizes the bespoke AI-usage MVP):
      // when a finalized question carries an authored `sharedKey`, persist the candidate's verbatim
      // answer + the source job's score GLOBALLY to pa-users.prescreenSharedAnswers[sharedKey] via the
      // sole writer mergeUserPrescreenSharedAnswers. ONE authoritative store: future sessions whose
      // config (or appended AI question) uses the same sharedKey SKIP + CARRY (re-judged) this answer.
      // The sharedKey is resolved from ctx.prescreenSharedKeys (job config + appended AI question);
      // the appended AI question (AI_QUESTION_QID) maps to AI_USAGE_SHARED_KEY by default. NOT canonical
      // tagging (open free text, never an enum). Best-effort; a write failure never blocks the verdict.
      const finalizedSharedKey =
        result.ok
          ? ctx.prescreenSharedKeys?.[question] ??
            (question === AI_QUESTION_QID ? AI_USAGE_SHARED_KEY : undefined)
          : undefined
      if (finalizedSharedKey && isRegisteredSharedKey(finalizedSharedKey) && ctx.db && ctx.userId) {
        const nowIso = ctx.nowIso()
        if (ctx.prescreenJobId && ctx.prescreenSessionId) {
          await mergeUserPrescreenSharedAnswers(
            ctx.db,
            ctx.userId,
            {
              sharedKey: finalizedSharedKey,
              reply: answer.trim(),
              evidenceReplies: [answer.trim()],
              // Claire's reducer proposes a single score; finalC has no source on this path.
              finalS: typeof (result.score ?? proposed) === "number" ? (result.score ?? proposed) : undefined,
              ...(evidence ? { summary: evidence } : {}),
              sourceSessionId: ctx.prescreenSessionId,
              sourceJobId: ctx.prescreenJobId,
              answeredAt: nowIso,
              updatedAt: nowIso,
            },
            { nowIso, log: ctx.log },
          ).catch((err: unknown) =>
            ctx.log("prescreen.shared_answer.write_error", {
              sharedKey: finalizedSharedKey,
              error: err instanceof Error ? err.message : String(err),
            }),
          )
        }
        // BACK-COMPAT (migration window): keep the legacy tags.aiAccelerationUsage skip signal warm
        // so any code/session still reading it (shouldSkipAiQuestion's legacy branch) still skips the
        // AI question. Only for the ai_usage key. Drop after the carry-over read is fully cut over.
        if (finalizedSharedKey === AI_USAGE_SHARED_KEY) {
          await applyPartialUserTags(
            ctx.db,
            ctx.userId,
            { aiAccelerationUsage: { value: answer.trim(), updatedAt: nowIso } } as PartialUserTags,
            { source: "chat", nowIso, log: ctx.log },
          ).catch((err: unknown) =>
            ctx.log("prescreen.ai_usage.write_error", {
              error: err instanceof Error ? err.message : String(err),
            }),
          )
        }
      }
      ctx.log("prescreen.score.recorded", {
        question,
        score: result.score,
        pending: result.pending,
        terminal: result.terminal,
        terminalCommits: p.terminalCommits,
        rubricApplied: Boolean(rubric),
        resumeApplied: Boolean(resumeSnippet),
        wroteBack: Boolean(ctx.prescreenSessionId),
        sharedAnswerKey: finalizedSharedKey ?? null,
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

  // YC Startup School event intake (Adam 2026-07-21): two free-text slots the
  // event QR conversation captures — "what are you building" and "who do you
  // want to meet". Free text has NO canonical vocab, so it lives on
  // pa-users.ycIntake (plain fields), never tags/statedPreferences. When the
  // second slot lands, completedAt is stamped and the tool result tells the
  // agent to close with the no-timing match promise.
  const recordYcIntake = tool({
    name: "record_yc_intake",
    description:
      "YC STARTUP SCHOOL EVENT INTAKE ONLY (the turn directive says when). Record the attendee's answer to one " +
      "of the two event questions: field 'building' = what they're building/working on; field 'wants_to_meet' = " +
      "who they want to talk to (kind of founders/startups/people). Pass their answer essence verbatim-ish (their " +
      "words, lightly trimmed). The result tells you whether to ask the other question next or to CLOSE with the " +
      "match promise (we will text them once we find a good match).",
    parameters: z.object({
      field: z.enum(["building", "wants_to_meet"]),
      answer: z.string(),
    }),
    async execute({ field, answer }) {
      const text = answer.trim().slice(0, 1200)
      if (!text) return { ok: false, error: "empty_answer" }
      // Live probe 2026-07-22: the model recorded the QR OPENER as the 'building'
      // answer. Deterministic reject — greetings/openers are never answers.
      if (isSharedOnboardingGreetingOrKickoff(text)) {
        return {
          ok: false,
          error: "greeting_not_an_answer",
          nextAction:
            "That text is their greeting/opener, not an answer. Ask the question conversationally and record what they actually say.",
        }
      }
      if (!ctx.db || !ctx.userId) return { ok: false, error: "no_user_context" }
      const nowIso = new Date().toISOString()
      try {
        const userRef = ctx.db.collection("pa-users").doc(ctx.userId)
        const snap = await userRef.get()
        const cur = (snap.data()?.ycIntake ?? {}) as { building?: string; wantsToMeet?: string }
        const next = {
          ...cur,
          ...(field === "building" ? { building: text } : { wantsToMeet: text }),
        }
        const complete = Boolean(next.building && next.wantsToMeet)
        await userRef.set(
          {
            ycIntake: { ...next, updatedAt: nowIso, ...(complete ? { completedAt: nowIso } : {}) },
            updatedAt: nowIso,
          },
          { merge: true },
        )
        ctx.log("yc_intake.recorded", { userId: ctx.userId, field, complete })
        return {
          ok: true,
          recorded: field,
          intakeComplete: complete,
          nextAction: complete
            ? `CLOSE the intake now: tell them you've got what you need and WeKruit will match them with the right Startup School people. Say their matches land on ${YC_MATCH_DELIVERY_WHEN} and you'll text them right here. Warm, one message, NO attendee list link (there is none to share), no further questions.`
            : field === "building"
              ? "Ask who they'd like to talk to (kind of founders/startups/people) — one short question."
              : "Ask what they're building / working on — one short question.",
        }
      } catch (err) {
        ctx.log("yc_intake.write_error", {
          userId: ctx.userId,
          error: err instanceof Error ? err.message : String(err),
        })
        return { ok: false, error: "write_failed" }
      }
    },
  })

  return [
    askNextOnboarding,
    recordOnboarding,
    askNextPrescreen,
    scorePrescreen,
    explainOutcome,
    // Appended LAST: process-tools tests address tools by index.
    recordYcIntake,
  ]
}
