import assert from "node:assert/strict"
import test from "node:test"

import {
  PRESCREEN_TOP_FIVE_PASS_RATIO,
  classifyPrescreenReviewRow,
  filterAndSortPrescreenRows,
} from "./prescreen-review-ranking.js"

test("classifyPrescreenReviewRow requires top-five direct evidence for strict pass", () => {
  const weak = classifyPrescreenReviewRow({
    terminal: "PASS",
    score: 2.95,
    scoreMax: 3,
    questions: {
      q_growth_marketing_experience: {
        type: "MUST_HAVE",
        finalS: 0.98,
        finalC: 0.9,
        scored: {
          aggregate: {
            summary: "Helped marketing with launch planning but did not share a measurable growth result.",
          },
        },
      },
    },
  })

  assert.equal(PRESCREEN_TOP_FIVE_PASS_RATIO, 0.95)
  assert.equal(weak.recommendation, "FAIL")
  assert.equal(weak.bucket, "batch_reject")
  assert.match(weak.reasons.join(" "), /missing measurable/i)

  const strong = classifyPrescreenReviewRow({
    terminal: "PASS",
    score: 3,
    scoreMax: 3,
    questions: {
      q_growth_marketing_experience: {
        type: "MUST_HAVE",
        finalS: 0.97,
        finalC: 0.9,
        scored: {
          aggregate: {
            summary: "Owned lifecycle campaigns end-to-end and increased qualified signups by 38%.",
          },
        },
      },
    },
  })

  assert.equal(strong.recommendation, "PASS")
  assert.equal(strong.bucket, "top_five_pass")
})

test("filterAndSortPrescreenRows ranks likely rejects before top-five pass when strict priority is selected", () => {
  const rows = filterAndSortPrescreenRows(
    [
      {
        id: "top",
        terminal: "PASS",
        score: 3,
        scoreMax: 3,
        terminalActionPendingReview: true,
        createdAt: "2026-05-25T10:00:00Z",
        updatedAt: "2026-05-25T10:00:00Z",
        jobId: "job-a",
        userId: "user-a",
        questions: {
          q_growth_marketing_experience: {
            type: "MUST_HAVE",
            finalS: 0.97,
            finalC: 0.9,
            scored: { aggregate: { summary: "Owned campaign and grew signups by 38%." } },
          },
        },
      },
      {
        id: "reject",
        terminal: "PASS",
        score: 2.9,
        scoreMax: 3,
        terminalActionPendingReview: true,
        createdAt: "2026-05-25T11:00:00Z",
        updatedAt: "2026-05-25T11:00:00Z",
        jobId: "job-b",
        userId: "user-b",
        questions: {
          q_growth_marketing_experience: {
            type: "MUST_HAVE",
            finalS: 0.9,
            finalC: 0.82,
            scored: { aggregate: { summary: "Worked with marketing on analysis." } },
          },
        },
      },
    ],
    { bucket: "all", sort: "strict_priority", search: "" },
  )

  assert.deepEqual(rows.map((row) => row.id), ["reject", "top"])
  assert.deepEqual(
    filterAndSortPrescreenRows(rows, { bucket: "top_five_pass", sort: "strict_priority", search: "" }).map((row) => row.id),
    ["top"],
  )
})
