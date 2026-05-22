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
const ROLE_FIT_MAX_PROBE_SOFT_ACCEPT_SCORE = 0.6
const MIN_NEAR_CONFIDENCE_PROCEED = 0.6

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

    await this.consumeEarlyHardFilterAnswers({
      state,
      reply: input.reply,
      lang: input.lang,
      judgeCtx: input.judgeCtx,
      nowIso: input.nowIso,
      log,
    })

    const qState = state.questions[state.currentQId]
    const priorEvidenceReplies = normalizeEvidenceReplies(qState.evidenceReplies)
    const scoringReply = composeQuestionEvidenceReply(priorEvidenceReplies, input.reply)

    // ── Evaluate via KeywordSetJudge ─────────────────────────────────────────
    const rawScored = await question.judge.judgeScored(scoringReply, input.lang, input.judgeCtx)
    const scored = applyHardFilterScoreOverride(state.currentQId, scoringReply, rawScored)
    const confirmedHardFilterMismatch =
      isHardFilterQId(state.currentQId) &&
      hasHardFilterMismatch(state.currentQId, scoringReply, scored) &&
      qState.clarifyRounds > 0 &&
      scored.aggregate.c >= state.confidenceThreshold
    const merged = mergeScored(qState.scored, scored)
    qState.scored = merged
    qState.evidenceReplies = appendEvidenceReply(priorEvidenceReplies, input.reply)
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

    const confidenceSoftProceed = confGate.action === "clarify" && shouldProceedDespiteLowConfidence({
      qId: qState.qId,
      type: qState.type,
      s,
      c,
      confidenceThreshold: state.confidenceThreshold,
      matchThreshold: qState.matchThreshold,
    })

    if (confGate.action === "clarify" && !confidenceSoftProceed) {
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
    if (confidenceSoftProceed) {
      log("prescreen.pipeline.confidence_soft_proceed", {
        sessionId: input.sessionId,
        qId: state.currentQId,
        type: qState.type,
        s,
        c,
        confidenceThreshold: state.confidenceThreshold,
      })
    }

    // max_clarify_exhausted OR proceed → continue to Type Gate

    // ── Type Gate ────────────────────────────────────────────────────────────
    const typeGate = evalTypeGate({
      type: qState.type,
      s,
      c,
      confidenceThreshold: confidenceSoftProceed ? c : state.confidenceThreshold,
      // v1.9 — per-Q τ_m override (default falls back to type baseline).
      ...(qState.matchThreshold !== undefined ? { matchThreshold: qState.matchThreshold } : {}),
    })
    if (typeGate.action === "hard_stop") {
      if (shouldSoftAcceptAfterProbing({
        qId: qState.qId,
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
      } else if (confirmedHardFilterMismatch) {
        qState.finalS = s
        qState.finalC = c
        qState.answeredAt = input.nowIso
        qState.terminalCause = "type_gate_fail"
        return await this.transitionTerminal(
          state,
          "HARD_STOP",
          `hard_filter_mismatch at qId=${qState.qId} s=${s.toFixed(2)} c=${c.toFixed(2)}: ${hardFilterMismatchReason(qState.qId)}`,
          input.nowIso,
          input.lang,
          log
        )
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
    await this.consumeEarlyHardFilterAnswers({
      state,
      reply: input.reply,
      lang: input.lang,
      judgeCtx: input.judgeCtx,
      nowIso: input.nowIso,
      log,
    })

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
    const nextQId = findNextUnansweredQId(state, state.currentQId)
    if (nextQId) {
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

  private async consumeEarlyHardFilterAnswers(args: {
    state: PreScreenState
    reply: string
    lang: Lang
    judgeCtx: JudgeCtx
    nowIso: string
    log: (event: string, payload: Record<string, unknown>) => void
  }): Promise<number> {
    const currentIdx = args.state.currentQId ? args.state.qOrder.indexOf(args.state.currentQId) : -1
    if (currentIdx < 0) return 0

    let consumed = 0
    for (let idx = currentIdx + 1; idx < args.state.qOrder.length; idx += 1) {
      const qId = args.state.qOrder[idx]
      if (!isHardFilterQId(qId)) continue
      const qState = args.state.questions[qId]
      const question = this.opts.questions[qId]
      if (!qState || !question || qState.answeredAt) continue

      const signal = extractPositiveHardFilterSignal(qId, args.reply)
      if (!signal) continue

      const priorEvidenceReplies = normalizeEvidenceReplies(qState.evidenceReplies)
      const scoringReply = composeQuestionEvidenceReply(priorEvidenceReplies, signal)
      const rawScored = await question.judge.judgeScored(scoringReply, args.lang, args.judgeCtx)
      const scored = applyHardFilterScoreOverride(qId, scoringReply, rawScored)
      const merged = mergeScored(qState.scored, scored)
      const s = merged.aggregate.s
      const c = merged.aggregate.c
      const matchThreshold = qState.matchThreshold ?? defaultMatchThresholdForType(qState.type)
      if (s < matchThreshold || c < args.state.confidenceThreshold) {
        args.log("prescreen.pipeline.early_hard_filter_signal_unconfirmed", {
          sessionId: args.state.sessionId,
          qId,
          s,
          c,
          matchThreshold,
        })
        continue
      }

      qState.scored = merged
      qState.evidenceReplies = appendEvidenceReply(priorEvidenceReplies, signal)
      qState.finalS = s
      qState.finalC = c
      qState.answeredAt = args.nowIso
      args.state.score += s * qState.weight
      args.log("prescreen.pipeline.early_hard_filter_answer_consumed", {
        sessionId: args.state.sessionId,
        qId,
        s,
        c,
      })
      consumed += 1
    }
    return consumed
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

const MAX_EVIDENCE_REPLIES = 8
const MAX_EVIDENCE_REPLY_CHARS = 900
const MAX_EVIDENCE_TOTAL_CHARS = 4200

function normalizeEvidenceReplies(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(-MAX_EVIDENCE_REPLIES)
}

function appendEvidenceReply(priorReplies: string[], reply: string): string[] {
  const trimmed = reply.trim()
  if (!trimmed) return priorReplies
  const clipped = trimmed.slice(0, MAX_EVIDENCE_REPLY_CHARS)
  return [...priorReplies, clipped].slice(-MAX_EVIDENCE_REPLIES)
}

function composeQuestionEvidenceReply(priorReplies: string[], latestReply: string): string {
  const replies = appendEvidenceReply(priorReplies, latestReply)
  if (replies.length <= 1) return replies[0] ?? latestReply
  const chunks: string[] = []
  let total = 0
  for (const [idx, reply] of replies.entries()) {
    const chunk = `Answer ${idx + 1}: ${reply}`
    total += chunk.length
    if (total > MAX_EVIDENCE_TOTAL_CHARS) break
    chunks.push(chunk)
  }
  return chunks.join("\n")
}

function findNextUnansweredQId(state: PreScreenState, currentQId: string | null): string | null {
  const currentIdx = currentQId ? state.qOrder.indexOf(currentQId) : -1
  const startIdx = currentIdx >= 0 ? currentIdx + 1 : 0
  for (let idx = startIdx; idx < state.qOrder.length; idx += 1) {
    const qId = state.qOrder[idx]
    if (!state.questions[qId]?.answeredAt) return qId
  }
  return null
}

function extractPositiveHardFilterSignal(qId: string, reply: string): string | null {
  const text = reply.trim()
  if (!text) return null
  const sentences = splitSignalSentences(text)
  const matcher = positiveHardFilterMatcher(qId)
  if (!matcher) return null
  const picked = sentences.filter((sentence) => matcher(sentence.toLowerCase()))
  if (picked.length === 0) return null
  return picked.join(" ").slice(0, MAX_EVIDENCE_REPLY_CHARS)
}

function splitSignalSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return []
  const parts = normalized
    .split(/(?<=[.!?。！？])\s+|[\n\r]+/g)
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length > 0 ? parts : [normalized]
}

function positiveHardFilterMatcher(qId: string): ((text: string) => boolean) | null {
  if (qId === "location_alignment") {
    return (text) =>
      /\b(new york|nyc|listed location|location|hybrid|onsite|in office|remote setup|remote-flexible)\b/.test(text) &&
      /\b(works?|workable|fine|aligned|ok|okay|yes|can|able|willing|open to|available)\b/.test(text) &&
      !/\b(can'?t|cannot|unable|not able|won't|would not|only remote|remote only|different city|not workable|not aligned)\b/.test(text)
  }
  if (qId === "compensation_alignment") {
    return (text) =>
      /(?:\$?\d{2,3}\s?k|\bcomp(?:ensation)?\b|\bsalary\b|\brange\b)/.test(text) &&
      /\b(works?|workable|fine|aligned|ok|okay|yes|within|open to)\b/.test(text) &&
      !/\b(too low|below|need higher|would need more|not workable|not aligned)\b/.test(text)
  }
  if (qId === "sponsorship_status") {
    return (text) =>
      (
        /\b(do not|don't|dont|no)\b[\s\S]{0,60}\b(need|require)\b[\s\S]{0,80}\b(visa sponsorship|sponsorship|sponsor)\b/.test(text) ||
        /\b(visa sponsorship|sponsorship|sponsor)\b[\s\S]{0,80}\b(not needed|not required|unneeded)\b/.test(text) ||
        /\b(us citizen|u\.s\. citizen|green card|permanent resident|work authorized|authorized to work)\b/.test(text)
      )
  }
  return null
}

function applyHardFilterScoreOverride(
  qId: string,
  scoringReply: string,
  scored: ScoredJudgeResult
): ScoredJudgeResult {
  if (!isHardFilterQId(qId)) return scored
  if (!hasHardFilterMismatch(qId, scoringReply, scored)) return scored

  const summary = hardFilterMismatchReason(qId)
  return {
    ...scored,
    perKeyword: scored.perKeyword.map((cell) => ({
      ...cell,
      match: Math.min(cell.match, 0.25),
      confidence: Math.max(cell.confidence, 0.85),
      reasoning: clampScoredReasoning(summary),
    })),
    aggregate: {
      s: Math.min(scored.aggregate.s, 0.25),
      c: Math.max(scored.aggregate.c, 0.85),
      summary,
    },
    abortHint: {
      kind: "low_confidence",
      reason: summary,
    },
  }
}

function isHardFilterQId(qId: string): boolean {
  return qId === "location_alignment" || qId === "compensation_alignment" || qId === "sponsorship_status"
}

function hasHardFilterMismatch(qId: string, scoringReply: string, scored: ScoredJudgeResult): boolean {
  const text = `${scoringReply}\n${scored.aggregate.summary}\n${scored.abortHint?.reason ?? ""}`.toLowerCase()
  if (qId === "location_alignment") {
    return (
      /\b(can'?t|cannot|not able|unable|won't|would not)\b[\s\S]{0,160}\b(relocat|move|be in|work in|commute|onsite|weekly|new york|nyc|listed location)\b/.test(text) ||
      /\b(remote only|only remote|different city)\b/.test(text) ||
      /\b(declines?|mismatch|not .*alignment|not .*listed location)\b/.test(text)
    )
  }

  if (qId === "compensation_alignment") {
    return /\b(not aligned|too low|below my range|need higher|would need more|not workable)\b/.test(text)
  }

  if (qId === "sponsorship_status") {
    return /\b(company does not sponsor|sponsorship not available|requires? sponsorship but role does not|need sponsorship but role)\b/.test(text)
  }

  return false
}

function hardFilterMismatchReason(qId: string): string {
  if (qId === "location_alignment") {
    return "Candidate needs a different location or remote setup than this role requires."
  }
  if (qId === "compensation_alignment") {
    return "Candidate compensation target is not aligned with this role's range."
  }
  return "Candidate sponsorship need is not aligned with this role's requirement."
}

function clampScoredReasoning(text: string): string {
  return text.length <= 80 ? text : text.slice(0, 79).trimEnd()
}

function shouldSoftAcceptAfterProbing(args: {
  qId: string
  type: string
  s: number
  c: number
  state: PreScreenState
  clarifyRoundsSoFar: number
}): boolean {
  if (args.type !== "MUST_HAVE") return false
  if (isHardFilterQId(args.qId)) return false
  if (args.clarifyRoundsSoFar < MIN_SOFT_ACCEPT_CLARIFY_ROUNDS) return false
  if (args.c < args.state.confidenceThreshold) return false
  if (
    args.qId === "role_fit" &&
    args.clarifyRoundsSoFar >= args.state.maxClarifyRounds &&
    args.s >= ROLE_FIT_MAX_PROBE_SOFT_ACCEPT_SCORE
  ) {
    return true
  }
  return args.s >= Math.max(args.state.threshold, MIN_SOFT_ACCEPT_SCORE)
}

function defaultMatchThresholdForType(type: string): number {
  if (type === "MUST_HAVE") return 1.0
  if (type === "PROBING") return 0.7
  return 0
}

function shouldProceedDespiteLowConfidence(args: {
  qId: string
  type: string
  s: number
  c: number
  confidenceThreshold: number
  matchThreshold?: number
}): boolean {
  if (isHardFilterQId(args.qId)) return false
  if (args.type !== "MUST_HAVE" && args.type !== "PROBING") return false
  if (args.c < MIN_NEAR_CONFIDENCE_PROCEED) return false
  if (args.c >= args.confidenceThreshold) return false
  const matchThreshold = args.matchThreshold ?? defaultMatchThresholdForType(args.type)
  return args.s >= matchThreshold
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
        ? "感谢回答，这次岗位初筛已经完成。下一步，如果有匹配，我会直接帮你安排和 hiring manager 沟通。同时我也可以继续帮你找符合期待的机会，但需要先多了解你一点。你想继续吗？"
        : "Thanks for your answers — the role-fit screen is complete. For the next step, I'll schedule you directly with the hiring manager once there's a match. Meanwhile, I can help find jobs that meet your expectations, but I need to understand you a bit better first. Do you want to proceed?"
    case "FAIL":
      return lang === "zh"
        ? "感谢花时间。这次可能不是最合适的岗位，但我可以继续帮你找更符合期待的机会，不过需要先更了解你一点。要继续吗？"
        : "Thanks for taking the time. This one may not be the right fit, but I can help find jobs that meet your expectations. I need to understand you a bit better first. Do you want to proceed?"
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
  const hardFilterText = hardFilterClarifyText(question.qId, lang)
  if (hardFilterText) return hardFilterText

  if (ctx && ctx.clarifyRound > 1) {
    return followUpClarifyText(question, lang, ctx)
  }
  const authored = question.clarifyPrompt[lang]?.trim()
  if (authored && !isPlaceholderClarify(authored)) return authored
  return probingClarifyText(lang)
}

export function hardFilterClarifyText(qId: string, lang: Lang): string | null {
  if (qId === "location_alignment") {
    return lang === "zh"
      ? "我先确认这个硬条件：这份工作的地点/远程安排你能接受吗？如果需要远程、搬迁或其他城市，请直接说清楚。"
      : "Got it. I need to confirm the hard location setup for this role: can you work with the listed location/remote arrangement, or would you need remote, relocation, or a different city?"
  }

  if (qId === "compensation_alignment") {
    return lang === "zh"
      ? "我先确认薪资目标：这份工作的薪资范围对你来说可行吗？如果不行，你目标的大概范围是多少？"
      : "Got it. Quick compensation check: is this role's posted range workable for you? If not, what range are you targeting?"
  }

  if (qId === "sponsorship_status") {
    return lang === "zh"
      ? "我先确认签证情况：你现在或未来会需要公司提供 visa sponsorship 吗？如果情况有细节，可以直接说明。"
      : "Got it. Quick visa check: will you need current or future sponsorship for this role? If there is nuance, tell me the status directly."
  }

  return null
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
    ? "谢谢，这些信息有帮助。我不想硬把你往这个岗位上套；这个 screen 先停在这里。我可以继续帮你找更符合期待的岗位，不过需要先更了解你一点。要继续吗？"
    : "Thanks, that helps. I do not want to force-fit you into this exact role, so I’ll stop this screen here. I can help find jobs that meet your expectations, but I need to understand you a bit better first. Do you want to proceed?"
}

function terminalPauseText(lang: Lang): string {
  return lang === "zh"
    ? "谢谢，这些信息有帮助。目前这个岗位的综合匹配度不够高，我先暂停这次 screen，并继续用你补充的经历找更合适的机会。"
    : "Thanks, that helps. Overall fit for this role still looks low, so I will pause this screen and keep using what you shared for better-aligned roles."
}
