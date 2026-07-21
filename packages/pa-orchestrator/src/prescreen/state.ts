/**
 * v1.8 Phase 76 — PreScreenState.
 *
 * State machine carrier for pre-screening sessions. Distinct from
 * `OnboardingPipeline.PipelineState` because:
 *   1. Onboarding has no score / no terminal (PASS/FAIL/HARD_STOP/PAUSE)
 *   2. Pre-screen has k≤2 clarification rounds DISTINCT from
 *      maxAttempts re-asks
 *   3. Pre-screen has Type Gate, Viability, Final Decision transitions
 *
 * Stored under `pa-prescreen-sessions/{sessionId}` in Firestore (Phase 79
 * dashboard + 81 storage layer wires the Firestore adapter).
 */

import type { QuestionType, ScoredJudgeResult } from "../onboarding/question.js"

/**
 * Terminal states (PS6). null = session still in progress.
 *
 *   PASS       — `S / S_max ≥ T` after all Qs answered
 *   FAIL       — `S / S_max < T` after all Qs answered (no single hard stop)
 *   HARD_STOP  — MUST_HAVE or PROBING Q failed the Type Gate
 *   PAUSE      — Viability: `S + R_max < T·S_max` after ⌈N/3⌉ answered
 */
export type PreScreenTerminal = "PASS" | "FAIL" | "HARD_STOP" | "PAUSE" | null

/**
 * Per-question state captured by the pipeline. Written to Firestore
 * (Phase 79 session-detail page reads).
 */
export interface PreScreenQuestionState {
  qId: string
  type: QuestionType
  weight: number
  /**
   * v1.9 — per-Q τ_m override. When unset, evalTypeGate falls back to
   * DEFAULT_TYPE_THRESHOLDS[type]. Production MUST_HAVE Qs typically set
   * this to ~0.85 because real LLM scoring rarely hits 1.0.
   */
  matchThreshold?: number
  /** k counter — 0..2 clarification rounds. */
  clarifyRounds: number
  /** Best-so-far scored result across clarification rounds (max-by-s). */
  scored?: ScoredJudgeResult
  /**
   * Candidate replies collected for this question. Scoring uses the bounded
   * accumulated answer so later clarifications are evaluated with the story
   * the candidate has already shared, not as isolated fragments.
   */
  evidenceReplies?: string[]
  /** Final s_i fed into aggregation. */
  finalS?: number
  /** Final c_i fed into aggregation. */
  finalC?: number
  /** When this Q was answered (ISO). null when in-progress. */
  answeredAt?: string
  /** Reason field set when this Q caused a terminal state. */
  terminalCause?: "type_gate_fail" | "viability_fail" | "max_clarify_exhausted" | "candidate_declined"
  /**
   * SPEC §5a — authored cross-job identity. When set, an answer to this question is
   * shared across jobs via `pa-users/{uid}.prescreenSharedAnswers[sharedKey]`
   * (skip + carry). Absent for job-specific questions.
   */
  sharedKey?: string
  /**
   * SPEC §7.4 — provenance when this question was PRE-ANSWERED at session start from
   * the candidate's global shared-answer store (the candidate was NOT asked it this
   * session; the stored reply was re-judged against this job's rubric). Absent for
   * questions answered live in this session.
   */
  carriedFrom?: {
    sourceSessionId: string
    sourceJobId: string
    answeredAt: string
  }
}

/**
 * Top-level pre-screen session state.
 */
export interface PreScreenState {
  sessionId: string
  userId: string
  jobId: string
  /** Active Q id, or null when terminal. */
  currentQId: string | null
  /** Per-Q state map. */
  questions: Record<string, PreScreenQuestionState>
  /** Order of Q ids — drives the queue. */
  qOrder: string[]
  /** Running weighted score: S = Σ s_i · W_{Q_i}. */
  score: number
  /** Max possible weighted score: S_max = Σ W_{Q_i}. */
  scoreMax: number
  /** Pass threshold T ∈ [0,1]. */
  threshold: number
  /** Confidence threshold τ_c (default 0.7). */
  confidenceThreshold: number
  /** Max clarification rounds per Q (PS6: 2). */
  maxClarifyRounds: number
  /** Terminal state or null. */
  terminal: PreScreenTerminal
  /** Human-readable reason set on terminal transition. */
  terminalReason?: string
  /**
   * Last few clarify follow-ups Claire has ALREADY sent this session (cap 6),
   * across all questions. The clarify composer reads these to avoid repeating
   * its own openers/phrasings (the "that helps" / "Got it" repetition Adam heard
   * on the call), and opener rotation keys off the cumulative length instead of
   * a per-question round that resets to "Got it - " on every new question.
   */
  recentClarifyTexts?: string[]
  /**
   * ALWAYS_ASK deferral stash (Adam 2026-06-14). When the FSM has DECIDED a
   * terminal (PASS/FAIL/HARD_STOP/PAUSE) but an unanswered, not-skipped
   * ALWAYS_ASK question still remains, the pipeline does NOT finalize: it stashes
   * the already-computed verdict here and re-points `currentQId` at the
   * ALWAYS_ASK question so it gets asked first. The verdict is AUTHORITATIVE on
   * re-entry — once all ALWAYS_ASK questions are answered, this stashed terminal
   * is replayed verbatim (NEVER recomputed via evalFinal), so an ALWAYS_ASK
   * answer can never convert a HARD_STOP/PAUSE into PASS/FAIL. Absent when no
   * terminal is pending.
   */
  pendingTerminal?: {
    terminal: Exclude<PreScreenTerminal, null>
    reason: string
  }
  /** Product-level session boundary; durable profile data lives elsewhere. */
  workSession?: {
    kind: "job_prescreen"
    status: "active" | "ended"
    startedAt?: string
    endedAt?: string
    boundary?: "trigger" | "terminal" | "timeout" | "superseded" | "user_exit"
    supersededBySessionId?: string
  }
  /**
   * Engagement-nurture bookkeeping for sessions awaiting WeKruit's review
   * (passed / under-review). Written by the prescreen-NURTURE engine
   * (apps/functions/src/prescreen-nurture-*) when a periodic "still working on
   * it" check-in is dispatched. Distinct from durable profile data — this is
   * job-specific session bookkeeping. Absent until the first nurture fires.
   */
  prescreenMetrics?: {
    /** Count of nurture check-ins dispatched for this session (cap at max). */
    totalNurtureSent: number
    /** ISO timestamp of the most recent nurture dispatch. */
    lastNurtureAt: string
  }
  /** ISO created/updated timestamps. */
  createdAt: string
  updatedAt: string
}

/**
 * Construct a fresh state for a new session. Caller passes the Q ids in
 * priority order (MUST_HAVE → PROBING → GOOD_TO_HAVE) plus their type +
 * weight from the prescreenConfig.
 */
export function emptyPreScreenState(args: {
  sessionId: string
  userId: string
  jobId: string
  questions: Array<{
    qId: string
    type: QuestionType
    weight: number
    matchThreshold?: number
    sharedKey?: string
  }>
  threshold?: number
  confidenceThreshold?: number
  maxClarifyRounds?: number
  nowIso: string
}): PreScreenState {
  const questions: Record<string, PreScreenQuestionState> = {}
  let scoreMax = 0
  for (const q of args.questions) {
    questions[q.qId] = {
      qId: q.qId,
      type: q.type,
      weight: q.weight,
      ...(q.matchThreshold !== undefined ? { matchThreshold: q.matchThreshold } : {}),
      ...(q.sharedKey !== undefined ? { sharedKey: q.sharedKey } : {}),
      clarifyRounds: 0,
    }
    scoreMax += q.weight
  }
  return {
    sessionId: args.sessionId,
    userId: args.userId,
    jobId: args.jobId,
    currentQId: args.questions[0]?.qId ?? null,
    questions,
    qOrder: args.questions.map((q) => q.qId),
    score: 0,
    scoreMax,
    threshold: args.threshold ?? 0.65,
    confidenceThreshold: args.confidenceThreshold ?? 0.7,
    maxClarifyRounds: args.maxClarifyRounds ?? 2,
    terminal: null,
    createdAt: args.nowIso,
    updatedAt: args.nowIso,
  }
}

/**
 * Storage adapter — pipeline reads/writes through this. Firestore impl
 * lives in Phase 79; in-memory impl below for tests.
 */
export interface PreScreenStateProvider {
  load(sessionId: string): Promise<PreScreenState | null>
  save(state: PreScreenState): Promise<void>
}

/** Test-only in-memory provider. */
export class InMemoryPreScreenStore implements PreScreenStateProvider {
  private store = new Map<string, PreScreenState>()
  async load(sessionId: string): Promise<PreScreenState | null> {
    return this.store.get(sessionId) ?? null
  }
  async save(state: PreScreenState): Promise<void> {
    this.store.set(state.sessionId, { ...state })
  }
}
