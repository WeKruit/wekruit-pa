/**
 * v1.6 Phase 59 — Smoke tests for QaEvaluator helpers.
 *
 * The page itself is a Firestore-coupled view; for unit testing we
 * exercise the shared helpers (`pct`, `fmtTime`) reused from the
 * CanonicalTags helpers module. Type-correctness of the page component
 * is covered by tsc typecheck on dashboard build.
 *
 * Run via:
 *   node --import tsx --test apps/dashboard-web/src/pages/__tests__/QaEvaluator.test.ts
 */
import test from "node:test"
import assert from "node:assert/strict"

import { pct, fmtTime } from "../CanonicalTags.helpers.js"

test("QA run summary metrics format via pct()", () => {
  // Hard filter pass rate
  assert.equal(pct(0.85), "85.0%")
  // Top-3 acceptable rate
  assert.equal(pct(0.42), "42.0%")
  // Missing/null safety — runs without metrics shouldn't crash
  assert.equal(pct(undefined), "—")
})

test("QA runAt timestamp display via fmtTime()", () => {
  assert.equal(
    fmtTime("2026-05-04T09:00:00.000Z"),
    "2026-05-04 09:00:00",
  )
  assert.equal(fmtTime(undefined), "—")
})
