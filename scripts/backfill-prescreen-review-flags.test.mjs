/**
 * Unit tests for the pure classification + converter-input functions inside
 * the stranded-prescreen backfill script. The Firestore loop itself is
 * covered by the manual --dry-run / --apply verification gate, but the
 * tier semantics are founder-locked (Tier 1 = silent pending queue entry,
 * Tier 2 = legacy_unreviewed and NEVER queued) and the idempotency guard is
 * critical, so both get pinned here.
 */
import assert from "node:assert/strict"
import test from "node:test"
import {
  buildTier1ConverterInput,
  classifySessionForBackfill,
} from "./backfill-prescreen-review-flags.mjs"

test("tier1 shape — terminal with no pending flag, no review, no firedAt", () => {
  for (const terminal of ["PASS", "FAIL", "HARD_STOP"]) {
    const r = classifySessionForBackfill({ terminal })
    assert.equal(r.tier, "tier1_stranded", `terminal=${terminal}`)
    assert.equal(r.reason, "stranded_terminal_no_review")
  }
})

test("tier2 shape — terminal with terminalActionFiredAt set and no review", () => {
  for (const terminal of ["PASS", "FAIL", "HARD_STOP"]) {
    const r = classifySessionForBackfill({
      terminal,
      terminalActionFiredAt: "2026-06-01T00:00:00.000Z",
    })
    assert.equal(r.tier, "tier2_auto_finalized", `terminal=${terminal}`)
    assert.equal(r.reason, "auto_finalized_no_review")
  }
})

test("tier2 tolerates a Firestore Timestamp-shaped terminalActionFiredAt", () => {
  const r = classifySessionForBackfill({
    terminal: "FAIL",
    terminalActionFiredAt: { seconds: 1780000000, nanoseconds: 0 },
  })
  assert.equal(r.tier, "tier2_auto_finalized")
})

test("pending-already is skipped (idempotency guard)", () => {
  const r = classifySessionForBackfill({
    terminal: "PASS",
    terminalActionPendingReview: true,
  })
  assert.equal(r.tier, "skip")
  assert.equal(r.reason, "already_pending")
})

test("review-already is skipped (idempotency guard)", () => {
  const r = classifySessionForBackfill({
    terminal: "PASS",
    review: { status: "pending", evaluationAttemptId: "eval_attempt_x" },
  })
  assert.equal(r.tier, "skip")
  assert.equal(r.reason, "review_exists")
})

test("PAUSE is skipped — not an actionable terminal", () => {
  const r = classifySessionForBackfill({ terminal: "PAUSE" })
  assert.equal(r.tier, "skip")
  assert.equal(r.reason, "terminal_pause")
})

test("terminal null / missing is skipped — session still in progress", () => {
  assert.equal(classifySessionForBackfill({ terminal: null }).tier, "skip")
  assert.equal(classifySessionForBackfill({ terminal: null }).reason, "terminal_null")
  assert.equal(classifySessionForBackfill({}).tier, "skip")
  assert.equal(classifySessionForBackfill({}).reason, "terminal_null")
})

test("terminal + pendingFlag false but review exists is skipped", () => {
  const r = classifySessionForBackfill({
    terminal: "HARD_STOP",
    terminalActionPendingReview: false,
    review: { status: "committed", finalTerminal: "FAIL" },
  })
  assert.equal(r.tier, "skip")
  assert.equal(r.reason, "review_exists")
})

test("review wins over firedAt — auto-finalized session already marked is skipped", () => {
  const r = classifySessionForBackfill({
    terminal: "FAIL",
    terminalActionFiredAt: "2026-06-01T00:00:00.000Z",
    review: { status: "legacy_unreviewed", proposedTerminal: "FAIL" },
  })
  assert.equal(r.tier, "skip")
  assert.equal(r.reason, "review_exists")
})

test("idempotency — a doc the backfill already repaired classifies as skip", () => {
  // Post-tier1 write shape.
  const tier1After = classifySessionForBackfill({
    terminal: "PASS",
    evaluationAttemptId: "eval_attempt_x",
    terminalActionPendingReview: true,
    review: { status: "pending", evaluationAttemptId: "eval_attempt_x", proposedTerminal: "PASS" },
  })
  assert.equal(tier1After.tier, "skip")
  // Post-tier2 write shape.
  const tier2After = classifySessionForBackfill({
    terminal: "FAIL",
    terminalActionFiredAt: "2026-06-01T00:00:00.000Z",
    review: { status: "legacy_unreviewed", proposedTerminal: "FAIL" },
  })
  assert.equal(tier2After.tier, "skip")
})

test("buildTier1ConverterInput — complete session doc converts", () => {
  const doc = {
    userId: "u1",
    jobId: "job1",
    terminal: "FAIL",
    qOrder: ["q1"],
    questions: { q1: { qId: "q1", type: "MUST_HAVE", weight: 1, clarifyRounds: 0 } },
    cfgSnapshot: { questions: [], threshold: 0.7 },
    updatedAt: "2026-06-01T00:00:00.000Z",
  }
  const r = buildTier1ConverterInput("sess1", doc, "2026-06-09T00:00:00.000Z")
  assert.equal(r.ok, true)
  assert.equal(r.input.state.sessionId, "sess1")
  assert.equal(r.input.terminal, "FAIL")
  assert.equal(r.input.nowIso, "2026-06-01T00:00:00.000Z")
  assert.deepEqual(r.input.cfgSnapshot, { questions: [], threshold: 0.7 })
})

test("buildTier1ConverterInput — falls back to run time when updatedAt missing", () => {
  const doc = {
    userId: "u1",
    jobId: "job1",
    terminal: "PASS",
    qOrder: [],
    questions: {},
  }
  const r = buildTier1ConverterInput("sess1", doc, "2026-06-09T00:00:00.000Z")
  assert.equal(r.ok, true)
  assert.equal(r.input.nowIso, "2026-06-09T00:00:00.000Z")
  assert.equal(r.input.cfgSnapshot, undefined)
})

test("buildTier1ConverterInput — missing converter fields are unconvertible (no dead queue rows)", () => {
  const base = {
    userId: "u1",
    jobId: "job1",
    terminal: "PASS",
    qOrder: [],
    questions: {},
  }
  assert.equal(buildTier1ConverterInput("s", { ...base, userId: "" }, "t").reason, "missing_user_id")
  assert.equal(buildTier1ConverterInput("s", { ...base, jobId: undefined }, "t").reason, "missing_job_id")
  assert.equal(buildTier1ConverterInput("s", { ...base, qOrder: undefined }, "t").reason, "missing_q_order")
  assert.equal(buildTier1ConverterInput("s", { ...base, questions: undefined }, "t").reason, "missing_questions")
})
