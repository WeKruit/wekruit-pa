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
        text: question.clarifyPrompt[input.lang],
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
    const terminal: Exclude<PreScreenTerminal, null> = final.action === "pass" ? "PASS" : "FAIL"
    const reason = `ratio=${final.ratio.toFixed(3)} threshold=${state.threshold.toFixed(2)}`
    return await this.transitionTerminal(state, terminal, reason, nowIso, lang, log)
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
      return lang === "zh"
        ? "感谢回答。这个岗位的某个硬性条件暂时对不齐，我们换个方向找。"
        : "Thanks for the reply. One required area didn't align for this role — let's look at other options."
    case "PAUSE":
      return lang === "zh"
        ? "感谢回答。目前看综合匹配度不够高，先停在这儿，下次有更合适的我直接推。"
        : "Thanks. Overall fit looks low for this role; pausing here. I'll surface better-aligned roles next time."
  }
}
