/**
 * reducers/candidate-job-state.ts — WS-process owns this file.
 *
 * Thin wrapper over the existing per-(candidate,job) FSM `reduceCandidateJobState`
 * (@pa/core-types) + the I/O-backed `applyCandidateJobEvent` (@pa/pa-persistence).
 * prospect → candidate_matched → … → passed/not_passed/employer_visible, with
 * terminal idempotency keys (commit PASS/FAIL/employer-visible exactly once).
 *
 * KEYSTONE: the per-job state machine is deterministic. The LLM may extract an
 * intent (e.g. "candidate is interested") but it never controls the transition —
 * `reduceCandidateJobState` decides, and `applyCandidateJobEvent` enforces
 * commit-once via an audit-keyed Firestore transaction (duplicate event ids are
 * idempotent no-ops).
 */
import {
  reduceCandidateJobState,
  type CandidateJobEvent,
  type CandidateJobState,
  type StateReductionResult,
} from "@pa/core-types"
import { applyCandidateJobEvent } from "@pa/pa-persistence"
import type { Firestore } from "firebase-admin/firestore"

export interface CandidateJobTransitionInput {
  candidateId: string
  jobId: string
  /** The current per-job state to reduce FROM (defaults to the entry state). */
  current?: CandidateJobState
  /** The typed event the LLM/connector proposes (never the target state itself). */
  event: CandidateJobEvent
}

/**
 * Pure, deterministic transition — no I/O. Reduces the given `current` state
 * (or the `candidate_matched` entry state) against the typed event. The reducer
 * is the sole authority on the next state; an invalid transition is a no-op
 * that preserves `current`.
 */
export function transitionCandidateJobState(
  input: CandidateJobTransitionInput,
): StateReductionResult<CandidateJobState> {
  const current: CandidateJobState = input.current ?? "candidate_matched"
  return reduceCandidateJobState(current, input.event)
}

/**
 * I/O-backed transition — the production seam. Delegates to the KEEP backend
 * `applyCandidateJobEvent`, which runs the same `reduceCandidateJobState` inside
 * an audit-keyed transaction so a duplicate event id commits exactly once
 * (terminal idempotency). Returned `idempotent: true` means the event was a
 * replay and no second commit happened.
 */
export function commitCandidateJobEvent(
  db: Firestore,
  event: CandidateJobEvent,
): ReturnType<typeof applyCandidateJobEvent> {
  return applyCandidateJobEvent(db, event)
}
