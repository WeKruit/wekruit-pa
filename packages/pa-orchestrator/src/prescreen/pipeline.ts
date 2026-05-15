/**
 * v1.8 Phase 76 — PreScreenPipeline.
 *
 * Orchestrates one turn of a pre-screening conversation. Assembles the pure
 * transitions from `transitions.ts` over the typed state from `state.ts`.
 *
 * Distinct from OnboardingPipeline because:
 *   - Reads ScoredJudgeResult (kind: "scored") from KeywordSetJudge instead
 *     of binary JudgeResult.
 *   - Runs the 4-gate state machine (Confidence → Type → Viability → Final).
 *   - Owns terminal-state transitions {PASS / FAIL / HARD_STOP / PAUSE}.
 *   - Tracks k≤2 clarification rounds distinct from re-ask attempts.
 *
 * Caller contract:
 *   1. On session start: pipeline.startSession(args) → emit first Q prompt
 *   2. On candidate reply: pipeline.runTurn({ reply, ... }) → emit reply
 *      text + state-transition action
 *   3. Pipeline never sends — caller routes the emit text through Sendblue.
 *
 * Memory compaction integration (Phase 74.5):
 *   - On terminal transition, caller invokes `runCompactionTurn` with the
 *     accumulated raw turns. Pipeline exposes a `getTurnsForCompaction`
 *     method that returns the turns since session start (or last compaction).
 *
 * Phase 80 runner (tests/scenarios/runner-prescreen.mjs) wires this pipeline
 * to YAML scenarios for E2E verification.
 */

import type { JudgeCtx, Lang, ScoredJudgeResult } from "../onboarding/question.js"
import type { KeywordSetJudge } from "../onboarding/judges/keyword-set.js"
import type {
  PreScreenState,
  PreScreenStateProvider,
  PreScreenTerminal,
} from "./state.js"
import {
  evalConfidenceGate,
  evalFinal,
  evalTypeGate,
  evalViability,
  mergeScored,
  questionsAnswered,
  remainingMaxScore,
  setTerminal,
} from "./transitions.js"

// ────────────────────────────────────────────────────────────────────────────
// Question binding
// ────────────────────────────────────────────────────────────────────────────

/**
 * A pre-screen question binding. Pre-screening Qs use only KeywordSetJudge
 * (the binary-judge path is for migration scenarios). Each binding ties the
 * Q's metadata (type, weight from PreScreenState) to its judge + prompt
 * texts.
 */
export interface PreScreenQuestion {
  qId: string
  /** Initial prompt the candidate sees. */
  prompt: { zh: string; en: string }
  /** Clarification prompt when confidence gate triggers re-ask. */
  clarifyPrompt: { zh: string; en: string }
  /** The KeywordSet judge instance — wired with config-loaded keywords. */
  judge: KeywordSetJudge
}

// ────────────────────────────────────────────────────────────────────────────
// Turn input / output
// ────────────────────────────────────────────────────────────────────────────

export interface RunTurnInput {
  sessionId: string
  reply: string
  lang: Lang
  /** ISO timestamp for this turn. */
  nowIso: string
  /** JudgeCtx forwarded to the KeywordSetJudge. */
  judgeCtx: JudgeCtx
}

/**
 * Result of one turn. `text` is the message to emit to the candidate.
 * `action` captures the state-machine decision for logging + observability.
 */
export interface RunTurnResult {
  text: string
  action:
    | { kind: "clarify"; qId: string; kAfter: number }
    | { kind: "advance"; fromQId: string; toQId: string }
    | { kind: "terminal"; terminal: Exclude<PreScreenTerminal, null>; reason: string }
    | { kind: "error"; reason: string }
  state: PreScreenState
}

export interface ComposeClarifyInput {
  question: PreScreenQuestion
  lang: Lang
  reply: string
  scored: ScoredJudgeResult
  merged: ScoredJudgeResult
  clarifyRound: number
  reason: "confidence" | "type_gate"
  state: PreScreenState
  fallbackText: string
}

export type PreScreenClarifyComposer = (input: ComposeClarifyInput) => Promise<string>

const MIN_SOFT_ACCEPT_CLARIFY_ROUNDS = 2
const MIN_SOFT_ACCEPT_SCORE = 0.75

// ────────────────────────────────────────────────────────────────────────────
// Pipeline class
// ────────────────────────────────────────────────────────────────────────────

export interface PreScreenPipelineOpts {
  /** Map of qId → PreScreenQuestion binding. */
  questions: Record<string, PreScreenQuestion>
  /** State persistence adapter (Firestore in prod, in-memory in tests). */
  store: PreScreenStateProvider
  /** Optional logger. */
  log?: (event: string, payload: Record<string, unknown>) => void
  /** Optional production composer for adaptive, non-repeated follow-up probes. */
  composeClarify?: PreScreenClarifyComposer
}

export class PreScreenPipeline {
  constructor(private readonly opts: PreScreenPipelineOpts) {}

  /**
   * Public turn entry. Loads state, evaluates the reply against the active
   * Q, runs all 4 gates, persists, returns the emit text + action.
   */
  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    const log = this.opts.log ?? (() => {})
    const state = await this.opts.store.load(input.sessionId)
    if (!state) {
      return {
        text: "",
        action: { kind: "error", reason: "session_not_found" },
        // Synthesize an empty terminal-FAIL state so callers always get one.
        state: this.synthesizeFailState(input),
      }
    }

    // If already terminal, emit the terminal message and short-circuit.
    if (state.terminal !== null) {
      return {
        text: terminalText(state.terminal, state.terminalReason ?? "", input.lang),
        action: { kind: "terminal", terminal: state.terminal, reason: state.terminalReason ?? "" },
        state,
      }
    }

    if (!state.currentQId) {
      // No active Q but not terminal — fall through to Final Decision.
      return await this.transitionFinal(state, input.nowIso, input.lang, log)
    }

    const question = this.opts.questions[state.currentQId]
    if (!question) {
      log("prescreen.pipeline.unknown_q", { qId: state.currentQId })
      return await this.transitionTerminal(
        state,
        "HARD_STOP",
        `unknown question ${state.currentQId}`,
        input.nowIso,
        input.lang,
        log
      )
    }

    // ── Evaluate via KeywordSetJudge ─────────────────────────────────────────
    const scored = await question.judge.judgeScored(input.reply, input.lang, input.judgeCtx)
    const qState = state.questions[state.currentQId]
    const merged = mergeScored(qState.scored, scored)
    qState.scored = merged
    const s = merged.aggregate.s
    const c = merged.aggregate.c

    log("prescreen.pipeline.evaluated", {
      sessionId: input.sessionId,
      qId: state.currentQId,
      s,
      c,
      clarifyRoundsSoFar: qState.clarifyRounds,
      abortHint: scored.abortHint?.kind,
    })

    // ── Confidence Gate ──────────────────────────────────────────────────────
    const confGate = evalConfidenceGate({
      c,
      threshold: state.confidenceThreshold,
      clarifyRoundsSoFar: qState.clarifyRounds,
      maxClarifyRounds: state.maxClarifyRounds,
    })

    if (confGate.action === "clarify") {
      qState.clarifyRounds = confGate.kAfter
      state.updatedAt = input.nowIso
      await this.opts.store.save(state)
      return {
        text: await this.composeClarify({
          question,
          lang: input.lang,
          reply: input.reply,
          scored,
          merged,
          clarifyRound: confGate.kAfter,
          reason: "confidence",
          state,
          log,
        }),
        action: { kind: "clarify", qId: state.currentQId, kAfter: confGate.kAfter },
        state,
      }
    }

    // max_clarify_exhausted OR proceed → continue to Type Gate

    // ── Type Gate ────────────────────────────────────────────────────────────
    const typeGate = evalTypeGate({
      type: qState.type,
      s,
      c,
      confidenceThreshold: state.confidenceThreshold,
      // v1.9 — per-Q τ_m override (default falls back to type baseline).
      ...(qState.matchThreshold !== undefined ? { matchThreshold: qState.matchThreshold } : {}),
    })
    if (typeGate.action === "hard_stop") {
      if (shouldSoftAcceptAfterProbing({
        type: qState.type,
        s,
        c,
        state,
        clarifyRoundsSoFar: qState.clarifyRounds,
      })) {
        log("prescreen.pipeline.type_gate_soft_accept_after_probe", {
          sessionId: input.sessionId,
          qId: state.currentQId,
          type: qState.type,
          s,
          c,
          clarifyRounds: qState.clarifyRounds,
          threshold: state.threshold,
        })
      } else if (qState.clarifyRounds < state.maxClarifyRounds) {
        qState.clarifyRounds += 1
        state.updatedAt = input.nowIso
        await this.opts.store.save(state)
        log("prescreen.pipeline.type_gate_clarify", {
          sessionId: input.sessionId,
          qId: state.currentQId,
          type: qState.type,
          s,
          c,
          clarifyRounds: qState.clarifyRounds,
        })
        return {
          text: await this.composeClarify({
            question,
            lang: input.lang,
            reply: input.reply,
            scored,
            merged,
            clarifyRound: qState.clarifyRounds,
            reason: "type_gate",
            state,
            log,
          }),
          action: { kind: "clarify", qId: state.currentQId, kAfter: qState.clarifyRounds },
          state,
        }
      } else {
        qState.finalS = s
        qState.finalC = c
        qState.answeredAt = input.nowIso
        qState.terminalCause = "type_gate_fail"
        return await this.transitionTerminal(
          state,
          "HARD_STOP",
          `${qState.type} failed at qId=${qState.qId} s=${s.toFixed(2)} c=${c.toFixed(2)}`,
          input.nowIso,
          input.lang,
          log
        )
      }
    }

    // ── Update score ─────────────────────────────────────────────────────────
    qState.finalS = s
    qState.finalC = c
    qState.answeredAt = input.nowIso
    state.score += s * qState.weight

    // ── Viability Check ──────────────────────────────────────────────────────
    // Skip viability on the LAST Q — once R_max=0, "S < T·S_max" is just the
    // FAIL condition, not PAUSE. PAUSE communicates "math says PASS unreachable
    // BEFORE finishing"; on the last Q we have finished, so route to Final.
    const remaining = remainingMaxScore(state)
    if (remaining > 0) {
      const viability = evalViability({
        score: state.score,
        scoreMax: state.scoreMax,
        remainingMaxScore: remaining,
        threshold: state.threshold,
        questionsAnswered: questionsAnswered(state),
        totalQuestions: state.qOrder.length,
      })
      if (viability.action === "pause") {
        qState.terminalCause = "viability_fail"
        return await this.transitionTerminal(
          state,
          "PAUSE",
          viability.reason,
          input.nowIso,
          input.lang,
          log
        )
      }
    }

    // ── Advance to next Q OR Final Decision ─────────────────────────────────
    const nextIdx = state.qOrder.indexOf(state.currentQId) + 1
    if (nextIdx < state.qOrder.length) {
      const nextQId = state.qOrder[nextIdx]
      const fromQId = state.currentQId
      state.currentQId = nextQId
      state.updatedAt = input.nowIso
      await this.opts.store.save(state)
      return {
        text: this.opts.questions[nextQId].prompt[input.lang],
        action: { kind: "advance", fromQId, toQId: nextQId },
        state,
      }
    }

    return await this.transitionFinal(state, input.nowIso, input.lang, log)
  }

  /**
   * Final Decision transition — used when queue empties or no currentQId.
   */
  private async transitionFinal(
    state: PreScreenState,
    nowIso: string,
    lang: Lang,
    log: (event: string, payload: Record<string, unknown>) => void
  ): Promise<RunTurnResult> {
    const final = evalFinal({
      score: state.score,
      scoreMax: state.scoreMax,
      threshold: state.threshold,
    })
    if (final.action === "fail") {
      const probe = await this.tryFinalFailProbe(state, nowIso, lang, log)
      if (probe) return probe
    }
    const terminal: Exclude<PreScreenTerminal, null> = final.action === "pass" ? "PASS" : "FAIL"
    const reason = `ratio=${final.ratio.toFixed(3)} threshold=${state.threshold.toFixed(2)}`
    return await this.transitionTerminal(state, terminal, reason, nowIso, lang, log)
  }

  /**
   * A low final ratio means "not enough fit evidence", not "instantly reject".
   * Before FAIL, reuse the active/last question's clarify budget so Claire
   * probes for a sharper closest-overlap example. We roll back that question's
   * score contribution so the next reply re-scores it once with merged evidence.
   */
  private async tryFinalFailProbe(
    state: PreScreenState,
    nowIso: string,
    lang: Lang,
    log: (event: string, payload: Record<string, unknown>) => void
  ): Promise<RunTurnResult | null> {
    const qId = state.currentQId ?? state.qOrder[state.qOrder.length - 1]
    if (!qId) return null
    const qState = state.questions[qId]
    const question = this.opts.questions[qId]
    if (!qState || !question || !qState.scored) return null
    if (qState.clarifyRounds >= state.maxClarifyRounds) return null

    if (typeof qState.finalS === "number") {
      state.score = Math.max(0, state.score - qState.finalS * qState.weight)
    }
    delete qState.finalS
    delete qState.finalC
    delete qState.answeredAt
    delete qState.terminalCause

    qState.clarifyRounds += 1
    state.currentQId = qId
    state.updatedAt = nowIso
    await this.opts.store.save(state)

    log("prescreen.pipeline.final_fail_probe", {
      sessionId: state.sessionId,
      qId,
      clarifyRounds: qState.clarifyRounds,
      score: state.score,
      scoreMax: state.scoreMax,
      threshold: state.threshold,
    })

    return {
      text: await this.composeClarify({
        question,
        lang,
        reply: "",
        scored: qState.scored,
        merged: qState.scored,
        clarifyRound: qState.clarifyRounds,
        reason: "type_gate",
        state,
        log,
      }),
      action: { kind: "clarify", qId, kAfter: qState.clarifyRounds },
      state,
    }
  }

  /**
   * Common terminal-write path. Persists state, emits terminal text.
   */
  private async transitionTerminal(
    state: PreScreenState,
    terminal: Exclude<PreScreenTerminal, null>,
    reason: string,
    nowIso: string,
    lang: Lang,
    log: (event: string, payload: Record<string, unknown>) => void
  ): Promise<RunTurnResult> {
    const next = setTerminal(state, terminal, reason, nowIso)
    // Preserve mutations to per-Q state that happened on this turn.
    next.questions = state.questions
    next.score = state.score
    if (next.workSession) {
      next.workSession = { ...next.workSession, status: "ended", endedAt: nowIso, boundary: "terminal" }
    }
    await this.opts.store.save(next)
    log("prescreen.pipeline.terminal", {
      sessionId: state.sessionId,
      terminal,
      reason,
      score: state.score,
      scoreMax: state.scoreMax,
    })
    return {
      text: terminalText(terminal, reason, lang),
      action: { kind: "terminal", terminal, reason },
      state: next,
    }
  }

  private synthesizeFailState(input: RunTurnInput): PreScreenState {
    return {
      sessionId: input.sessionId,
      userId: "",
      jobId: "",
      currentQId: null,
      questions: {},
      qOrder: [],
      score: 0,
      scoreMax: 0,
      threshold: 0.65,
      confidenceThreshold: 0.7,
      maxClarifyRounds: 2,
      terminal: "FAIL",
      terminalReason: "session_not_found",
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    }
  }

  private async composeClarify(args: {
    question: PreScreenQuestion
    lang: Lang
    reply: string
    scored: ScoredJudgeResult
    merged: ScoredJudgeResult
    clarifyRound: number
    reason: "confidence" | "type_gate"
    state: PreScreenState
    log: (event: string, payload: Record<string, unknown>) => void
  }): Promise<string> {
    const fallbackText = clarifyText(args.question, args.lang, {
      scored: args.scored,
      merged: args.merged,
      clarifyRound: args.clarifyRound,
      reason: args.reason,
    })

    if (!this.opts.composeClarify) return fallbackText

    try {
      const text = (await this.opts.composeClarify({ ...args, fallbackText })).trim()
      if (text) return clampClarifyText(text)
    } catch (err) {
      args.log("prescreen.pipeline.compose_clarify_failed", {
        sessionId: args.state.sessionId,
        qId: args.question.qId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    return fallbackText
  }
}

function shouldSoftAcceptAfterProbing(args: {
  type: string
  s: number
  c: number
  state: PreScreenState
  clarifyRoundsSoFar: number
}): boolean {
  if (args.type !== "MUST_HAVE") return false
  if (args.clarifyRoundsSoFar < MIN_SOFT_ACCEPT_CLARIFY_ROUNDS) return false
  if (args.c < args.state.confidenceThreshold) return false
  return args.s >= Math.max(args.state.threshold, MIN_SOFT_ACCEPT_SCORE)
}

// ────────────────────────────────────────────────────────────────────────────
// Terminal-text composition
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compose the message sent to the candidate on terminal transition. Per
 * PS15 (Firestore rules + explanation server-write-only) we DO NOT include
 * raw reason text — the candidate sees a generic, polite acknowledgment.
 * The detailed reason is captured on PreScreenState.terminalReason and
 * surfaced ONLY in the dashboard session detail page (Phase 79).
 */
export function terminalText(
  terminal: Exclude<PreScreenTerminal, null>,
  _reasonForDashboard: string,
  lang: Lang
): string {
  switch (terminal) {
    case "PASS":
      return lang === "zh"
        ? "感谢回答，岗位匹配信息已经收齐。接下来我会发送下一步。"
        : "Thanks for your answers — I have enough for the role-fit screen. Sending the next step now."
    case "FAIL":
      return lang === "zh"
        ? "感谢花时间。本次初筛暂未匹配，我们会留意更合适的机会推给你。"
        : "Thanks for your time. This role isn't a match right now, but I'll keep an eye out for better fits."
    case "HARD_STOP":
      return terminalHardStopText(lang)
    case "PAUSE":
      return terminalPauseText(lang)
  }
}

function clarifyText(
  question: PreScreenQuestion,
  lang: Lang,
  ctx?: {
    scored: ScoredJudgeResult
    merged: ScoredJudgeResult
    clarifyRound: number
    reason: "confidence" | "type_gate"
  }
): string {
  if (ctx && ctx.clarifyRound > 1) {
    return followUpClarifyText(question, lang, ctx)
  }
  const authored = question.clarifyPrompt[lang]?.trim()
  if (authored && !isPlaceholderClarify(authored)) return authored
  return probingClarifyText(lang)
}

function isPlaceholderClarify(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim()
  return normalized === "please add one concrete example tied to this job."
}

function probingClarifyText(lang: Lang): string {
  return lang === "zh"
    ? "没关系，不一定要完全同名经验。我想先理解你最接近的经历：你做过哪个相关项目、你具体负责什么、最后有什么结果？粗略讲也可以。"
    : "No worries if it was not exactly that. I am trying to understand the closest overlap. Can you share the nearest project you owned: the context, what you personally did, and what changed because of it? A rough example is fine."
}

function followUpClarifyText(
  question: PreScreenQuestion,
  lang: Lang,
  ctx: {
    scored: ScoredJudgeResult
    merged: ScoredJudgeResult
    clarifyRound: number
    reason: "confidence" | "type_gate"
  }
): string {
  const weak = weakestKeywords(ctx.merged).slice(0, 2)
  if (lang === "zh") {
    if (weak.length > 0) {
      return clampClarifyText(
        `这段有帮助。还差一点是 ${weak.join("、")}。你能补一个最接近的例子吗：你亲自做了什么、涉及哪些系统或流程、最后带来什么变化？`
      )
    }
    return "这段有帮助。我再确认一个具体点：这个项目里最难、最能代表你能力的部分是什么？你具体做了什么，结果怎样？"
  }

  if (weak.length > 0) {
    return clampClarifyText(
      `That helps. The remaining gap is ${weak.join(" + ")}. Can you give the closest example: what you personally built or owned, what systems it touched, and what changed after it shipped?`
    )
  }

  const q = question.prompt.en.toLowerCase()
  if (q.includes("skill") || q.includes("technical")) {
    return "That helps. To score the technical part fairly, what was the hardest implementation detail you personally handled, and how did you know it worked?"
  }
  return "That helps. I need one sharper detail before scoring this: what was the closest project you personally owned, what did you do, and what changed after it shipped?"
}

function weakestKeywords(scored: ScoredJudgeResult): string[] {
  return [...scored.perKeyword]
    .filter((cell) => Number.isFinite(cell.match) && cell.match < 0.75)
    .sort((a, b) => a.match - b.match)
    .map((cell) => sanitizeKeyword(cell.keyword))
    .filter((keyword, idx, arr) => keyword.length > 0 && arr.indexOf(keyword) === idx)
}

function sanitizeKeyword(keyword: string): string {
  return keyword
    .replace(/[^\p{L}\p{N}\s/+#.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 44)
}

function clampClarifyText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= 320) return normalized
  return `${normalized.slice(0, 317).trimEnd()}...`
}

function terminalHardStopText(lang: Lang): string {
  return lang === "zh"
    ? "谢谢，这些信息有帮助。我不想硬把你往这个岗位上套；这个 screen 先停在这里，我会用你刚补充的经历继续匹配更合适的机会。"
    : "Thanks, that helps. I do not want to force-fit you into this exact role, so I will pause this screen here and use what you shared to look for better-aligned roles."
}

function terminalPauseText(lang: Lang): string {
  return lang === "zh"
    ? "谢谢，这些信息有帮助。目前这个岗位的综合匹配度不够高，我先暂停这次 screen，并继续用你补充的经历找更合适的机会。"
    : "Thanks, that helps. Overall fit for this role still looks low, so I will pause this screen and keep using what you shared for better-aligned roles."
}
