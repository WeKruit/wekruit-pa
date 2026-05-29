/**
 * reducers/candidate-job-state.ts — WS-process owns this file.
 *
 * Thin wrapper over the existing per-(candidate,job) FSM `reduceCandidateJobState`
 * (@pa/pa-persistence). prospect → candidate_matched → … → passed/not_passed, with
 * terminal idempotency keys (commit PASS/FAIL/employer-visible exactly once).
 *
 * WS-process: wire to reduceCandidateJobState + applyCandidateJobEvent.
 */
import { notImplemented } from "../types.js"

export interface CandidateJobTransitionInput {
  candidateId: string
  jobId: string
  event: unknown
}

export function transitionCandidateJobState(input: CandidateJobTransitionInput): unknown {
  return notImplemented("WS-process", "candidate-job-state.transitionCandidateJobState")
}
