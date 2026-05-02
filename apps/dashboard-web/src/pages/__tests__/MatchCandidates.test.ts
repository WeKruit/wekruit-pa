/**
 * Phase 49 (v1.5 / Stream-H / D9) — pure-logic tests for MatchCandidates
 * helper module. Run via:
 *
 *   node --import tsx --test apps/dashboard-web/src/pages/__tests__/MatchCandidates.test.ts
 *
 * Mirrors the toolCallSummary.test.ts pattern — the dashboard package has
 * no React Testing Library, so we exercise the parts that have testable
 * logic. The page component itself (MatchCandidates.tsx) is covered by
 * tsc typecheck on dashboard build.
 */
import test from "node:test"
import assert from "node:assert/strict"
import {
  parseTagsInput,
  validateMatchForm,
  formatMatchScore,
  filterOptedInOnly,
  INDUSTRY_OPTIONS,
  type CandidateRow,
} from "../MatchCandidates.helpers.js"

test("parseTagsInput: splits on comma/semicolon/newline + dedupes case-insensitive", () => {
  assert.deepEqual(parseTagsInput("react, python; ts\nreact"), ["react", "python", "ts"])
  assert.deepEqual(parseTagsInput(""), [])
  assert.deepEqual(parseTagsInput("   "), [])
  // Cap 20.
  const many = Array.from({ length: 30 }, (_, i) => `tag${i}`).join(",")
  assert.equal(parseTagsInput(many).length, 20)
})

test("validateMatchForm: rejects too-short JD, bad industry, bad topK", () => {
  assert.match(
    validateMatchForm({ jobDescription: "short", industry: "tech" }) ?? "",
    /too short/,
  )
  assert.match(
    validateMatchForm({
      jobDescription: "x".repeat(50),
      industry: "not-a-real-industry",
    }) ?? "",
    /industry/,
  )
  assert.match(
    validateMatchForm({
      jobDescription: "x".repeat(50),
      industry: "tech",
      topK: 9999,
    }) ?? "",
    /topK/,
  )
  // Happy path returns null.
  assert.equal(
    validateMatchForm({
      jobDescription: "x".repeat(50),
      industry: "tech",
      topK: 20,
    }),
    null,
  )
  // Sanity: every INDUSTRY_OPTIONS value is accepted.
  for (const opt of INDUSTRY_OPTIONS) {
    assert.equal(
      validateMatchForm({ jobDescription: "x".repeat(50), industry: opt.value }),
      null,
      `industry ${opt.value} should validate`,
    )
  }
})

test("formatMatchScore: handles numeric, null, NaN", () => {
  assert.equal(formatMatchScore(0.4234), "0.42")
  assert.equal(formatMatchScore(1), "1.00")
  assert.equal(formatMatchScore(0), "0.00")
  assert.equal(formatMatchScore(null), "—")
  assert.equal(formatMatchScore(undefined), "—")
  assert.equal(formatMatchScore(NaN), "—")
})

test("filterOptedInOnly: keeps hasOptedIn===true only", () => {
  const rows: CandidateRow[] = [
    { userId: "a", displayName: "A", matchScore: 0.9, topMatchedReasons: [], hasOptedIn: true, preferredLanguage: "zh" },
    { userId: "b", displayName: "B", matchScore: 0.85, topMatchedReasons: [], hasOptedIn: false, preferredLanguage: "en" },
    { userId: "c", displayName: "C", matchScore: 0.8, topMatchedReasons: [], hasOptedIn: true, preferredLanguage: "zh" },
  ]
  const opted = filterOptedInOnly(rows)
  assert.deepEqual(opted.map((r) => r.userId), ["a", "c"])
  // Non-mutating
  assert.equal(rows.length, 3)
})
