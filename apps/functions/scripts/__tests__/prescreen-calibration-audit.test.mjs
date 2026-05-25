import test from "node:test"
import assert from "node:assert/strict"

import {
  gradePrescreenSessionForCalibration,
  summarizeCalibrationRows,
} from "../lib/prescreen-calibration-audit.mjs"

test("gradePrescreenSessionForCalibration downgrades broad AI PASS without ownership or metrics", () => {
  const row = gradePrescreenSessionForCalibration({
    id: "ps-weak",
    terminal: "PASS",
    score: 2.6,
    scoreMax: 3,
    threshold: 0.65,
    terminalActionPendingReview: true,
    questions: {
      q_growth_marketing_experience: {
        type: "MUST_HAVE",
        finalS: 0.85,
        finalC: 0.78,
        scored: {
          aggregate: {
            summary: "Helped the marketing team with launch messaging; no measurable result shared.",
          },
        },
      },
      q_scrappy_zero_to_one: {
        type: "MUST_HAVE",
        finalS: 0.88,
        finalC: 0.82,
        scored: { aggregate: { summary: "Contributed to a student project with a team." } },
      },
    },
  })

  assert.equal(row.currentTerminal, "PASS")
  assert.equal(row.rubricRecommendation, "FAIL")
  assert.equal(row.band, "weak_reject")
  assert.match(row.reasons.join(" "), /missing direct ownership/i)
  assert.match(row.reasons.join(" "), /missing measurable growth/i)
})

test("gradePrescreenSessionForCalibration keeps direct, measured evidence as strong PASS", () => {
  const row = gradePrescreenSessionForCalibration({
    id: "ps-strong",
    terminal: "PASS",
    score: 2.9,
    scoreMax: 3,
    threshold: 0.95,
    terminalActionPendingReview: true,
    questions: {
      q_growth_marketing_experience: {
        type: "MUST_HAVE",
        finalS: 0.97,
        finalC: 0.9,
        scored: {
          aggregate: {
            summary: "Owned Meta Ads campaign end-to-end; launched tests and improved conversion by 32%.",
          },
        },
      },
      q_scrappy_zero_to_one: {
        type: "MUST_HAVE",
        finalS: 0.97,
        finalC: 0.88,
        scored: { aggregate: { summary: "Built the first lifecycle playbook from scratch." } },
      },
    },
  })

  assert.equal(row.rubricRecommendation, "PASS")
  assert.equal(row.band, "top_five_pass")
})

test("summarizeCalibrationRows reports AI PASS downgrades", () => {
  const rows = [
    { currentTerminal: "PASS", rubricRecommendation: "FAIL", band: "weak_reject" },
    { currentTerminal: "PASS", rubricRecommendation: "PASS", band: "top_five_pass" },
    { currentTerminal: "HARD_STOP", rubricRecommendation: "HARD_STOP", band: "hard_stop" },
  ]

  const summary = summarizeCalibrationRows(rows)
  assert.equal(summary.total, 3)
  assert.equal(summary.aiPassDowngradedToFail, 1)
  assert.deepEqual(summary.currentTerminalCounts, { PASS: 2, HARD_STOP: 1 })
  assert.deepEqual(summary.rubricRecommendationCounts, { FAIL: 1, PASS: 1, HARD_STOP: 1 })
})
