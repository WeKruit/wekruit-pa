/**
 * L1 reducer code-asserts for the prescreen FSM (no LLM).
 *
 * Pins the keystone process-integrity invariants:
 *   - earliest-pending ordering (no skip),
 *   - DETERMINISTIC PASS/FAIL rollup by threshold (the LLM never declares it),
 *   - commit-once (terminalCommits === 1),
 *   - post-terminal idempotency (re-score rejected),
 *   - out-of-order rejection.
 *
 * The judge-proposed score is just a number here; the reducer is the authority.
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/reducers/prescreen-fsm.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_PRESCREEN_THRESHOLD,
  nextPrescreenQuestion,
  recordPrescreenScore,
  type PrescreenState,
} from "./prescreen-fsm.js"

function freshState(questions: string[], threshold = DEFAULT_PRESCREEN_THRESHOLD): PrescreenState {
  return { questions, scores: {}, threshold, terminal: null, terminalCommits: 0 }
}

test("nextPrescreenQuestion hands the earliest unscored question", () => {
  const p = freshState(["systems_design", "ownership", "failure_handling"])
  const next = nextPrescreenQuestion(p)
  assert.equal(next.pending, "systems_design")
  assert.equal(next.terminal, null)
})

test("no-skip: scoring a non-earliest question is rejected (out_of_order)", () => {
  const p = freshState(["systems_design", "ownership", "failure_handling"])
  const r = recordPrescreenScore(p, "ownership", { score: 0.9 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, "out_of_order: expected systems_design, not ownership")
  assert.equal(r.pending, "systems_design")
  assert.deepEqual(p.scores, {}, "nothing recorded on a rejected skip")
})

test("PASS rollup: all scores above threshold → terminal PASS, committed once, reducer-decided", () => {
  const p = freshState(["systems_design", "ownership", "failure_handling"]) // threshold 0.6
  for (const q of ["systems_design", "ownership", "failure_handling"]) {
    const r = recordPrescreenScore(p, q, { score: 0.9, evidence: `${q} evidence` })
    assert.equal(r.ok, true)
  }
  assert.equal(Object.keys(p.scores).length, 3, "all scored")
  assert.equal(p.terminal, "PASS", "avg 0.9 >= 0.6 → PASS, decided by the reducer")
  assert.equal(p.terminalCommits, 1, "commit-once")
})

test("FAIL rollup: avg below threshold → terminal FAIL", () => {
  const p = freshState(["a", "b"]) // threshold 0.6
  recordPrescreenScore(p, "a", { score: 0.2 })
  const r = recordPrescreenScore(p, "b", { score: 0.3 })
  assert.equal(r.terminal, "FAIL", "avg 0.25 < 0.6 → FAIL")
  assert.equal(p.terminal, "FAIL")
  assert.equal(p.terminalCommits, 1, "commit-once even on FAIL")
})

test("threshold boundary: avg exactly == threshold → PASS (>=)", () => {
  const p = freshState(["a", "b"], 0.6)
  recordPrescreenScore(p, "a", { score: 0.6 })
  recordPrescreenScore(p, "b", { score: 0.6 })
  assert.equal(p.terminal, "PASS", "avg 0.6 == threshold → PASS")
})

test("custom threshold from config is honored", () => {
  const p = freshState(["a"], 0.95)
  recordPrescreenScore(p, "a", { score: 0.9 })
  assert.equal(p.terminal, "FAIL", "0.9 < 0.95 → FAIL under a strict config threshold")
})

test("post-terminal idempotency: re-score after terminal is rejected, no re-commit", () => {
  const p = freshState(["a"])
  recordPrescreenScore(p, "a", { score: 0.9 })
  assert.equal(p.terminal, "PASS")
  assert.equal(p.terminalCommits, 1)

  // any further score attempt is a no-op — commit-once guard.
  const r = recordPrescreenScore(p, "a", { score: 0.0 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, "already_terminal")
  assert.equal(r.terminal, "PASS", "terminal unchanged")
  assert.equal(p.terminalCommits, 1, "no second commit")
  assert.equal(p.scores["a"].score, 0.9, "stored score untouched")
})

test("score is clamped into [0,1] before rollup", () => {
  const p = freshState(["a", "b"])
  const r1 = recordPrescreenScore(p, "a", { score: 1.7 })
  assert.equal(r1.score, 1, "over-1 clamped to 1")
  const r2 = recordPrescreenScore(p, "b", { score: -0.4 })
  assert.equal(r2.score, 0, "under-0 clamped to 0")
  // avg = (1 + 0) / 2 = 0.5 < 0.6 → FAIL
  assert.equal(p.terminal, "FAIL")
})

test("nextPrescreenQuestion surfaces the committed terminal once all scored", () => {
  const p = freshState(["a"])
  recordPrescreenScore(p, "a", { score: 0.9 })
  const next = nextPrescreenQuestion(p)
  assert.equal(next.pending, null)
  assert.equal(next.terminal, "PASS", "terminal surfaced, no re-ask")
})

// ── ALWAYS_ASK (Adam 2026-06-14) ────────────────────────────────────────────
// On the thin path the AI question is appended LAST and the FSM only rolls up a
// terminal when earliestPending()===null, so the question is ALREADY asked. These
// tests pin the non-gating + ask-before-terminal invariants explicitly.

test("ALWAYS_ASK: non-gating — a trailing ALWAYS_ASK score is EXCLUDED from the verdict average", () => {
  // Two gating Qs avg 0.9 → PASS; the ALWAYS_ASK question scored 0.0 must NOT drag it to FAIL.
  const p: PrescreenState = {
    questions: ["a", "b", "q_ai_acceleration"],
    scores: {},
    threshold: 0.6,
    terminal: null,
    terminalCommits: 0,
    informational: ["q_ai_acceleration"],
    alwaysAsk: ["q_ai_acceleration"],
  }
  recordPrescreenScore(p, "a", { score: 0.9 })
  recordPrescreenScore(p, "b", { score: 0.9 })
  // Still pending the ALWAYS_ASK question — must NOT have committed a terminal yet.
  assert.equal(p.terminal, null, "must not finalize while the ALWAYS_ASK question is pending")
  assert.equal(nextPrescreenQuestion(p).pending, "q_ai_acceleration")
  // Answer it 0.0 → PASS (gating avg 0.9, AI excluded).
  const r = recordPrescreenScore(p, "q_ai_acceleration", { score: 0.0 })
  assert.equal(r.terminal, "PASS", "ALWAYS_ASK score is excluded from the average → verdict unchanged")
  assert.equal(p.terminal, "PASS")
  assert.equal(p.terminalCommits, 1)
})

test("ALWAYS_ASK: must-be-asked-before-terminal — gating Qs done but AI pending → surfaced as next, not finalized", () => {
  const p: PrescreenState = {
    questions: ["a", "q_ai_acceleration"],
    scores: {},
    threshold: 0.6,
    terminal: null,
    terminalCommits: 0,
    informational: ["q_ai_acceleration"],
    alwaysAsk: ["q_ai_acceleration"],
  }
  const r = recordPrescreenScore(p, "a", { score: 0.2 }) // would be a FAIL on its own
  assert.equal(p.terminal, null, "no terminal while the ALWAYS_ASK question is unanswered")
  assert.equal(r.pending, "q_ai_acceleration", "the ALWAYS_ASK question is surfaced as next")
  // Answer the AI question → the (FAIL) verdict finalizes, AI excluded from the average.
  const r2 = recordPrescreenScore(p, "q_ai_acceleration", { score: 1.0 })
  assert.equal(r2.terminal, "FAIL", "gating avg 0.2 < 0.6 → FAIL; the high AI score does not rescue it")
})
