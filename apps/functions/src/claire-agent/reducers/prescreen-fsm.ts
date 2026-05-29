/**
 * reducers/prescreen-fsm.ts — WS-process owns this file.
 *
 * Pure prescreen FSM (poc-v3 C/C2). Questions + threshold come from the pa-jobs
 * prescreen config (@pa/pa-orchestrator/prescreen — `PrescreenConfig.questions`
 * + `PrescreenConfig.threshold`). The reducer:
 *   - hands the earliest pending question (no skip),
 *   - records a judge-proposed score ONLY for the expected question (rejects
 *     out-of-order),
 *   - at the end, does the DETERMINISTIC PASS/FAIL rollup (avg >= threshold),
 *     commit-once (terminalCommits += 1),
 *   - rejects any post-terminal re-score (idempotency).
 *
 * KEYSTONE: the SCORE itself is proposed by an LLM judge INSIDE the score tool;
 * this reducer only consumes the number. The LLM never declares PASS/FAIL and
 * never skips a question — the reducer decides every transition. No LLM, no I/O
 * here — L1-testable.
 */

/** Default PASS threshold for the thin-Claire prescreen rollup (poc-v3 C: avg >= 0.6). */
export const DEFAULT_PRESCREEN_THRESHOLD = 0.6

export interface PrescreenScore {
  score: number
  evidence?: string
}

export interface PrescreenState {
  questions: string[]
  scores: Record<string, PrescreenScore>
  threshold: number
  terminal: "PASS" | "FAIL" | null
  terminalCommits: number
}

export interface PrescreenNext {
  pending: string | null
  prompt?: string
  terminal: "PASS" | "FAIL" | null
}

export interface PrescreenRecordResult {
  ok: boolean
  reason?: string
  scored?: string
  /** the judge-proposed score that was recorded (clamped to [0,1]). */
  score?: number
  pending: string | null
  terminal: "PASS" | "FAIL" | null
}

/** Earliest question not yet scored — the single source of "what's next". */
function earliestPending(state: PrescreenState): string | null {
  return state.questions.find((q) => !(q in state.scores)) ?? null
}

/** Clamp a judge-proposed score into the valid [0,1] band. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

/** Effective threshold — explicit state value or the thin-Claire default. */
function thresholdOf(state: PrescreenState): number {
  return typeof state.threshold === "number" && Number.isFinite(state.threshold)
    ? state.threshold
    : DEFAULT_PRESCREEN_THRESHOLD
}

/**
 * Hand the earliest pending question, or the committed terminal if all scored.
 * The LLM routes off this — it never picks the question itself, and once the
 * reducer has committed a terminal it surfaces only that (never re-asks).
 */
export function nextPrescreenQuestion(state: PrescreenState): PrescreenNext {
  if (state.terminal) return { pending: null, terminal: state.terminal }
  const pending = earliestPending(state)
  return { pending, terminal: null }
}

/**
 * Record a judge-proposed score for the expected (earliest-pending) question;
 * roll up to a terminal exactly once.
 *
 * Order of guards is load-bearing:
 *   1. post-terminal → reject (idempotency: commit-once means no re-score),
 *   2. out-of-order → reject (no skip),
 *   3. record + clamp the judge score,
 *   4. when nothing pending remains → DETERMINISTIC rollup (avg >= threshold →
 *      "PASS" else "FAIL"), set terminal, terminalCommits += 1.
 *
 * Mutates `state` in place (the per-session store owns the object), consistent
 * with the poc-v3 C reducer.
 */
export function recordPrescreenScore(
  state: PrescreenState,
  question: string,
  score: PrescreenScore,
): PrescreenRecordResult {
  // (1) idempotency — no re-score after the terminal has been committed.
  if (state.terminal) {
    return {
      ok: false,
      reason: "already_terminal",
      pending: null,
      terminal: state.terminal,
    }
  }

  const expected = earliestPending(state)
  if (!expected) {
    // All questions scored but no terminal — shouldn't happen (rollup runs on
    // the last record), but never silently lose the call.
    return { ok: false, reason: "no_pending_question", pending: null, terminal: null }
  }

  // (2) no-skip guard: the reducer only accepts the expected question.
  if (question !== expected) {
    return {
      ok: false,
      reason: `out_of_order: expected ${expected}, not ${question}`,
      pending: expected,
      terminal: null,
    }
  }

  // (3) record the judge-proposed score (clamped). Evidence is a side-effect.
  const clamped = clamp01(score.score)
  state.scores[question] = { score: clamped, evidence: score.evidence ?? "" }

  const next = earliestPending(state)
  if (!next) {
    // (4) DETERMINISTIC ROLLUP — CODE decides PASS/FAIL, not the LLM.
    const vals = Object.values(state.scores).map((s) => s.score)
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length
    state.terminal = avg >= thresholdOf(state) ? "PASS" : "FAIL"
    state.terminalCommits += 1 // prove commit-once
  }

  return {
    ok: true,
    scored: question,
    score: clamped,
    pending: next,
    terminal: state.terminal,
  }
}
