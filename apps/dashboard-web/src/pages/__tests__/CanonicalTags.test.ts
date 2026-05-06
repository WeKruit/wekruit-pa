/**
 * v1.6 Phase 59 — Pure-logic tests for CanonicalTags helpers.
 *
 * Mirrors MatchCandidates.test.ts pattern — the dashboard package has no
 * React Testing Library, so we exercise the parts that have testable logic.
 * The page component itself (CanonicalTags.tsx) is covered by tsc typecheck
 * on dashboard build.
 *
 * Run via:
 *   node --import tsx --test apps/dashboard-web/src/pages/__tests__/CanonicalTags.test.ts
 */
import test from "node:test"
import assert from "node:assert/strict"

import { AXES, sortSandboxTokens, pct, fmtTime } from "../CanonicalTags.helpers.js"

test("AXES contains all 9 canonical axes (v1.6 Phase 52 vocabs)", () => {
  const keys = AXES.map((a) => a.key)
  assert.deepEqual(keys.sort(), [
    "careerStage",
    "industrySector",
    "jobType",
    "location",
    "major",
    "relevantTags",
    "roleFunction",
    "skillBucket",
    "visa",
  ])
})

test("AXES vocab counts are non-zero for closed enums (v1.6 Phase 52)", () => {
  // 17 jobright role functions per D1
  const role = AXES.find((a) => a.key === "roleFunction")!
  assert.equal(role.values.length, 17)
  // Exactly 4 visa values per D4
  const visa = AXES.find((a) => a.key === "visa")!
  assert.equal(visa.values.length, 4)
  // 42+ industry-sector values per D2 (extends macmini 38)
  const ind = AXES.find((a) => a.key === "industrySector")!
  assert.ok(ind.values.length >= 42, `expected ≥42 industry-sector tokens, got ${ind.values.length}`)
})

test("AXES match semantics — D9: roleFunction hard filter, industrySector soft score", () => {
  const role = AXES.find((a) => a.key === "roleFunction")!
  assert.equal(role.matchSemantics, "hard_filter")
  const ind = AXES.find((a) => a.key === "industrySector")!
  assert.equal(ind.matchSemantics, "soft_score")
  // D3: major is soft (NOT hard filter)
  const major = AXES.find((a) => a.key === "major")!
  assert.equal(major.matchSemantics, "soft_score")
})

test("AXES.industrySector supportsOverlay (D16 admin add-able)", () => {
  const ind = AXES.find((a) => a.key === "industrySector")!
  assert.equal(ind.supportsOverlay, true)
  // No other axis is overlay-supported (per registry)
  const others = AXES.filter((a) => a.key !== "industrySector")
  for (const a of others) {
    assert.equal(a.supportsOverlay, false, `expected ${a.key} to NOT support overlay`)
  }
})

test("relevantTags is the only open-vocab axis", () => {
  const open = AXES.filter((a) => a.isOpenVocab)
  assert.equal(open.length, 1)
  assert.equal(open[0]!.key, "relevantTags")
})

test("sortSandboxTokens: most-proposed first (count desc)", () => {
  const rows = [
    { token: "a", count: 1 },
    { token: "b", count: 5 },
    { token: "c", count: 3 },
    { token: "d" },
  ]
  const sorted = sortSandboxTokens(rows)
  assert.deepEqual(
    sorted.map((r) => r.token),
    ["b", "c", "a", "d"],
  )
  // Non-mutating
  assert.equal(rows[0]!.token, "a")
})

test("pct: formats 0..1 → percent, handles bad input", () => {
  assert.equal(pct(0.123), "12.3%")
  assert.equal(pct(0), "0.0%")
  assert.equal(pct(1), "100.0%")
  assert.equal(pct(null), "—")
  assert.equal(pct(undefined), "—")
  assert.equal(pct(NaN), "—")
  assert.equal(pct("0.5"), "—")
})

test("fmtTime: ISO timestamp → human-readable space-separated", () => {
  assert.equal(fmtTime("2026-05-06T10:00:00.000Z"), "2026-05-06 10:00:00")
  assert.equal(fmtTime(""), "—")
  assert.equal(fmtTime(undefined), "—")
  assert.equal(fmtTime(null), "—")
})
