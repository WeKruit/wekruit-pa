/**
 * OnboardingPipeline — orchestrates a sequence of Question instances.
 *
 * Per-turn lifecycle:
 *   1. Look up current Q from state.currentQId (or first Q if state empty)
 *   2. If state.halted → emit halt message, return
 *   3. Call currentQ.judge.judge(reply)
 *   4. If accept → fire onAccepted, store value, advance state.currentQId
 *      to next Q. If no next Q → fire postCollect hook + mark complete.
 *      Emit next Q's prompt (or completion msg).
 *   5. If reason=declined → fire onDeclined hook. May advance / halt /
 *      stay per hook return value. If no hook, treat as irrelevant.
 *   6. If reason=irrelevant or unclear → bump attempt counter. If
 *      attemptCount > Q.maxAttempts → halt. Else call rephraser.rephrase
 *      and emit re-ask.
 *
 * State shape: caller-managed. Pipeline reads + writes via stateProvider
 * so it works equally for Firestore-backed prod and in-memory tests.
 *
 * Adam directive 2026-05-05: abstract each question into a class — pipeline IS
 * the layer that makes Question[] composable. Adding a new Q at runtime
 * is a single .addQuestion() call (or pipeline construction with one
 * extra entry in the array).
 */
import type {
  AcceptedCtx,
  BilingualText,
  JudgeCtx,
  Lang,
  Question,
  RephraseArgs,
} from "./question.js"

export interface PipelineState {
  /** Id of currently active question. null/undefined means: not started. */
  currentQId: string | null
  /** Map of qId → captured answer (jsonable form). */
  collected: Record<string, unknown>
  /** Map of qId → attempt counter for re-asks. */
  attempts: Record<string, number>
  /**
   * Halted: pipeline reached maxAttempts on some Q. Halts are sticky —
   * future turns just re-emit the halt message. Cleared by reset.
   */
  halted: { qId: string; at: string } | null
  /** Preferred language (set by q_lang accept, used for all subsequent Qs). */
  lang: Lang
  /** True once postCollect ran successfully. Pipeline becomes a no-op. */
  completed: boolean
}

export function emptyPipelineState(): PipelineState {
  return {
    currentQId: null,
    collected: {},
    attempts: {},
    halted: null,
    lang: "en",
    completed: false,
  }
}

/**
 * Storage adapter — pipeline doesn't know whether state lives in Firestore,
 * memory, or somewhere else. Implement to plug into your runtime.
 */
export interface PipelineStateProvider {
  load(userId: string): Promise<PipelineState>
  save(userId: string, state: PipelineState): Promise<void>
  /**
   * Atomic attempt increment. Default impl in createPipeline reads + writes
   * via load/save, but that's NOT race-safe. Production storage SHOULD
   * implement a real Firestore transaction.
   */
  incrementAttempt?(userId: string, qId: string): Promise<number>
}

export interface PipelineOpts {
  questions: Question<unknown>[]
  state: PipelineStateProvider
  /** Default halt message used when a Q lacks its own. */
  haltMessageDefault: BilingualText
  /**
   * Hook fired once after the LAST question is accepted (i.e. all Qs
   * answered). Use for: enrich resume, trigger job match, send welcome msg.
   */
  postCollect?: (
    collected: Record<string, unknown>,
    ctx: AcceptedCtx
  ) => Promise<void>
  /**
   * Hook fired before each turn's outbound. Lets the runtime route the
   * actual send (sendMemoryReply / sendDirect / suppressed). Pipeline
   * itself never sends — it just decides WHAT to send.
   */
  emit: (text: string, meta: { qId: string | null; kind: TurnEmitKind }) => Promise<void>
  /** Optional logger (event, payload). */
  log?: (event: string, payload: Record<string, unknown>) => void
  /** Firestore handle for judges that need it (Code, Resume). */
  db?: unknown
  /**
   * v1.9 — optional override for the post-all-Qs completion text. Default
   * is the onboarding "running the match" copy. PII confirm flow overrides
   * with "Thanks — you're all set" copy.
   */
  completionMessage?: BilingualText
}

export type TurnEmitKind =
  | "first_prompt"     // current Q's initial prompt (advance from previous Q)
  | "reask"            // re-ask after irrelevant/unclear
  | "side_question_ack" // answer side question before an auto-enter side effect
  | "halt"             // halt message after maxAttempts hit
  | "decline_ack"      // acknowledgment after onDeclined ran
  | "completion"       // final post-all-Qs message

export interface RunTurnInput {
  userId: string
  turnId: string
  reply: string
  /**
   * Per-turn context passed to judges (rawPayload for resume, etc.).
   * Lang is taken from state.lang — pipeline manages it.
   */
  rawPayload?: unknown
}

export interface RunTurnResult {
  handled: boolean
  /** Emitted text (for logging / debugging). */
  emitted?: string
  /** Q id active AFTER this turn. */
  currentQId: string | null
  completed: boolean
  halted: boolean
}

export class OnboardingPipeline {
  constructor(private readonly opts: PipelineOpts) {}

  /** Add a Question to the end of the registry. */
  addQuestion(q: Question<unknown>): void {
    this.opts.questions.push(q)
  }

  /** Read-only access to the registered questions in order. */
  listQuestions(): Question<unknown>[] {
    return [...this.opts.questions]
  }

  private firstQ(): Question<unknown> | null {
    return this.opts.questions[0] ?? null
  }

  private findQ(id: string | null): Question<unknown> | null {
    if (!id) return this.firstQ()
    return this.opts.questions.find((q) => q.id === id) ?? null
  }

  private nextQ(currentId: string): Question<unknown> | null {
    const idx = this.opts.questions.findIndex((q) => q.id === currentId)
    if (idx < 0 || idx === this.opts.questions.length - 1) return null
    return this.opts.questions[idx + 1] ?? null
  }

  async startTurn(input: RunTurnInput): Promise<RunTurnResult> {
    const state = await this.opts.state.load(input.userId)

    if (state.completed) {
      return { handled: false, currentQId: state.currentQId, completed: true, halted: false }
    }

    if (state.halted) {
      const haltedQ = this.findQ(state.halted.qId)
      const msg = (haltedQ?.haltMessage ?? this.opts.haltMessageDefault)[state.lang]
      await this.opts.emit(msg, { qId: state.halted.qId, kind: "halt" })
      return {
        handled: true,
        emitted: msg,
        currentQId: state.halted.qId,
        completed: false,
        halted: true,
      }
    }

    // First-ever turn: emit the first Q's prompt and exit.
    if (!state.currentQId) {
      const first = this.firstQ()
      if (!first) {
        // No questions configured. Mark completed + run postCollect.
        return await this.completeAndEmit(input, state, "(no questions configured)")
      }
      state.currentQId = first.id
      await this.opts.state.save(input.userId, state)
      const msg = first.prompt[state.lang]
      await this.opts.emit(msg, { qId: first.id, kind: "first_prompt" })
      return {
        handled: true,
        emitted: msg,
        currentQId: first.id,
        completed: false,
        halted: false,
      }
    }

    const currentQ = this.findQ(state.currentQId)
    if (!currentQ) {
      // State references a Q that doesn't exist (config drift). Restart.
      state.currentQId = null
      await this.opts.state.save(input.userId, state)
      return { handled: false, currentQId: null, completed: false, halted: false }
    }

    return await this.judgeAndAdvance(input, state, currentQ)
  }

  private async judgeAndAdvance(
    input: RunTurnInput,
    state: PipelineState,
    currentQ: Question<unknown>
  ): Promise<RunTurnResult> {
    const judgeCtx: JudgeCtx = {
      userId: input.userId,
      turnId: input.turnId,
      rawPayload: input.rawPayload,
      db: this.opts.db,
      log: this.opts.log,
    }

    const result = await currentQ.judge.judge(input.reply, state.lang, judgeCtx)
    this.opts.log?.("pa.onboarding.pipeline.judge_result", {
      userId: input.userId,
      turnId: input.turnId,
      qId: currentQ.id,
      judgeKind: currentQ.judge.kind,
      accept: result.accept,
      reason: result.accept ? null : result.reason,
    })

    if (result.accept) {
      return await this.acceptAndAdvance(input, state, currentQ, result.value)
    }

    if (result.reason === "declined" && currentQ.onDeclined) {
      const acceptedCtx: AcceptedCtx = {
        userId: input.userId,
        turnId: input.turnId,
        lang: state.lang,
        db: this.opts.db,
        log: this.opts.log,
      }
      const decision = await currentQ.onDeclined(acceptedCtx)
      if (decision?.advance) {
        // Skip this Q without storing a value.
        return await this.advanceTo(input, state, currentQ.id, "decline_ack")
      }
      if (decision?.halt) {
        return await this.haltOn(input, state, currentQ)
      }
      // Fall through: treat as irrelevant.
    }

    // A candidate may ask a side question before answering the active prompt.
    // Answer it briefly, keep the same prompt active, and do not count it as a
    // failed attempt.
    const sideQuestionAck = sideQuestionAckFor({
      qId: currentQ.id,
      reply: input.reply,
      lang: state.lang,
    })
    if (sideQuestionAck) {
      const msg = `${sideQuestionAck}\n\n${currentQ.prompt[state.lang]}`
      await this.opts.emit(msg, { qId: currentQ.id, kind: "reask" })
      return {
        handled: true,
        emitted: msg,
        currentQId: currentQ.id,
        completed: false,
        halted: false,
      }
    }

    // irrelevant / unclear / declined-without-hook → bump attempt + rephrase.
    return await this.bumpAndRephrase(input, state, currentQ, result)
  }

  private async acceptAndAdvance(
    input: RunTurnInput,
    state: PipelineState,
    currentQ: Question<unknown>,
    value: unknown
  ): Promise<RunTurnResult> {
    state.collected[currentQ.id] = value
    state.attempts[currentQ.id] = 0
    if (currentQ.onAccepted) {
      const ctx: AcceptedCtx = {
        userId: input.userId,
        turnId: input.turnId,
        lang: state.lang,
        db: this.opts.db,
        log: this.opts.log,
      }
      try {
        await currentQ.onAccepted(value, ctx)
      } catch (err) {
        this.opts.log?.("pa.onboarding.pipeline.on_accepted_error", {
          userId: input.userId,
          qId: currentQ.id,
          error: err instanceof Error ? err.message : String(err),
        })
        // Don't block advancement on a side-effect failure — the answer
        // is captured in collected; the side-effect can be retried later.
      }
    }

    const acceptedAsideAck = sideQuestionAckFor({
      qId: currentQ.id,
      reply: input.reply,
      value,
      lang: state.lang,
    })
    return await this.advanceTo(input, state, currentQ.id, "first_prompt", acceptedAsideAck)
  }

  private async advanceTo(
    input: RunTurnInput,
    state: PipelineState,
    fromQId: string,
    kind: TurnEmitKind,
    acceptedAsideAck?: string | null
  ): Promise<RunTurnResult> {
    const next = this.nextQ(fromQId)
    if (!next) {
      if (this.findQ(fromQId)?.suppressTerminalCompletionMessage) {
        return await this.completeSilently(input, state)
      }
      // All done — fire postCollect. v1.9: allow caller override of the
      // completion message (PII confirm flow needs "Thanks — you're all
      // set" framing instead of "running the match" framing).
      const override = this.opts.completionMessage
      const completionMsg = override
        ? override[state.lang]
        : "got everything I need — running the match now ✓"
      return await this.completeAndEmit(input, state, completionMsg)
    }

    if (next.onEnter) {
      if (acceptedAsideAck) {
        await this.opts.emit(acceptedAsideAck, { qId: fromQId, kind: "side_question_ack" })
        acceptedAsideAck = null
      }
      const ctx: AcceptedCtx = {
        userId: input.userId,
        turnId: input.turnId,
        lang: state.lang,
        db: this.opts.db,
        log: this.opts.log,
      }
      try {
        const enterResult = await next.onEnter(ctx)
        if (enterResult?.accept) {
          this.opts.log?.("pa.onboarding.pipeline.on_enter_accept", {
            userId: input.userId,
            turnId: input.turnId,
            qId: next.id,
            confidence: enterResult.confidence ?? null,
          })
          return await this.acceptAndAdvance(input, state, next, enterResult.value)
        }
      } catch (err) {
        this.opts.log?.("pa.onboarding.pipeline.on_enter_error", {
          userId: input.userId,
          turnId: input.turnId,
          qId: next.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    state.currentQId = next.id
    await this.opts.state.save(input.userId, state)
    const nextPrompt = next.prompt[state.lang]
    const msg = acceptedAsideAck ? `${acceptedAsideAck}\n\n${nextPrompt}` : nextPrompt
    await this.opts.emit(msg, { qId: next.id, kind })
    return {
      handled: true,
      emitted: msg,
      currentQId: next.id,
      completed: false,
      halted: false,
    }
  }

  private async bumpAndRephrase(
    input: RunTurnInput,
    state: PipelineState,
    currentQ: Question<unknown>,
    result: Extract<Awaited<ReturnType<typeof currentQ.judge.judge>>, { accept: false }>
  ): Promise<RunTurnResult> {
    let attemptCount: number
    if (this.opts.state.incrementAttempt) {
      attemptCount = await this.opts.state.incrementAttempt(input.userId, currentQ.id)
      // Re-load to pick up the bumped value (race-safe path).
      const reloaded = await this.opts.state.load(input.userId)
      Object.assign(state, reloaded)
    } else {
      attemptCount = (state.attempts[currentQ.id] ?? 0) + 1
      state.attempts[currentQ.id] = attemptCount
      await this.opts.state.save(input.userId, state)
    }

    const maxAttempts = currentQ.maxAttempts ?? 5
    if (attemptCount >= maxAttempts) {
      return await this.haltOn(input, state, currentQ)
    }

    const rephraseArgs: RephraseArgs = {
      questionId: currentQ.id,
      originalPrompt: currentQ.prompt[state.lang],
      userReply: input.reply,
      attemptNum: attemptCount,
      lang: state.lang,
      llmClarifyingQuestion: result.clarifyingQuestion,
      typoSuggestion: result.suggestion,
    }
    const rephrased = await currentQ.rephraser.rephrase(rephraseArgs)
    await this.opts.emit(rephrased, { qId: currentQ.id, kind: "reask" })
    return {
      handled: true,
      emitted: rephrased,
      currentQId: currentQ.id,
      completed: false,
      halted: false,
    }
  }

  private async haltOn(
    input: RunTurnInput,
    state: PipelineState,
    currentQ: Question<unknown>
  ): Promise<RunTurnResult> {
    state.halted = { qId: currentQ.id, at: new Date().toISOString() }
    await this.opts.state.save(input.userId, state)
    const haltMsg = (currentQ.haltMessage ?? this.opts.haltMessageDefault)[state.lang]
    await this.opts.emit(haltMsg, { qId: currentQ.id, kind: "halt" })
    this.opts.log?.("pa.onboarding.pipeline.halted", {
      userId: input.userId,
      qId: currentQ.id,
      attempts: state.attempts[currentQ.id] ?? 0,
    })
    return {
      handled: true,
      emitted: haltMsg,
      currentQId: currentQ.id,
      completed: false,
      halted: true,
    }
  }

  private async completeAndEmit(
    input: RunTurnInput,
    state: PipelineState,
    completionMsg: string
  ): Promise<RunTurnResult> {
    return await this.complete(input, state, completionMsg)
  }

  private async completeSilently(
    input: RunTurnInput,
    state: PipelineState
  ): Promise<RunTurnResult> {
    return await this.complete(input, state)
  }

  private async complete(
    input: RunTurnInput,
    state: PipelineState,
    completionMsg?: string
  ): Promise<RunTurnResult> {
    state.completed = true
    state.currentQId = null
    await this.opts.state.save(input.userId, state)
    if (completionMsg) {
      await this.opts.emit(completionMsg, { qId: null, kind: "completion" })
    }
    if (this.opts.postCollect) {
      try {
        await this.opts.postCollect(state.collected, {
          userId: input.userId,
          turnId: input.turnId,
          lang: state.lang,
          db: this.opts.db,
          log: this.opts.log,
        })
      } catch (err) {
        this.opts.log?.("pa.onboarding.pipeline.post_collect_error", {
          userId: input.userId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return {
      handled: true,
      emitted: completionMsg,
      currentQId: null,
      completed: true,
      halted: false,
    }
  }
}

function sideQuestionAckFor(args: {
  qId: string
  reply: string
  value?: unknown
  lang: Lang
}): string | null {
  const lower = args.reply.toLowerCase()
  const hasQuestionOrAside =
    args.reply.includes("?") ||
    /\b(quick aside|btw|by the way|also|one question|quick question)\b/i.test(args.reply)
  if (!hasQuestionOrAside) return null

  if (
    args.qId === "q_yoe" &&
    /\b(new[-\s]?grad(?:-ish)?|entry[-\s]?level|early[-\s]?career)\b/i.test(args.reply)
  ) {
    const yoe =
      typeof args.value === "number" && Number.isFinite(args.value)
        ? `about ${args.value} year${args.value === 1 ? "" : "s"}`
        : "early-career"
    return `Yes — I’ll treat that as ${yoe} / early-career for your profile.`
  }

  if (
    args.qId === "q_startup_pref" &&
    /\b(ats|black holes?|huge[-\s]?company|big[-\s]?company|large[-\s]?company)\b/i.test(args.reply)
  ) {
    return "Yes - I’ll treat startups and smaller teams as the default, and only show bigger-company roles when the requirements and link look worth checking."
  }

  if (
    (args.qId === "q_country" || args.qId === "q_location") &&
    /\bremote\b/i.test(args.reply) &&
    /\b(us|u\.s\.|usa|united states|global|worldwide|international|unless i say global)\b/i.test(args.reply)
  ) {
    return "Yes - I’ll treat remote as US remote unless you explicitly say global or worldwide."
  }

  if (/\b(legit|real|scam|hiring manager|how does this work|how will this work|what happens next)\b/i.test(lower)) {
    return "Good question. WeKruit uses this chat to build your candidate profile; for partnered roles, the screen can go to the hiring team."
  }

  if (/\b(job match|job matching|matching|matches|recommend|recommendation|roles?|jobs?)\b/i.test(lower)) {
    return "Yes. Once I have your direction clear, any role I recommend will include the job link and core requirements."
  }

  if (/\b(privacy|delete|data|save|remember|stored)\b/i.test(lower)) {
    return "Good question. I use this for your WeKruit candidate profile and recruiting flow; you can ask to delete or export it."
  }

  return "Fair question. I’ll keep side questions tied to your search, then keep your profile moving."
}
