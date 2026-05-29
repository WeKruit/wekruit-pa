/**
 * reducers/prescreen-fsm.ts — WS-process owns this file.
 *
 * Pure prescreen FSM (poc-v3 C/C2). Questions + rubric come from the pa-jobs
 * prescreen config (@pa/pa-orchestrator/prescreen). The reducer:
 *   - hands the earliest pending question (no skip),
 *   - records a score ONLY for the expected question (rejects out-of-order),
 *   - at the end, does the DETERMINISTIC PASS/FAIL rollup (threshold), commit-once,
 *   - rejects any post-terminal re-score (idempotency).
 * The SCORE itself is proposed by an LLM judge INSIDE the score tool; this reducer
 * only consumes the number. No LLM, no I/O here — L1-testable.
 */
import { notImplemented } from "../types.js"

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
  pending: string | null
  terminal: "PASS" | "FAIL" | null
}

export function nextPrescreenQuestion(state: PrescreenState): PrescreenNext {
  return notImplemented("WS-process", "prescreen-fsm.nextPrescreenQuestion")
}

/** Record a judge-proposed score for the expected question; roll up to terminal once. */
export function recordPrescreenScore(
  state: PrescreenState,
  question: string,
  score: PrescreenScore,
): PrescreenRecordResult {
  return notImplemented("WS-process", "prescreen-fsm.recordPrescreenScore")
}
