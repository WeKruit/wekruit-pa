/**
 * prescreen-staleness.test.ts — pure helpers for the zombie-prescreen sweep (Adam 2026-06-21).
 *
 * Run: node --import tsx --test apps/functions/src/prescreen-staleness.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  isStaleClosedPrescreenSession,
  STALE_PRESCREEN_TERMINAL_REASON,
  buildStalePrescreenSweepPatch,
  buildStalePrescreenSweepTurn,
} from "./prescreen-staleness.js"

const NOW = "2026-06-21T22:00:00.000Z"

test("buildStalePrescreenSweepPatch → cleanly-cancelled stale-closed terminal", () => {
  const patch = buildStalePrescreenSweepPatch(NOW)
  // terminal != null → all three active detectors skip it.
  assert.equal(patch.terminal, "PAUSE")
  // stale-closed reason → isStaleClosedPrescreenSession true → "timed out" copy, never "under review".
  assert.equal(patch.terminalReason, STALE_PRESCREEN_TERMINAL_REASON)
  assert.equal(isStaleClosedPrescreenSession(patch), true)
  // currentQId nulled → FSM has no active question to resume.
  assert.equal(patch.currentQId, null)
  // expiredAt stamped (distinct from updatedAt the zombie self-bumped).
  assert.equal(patch.expiredAt, NOW)
  assert.equal((patch.workSession as { boundary?: string }).boundary, "timeout")
  // The send-gate is NOT folded into the cancel patch.
  assert.equal("expiryNoticeSentAt" in patch, false)
})

test("buildStalePrescreenSweepTurn → auditable record with age + createdAt + detector", () => {
  const turn = buildStalePrescreenSweepTurn({
    createdAtIso: "2026-06-18T20:05:00.743Z",
    nowIso: NOW,
    ageMs: 3 * 24 * 60 * 60 * 1000,
    detector: "find_active_session",
  })
  assert.equal(turn.qId, "terminal")
  assert.equal(turn.ts, NOW)
  const action = turn.action as Record<string, unknown>
  assert.equal(action.kind, "session_expired_swept")
  assert.equal(action.reason, STALE_PRESCREEN_TERMINAL_REASON)
  assert.equal(action.detector, "find_active_session")
  assert.equal(action.createdAt, "2026-06-18T20:05:00.743Z")
  assert.equal(action.expiredAt, NOW)
  assert.equal(action.ageMs, 3 * 24 * 60 * 60 * 1000)
})

test("buildStalePrescreenSweepTurn → tolerates a null createdAt/age (fail-open detector)", () => {
  const turn = buildStalePrescreenSweepTurn({
    createdAtIso: null,
    nowIso: NOW,
    ageMs: null,
    detector: "mode_selector",
  })
  const action = turn.action as Record<string, unknown>
  assert.equal(action.createdAt, null)
  assert.equal(action.ageMs, null)
  assert.equal(action.detector, "mode_selector")
})
