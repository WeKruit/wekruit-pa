/**
 * v1.8 Phase 76 — Pure state-machine transition tests.
 *
 * Exhaustive grid: every gate × every QuestionType × edge inputs.
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  DEFAULT_TYPE_THRESHOLDS,
  evalConfidenceGate,
  evalFinal,
  evalTypeGate,
  evalViability,
  mergeScored,
  questionsAnswered,
  remainingMaxScore,
  setTerminal,
} from "../transitions.js"
import { emptyPreScreenState } from "../state.js"
import { terminalText } from "../pipeline.js"
import type { ScoredJudgeResult } from "../../onboarding/question.js"

// ════════════════════════════════════════════════════════════════════════════
// Confidence Gate
// ════════════════════════════════════════════════════════════════════════════

test("Phase 76: confidence gate proceeds when c ≥ threshold", () => {
  const r = evalConfidenceGate({ c: 0.8, threshold: 0.7, clarifyRoundsSoFar: 0, maxClarifyRounds: 2 })
  assert.deepEqual(r, { action: "proceed" })
})

test("Phase 76: confidence gate clarifies when c < threshold and k < max", () => {
  const r = evalConfidenceGate({ c: 0.3, threshold: 0.7, clarifyRoundsSoFar: 0, maxClarifyRounds: 2 })
  assert.deepEqual(r, { action: "clarify", kAfter: 1 })
})

test("Phase 76: confidence gate exhausts at k=max", () => {
  const r = evalConfidenceGate({ c: 0.3, threshold: 0.7, clarifyRoundsSoFar: 2, maxClarifyRounds: 2 })
  assert.deepEqual(r, { action: "max_clarify_exhausted" })
})

test("Phase 76: confidence gate bumps k correctly at boundary", () => {
  const r = evalConfidenceGate({ c: 0.5, threshold: 0.7, clarifyRoundsSoFar: 1, maxClarifyRounds: 2 })
  assert.deepEqual(r, { action: "clarify", kAfter: 2 })
})

// ════════════════════════════════════════════════════════════════════════════
// Type Gate — MUST_HAVE
// ════════════════════════════════════════════════════════════════════════════

test("Phase 76: MUST_HAVE proceeds at s=1.0", () => {
  const r = evalTypeGate({ type: "MUST_HAVE", s: 1.0, c: 0.9, confidenceThreshold: 0.7 })
  assert.equal(r.action, "proceed")
})

test("Phase 76: MUST_HAVE hard-stops on any mismatch s<1.0", () => {
  const r = evalTypeGate({ type: "MUST_HAVE", s: 0.95, c: 0.95, confidenceThreshold: 0.7 })
  assert.equal(r.action, "hard_stop")
  if (r.action === "hard_stop") {
    assert.equal(r.cause, "type_gate_fail")
    assert.equal(r.type, "MUST_HAVE")
  }
})

test("Phase 76: MUST_HAVE threshold defaults to 1.0", () => {
  assert.equal(DEFAULT_TYPE_THRESHOLDS.MUST_HAVE, 1.0)
})

// ════════════════════════════════════════════════════════════════════════════
// Type Gate — PROBING
// ════════════════════════════════════════════════════════════════════════════

test("Phase 76: PROBING proceeds at s≥τ_m + c≥τ_c", () => {
  const r = evalTypeGate({ type: "PROBING", s: 0.8, c: 0.8, confidenceThreshold: 0.7 })
  assert.equal(r.action, "proceed")
})

test("Phase 76: PROBING hard-stops when s < τ_m", () => {
  const r = evalTypeGate({ type: "PROBING", s: 0.5, c: 0.9, confidenceThreshold: 0.7 })
  assert.equal(r.action, "hard_stop")
})

test("Phase 76: PROBING hard-stops when c < τ_c", () => {
  const r = evalTypeGate({ type: "PROBING", s: 0.9, c: 0.5, confidenceThreshold: 0.7 })
  assert.equal(r.action, "hard_stop")
})

test("Phase 76: PROBING threshold defaults to 0.7", () => {
  assert.equal(DEFAULT_TYPE_THRESHOLDS.PROBING, 0.7)
})

// ════════════════════════════════════════════════════════════════════════════
// Type Gate — GOOD_TO_HAVE
// ════════════════════════════════════════════════════════════════════════════

test("Phase 76: GOOD_TO_HAVE always proceeds, even at s=0", () => {
  const r = evalTypeGate({ type: "GOOD_TO_HAVE", s: 0, c: 0.1, confidenceThreshold: 0.7 })
  assert.equal(r.action, "proceed")
})

// ════════════════════════════════════════════════════════════════════════════
// Viability Check
// ════════════════════════════════════════════════════════════════════════════

test("Phase 76: viability proceeds during hysteresis window (< N/3 answered)", () => {
  const r = evalViability({
    score: 0,
    scoreMax: 9,
    remainingMaxScore: 9,
    threshold: 0.65,
    questionsAnswered: 1,
    totalQuestions: 9,
  })
  // ⌈9/3⌉ = 3 → 1 < 3 → skip viability
  assert.equal(r.action, "proceed")
})

test("Phase 76: viability pauses when S+R_max < T*S_max after hysteresis", () => {
  // S=2, R_max=2, S_max=10, T=0.65 → required=6.5; upper=4 → pause
  const r = evalViability({
    score: 2,
    scoreMax: 10,
    remainingMaxScore: 2,
    threshold: 0.65,
    questionsAnswered: 4,
    totalQuestions: 10,
  })
  assert.equal(r.action, "pause")
})

test("Phase 76: viability proceeds when upper bound clears threshold", () => {
  // S=5, R_max=4, S_max=10, T=0.65 → required=6.5; upper=9 ≥ 6.5 → proceed
  const r = evalViability({
    score: 5,
    scoreMax: 10,
    remainingMaxScore: 4,
    threshold: 0.65,
    questionsAnswered: 4,
    totalQuestions: 10,
  })
  assert.equal(r.action, "proceed")
})

test("Phase 76: viability hysteresis uses ceil(N/3)", () => {
  // N=4 → ⌈4/3⌉ = 2. At answered=2, viability fires (no longer skipped).
  // S=0, R_max=2, S_max=4, T=0.65 → required=2.6; upper=2 < 2.6 → pause
  const r = evalViability({
    score: 0,
    scoreMax: 4,
    remainingMaxScore: 2,
    threshold: 0.65,
    questionsAnswered: 2,
    totalQuestions: 4,
  })
  assert.equal(r.action, "pause")
})

// ════════════════════════════════════════════════════════════════════════════
// Final Decision
// ════════════════════════════════════════════════════════════════════════════

test("Phase 76: final PASS when ratio ≥ threshold", () => {
  const r = evalFinal({ score: 7, scoreMax: 10, threshold: 0.65 })
  assert.equal(r.action, "pass")
  if (r.action === "pass") assert.equal(r.ratio, 0.7)
})

test("Phase 76: final FAIL when ratio < threshold", () => {
  const r = evalFinal({ score: 5, scoreMax: 10, threshold: 0.65 })
  assert.equal(r.action, "fail")
})

test("Phase 76: final boundary at exactly threshold passes", () => {
  const r = evalFinal({ score: 6.5, scoreMax: 10, threshold: 0.65 })
  assert.equal(r.action, "pass")
})

test("Phase 76: final FAIL with scoreMax=0 (degenerate)", () => {
  const r = evalFinal({ score: 0, scoreMax: 0, threshold: 0.65 })
  assert.equal(r.action, "fail")
})

// ════════════════════════════════════════════════════════════════════════════
// mergeScored — max-by-s monotonicity (PS6)
// ════════════════════════════════════════════════════════════════════════════

function fakeScored(s: number, c: number): ScoredJudgeResult {
  return {
    kind: "scored",
    answered: true,
    perKeyword: [],
    aggregate: { s, c, summary: "x" },
  }
}

test("Phase 76: mergeScored returns next when no prior", () => {
  const result = mergeScored(undefined, fakeScored(0.5, 0.8))
  assert.equal(result.aggregate.s, 0.5)
})

test("Phase 76: mergeScored keeps higher s across rounds", () => {
  const result = mergeScored(fakeScored(0.8, 0.5), fakeScored(0.6, 0.9))
  assert.equal(result.aggregate.s, 0.8)
})

test("Phase 76: mergeScored takes next when s ties", () => {
  const result = mergeScored(fakeScored(0.7, 0.5), fakeScored(0.7, 0.9))
  // takes next (>=) so latest c gets reflected
  assert.equal(result.aggregate.c, 0.9)
})

// ════════════════════════════════════════════════════════════════════════════
// remainingMaxScore + questionsAnswered + setTerminal
// ════════════════════════════════════════════════════════════════════════════

test("Phase 76: remainingMaxScore + questionsAnswered work over state", () => {
  const state = emptyPreScreenState({
    sessionId: "s",
    userId: "u",
    jobId: "j",
    questions: [
      { qId: "q1", type: "MUST_HAVE", weight: 2 },
      { qId: "q2", type: "PROBING", weight: 1 },
      { qId: "q3", type: "GOOD_TO_HAVE", weight: 1 },
    ],
    nowIso: "2026-05-12T00:00:00Z",
  })
  state.questions.q1.finalS = 0.8
  state.questions.q1.finalC = 0.9
  assert.equal(remainingMaxScore(state), 2) // q2(1) + q3(1)
  assert.equal(questionsAnswered(state), 1)
  assert.equal(state.scoreMax, 4)
})

test("Phase 76: setTerminal clears currentQId and stamps reason", () => {
  const state = emptyPreScreenState({
    sessionId: "s",
    userId: "u",
    jobId: "j",
    questions: [{ qId: "q1", type: "MUST_HAVE", weight: 1 }],
    nowIso: "2026-05-12T00:00:00Z",
  })
  const out = setTerminal(state, "HARD_STOP", "must-have failed", "2026-05-12T01:00:00Z")
  assert.equal(out.terminal, "HARD_STOP")
  assert.equal(out.terminalReason, "must-have failed")
  assert.equal(out.currentQId, null)
  assert.equal(out.updatedAt, "2026-05-12T01:00:00Z")
  // original state untouched (pure)
  assert.equal(state.terminal, null)
})

test("PASS terminal text does not duplicate employer follow-up timing", () => {
  const text = terminalText("PASS", "passed", "en")
  assert.match(text, /role-fit screen/i)
  assert.doesNotMatch(text, /business days/i)
  assert.doesNotMatch(text, /employer will follow/i)
})

test("HARD_STOP terminal text is a soft pause, not an abrupt rejection", () => {
  const text = terminalText("HARD_STOP", "must-have failed", "en")
  assert.match(text, /do not want to force-fit/i)
  assert.match(text, /use what you shared/i)
  assert.doesNotMatch(text, /didn't align/i)
})
