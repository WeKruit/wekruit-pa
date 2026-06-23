import assert from "node:assert/strict"
import test from "node:test"

import {
  PRESCREEN_TOP_FIVE_PASS_RATIO,
  classifyPrescreenReviewRow,
  filterAndSortPrescreenRows,
  summarizePrescreenReviewRows,
} from "./prescreen-review-classification.js"

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

test("filterAndSortPrescreenRows supports review queue, terminal, action, draft, and search filters", () => {
  const rows = [
    {
      id: "pending-reject",
      terminal: "PASS",
      score: 2.6,
      scoreMax: 3,
      terminalActionPendingReview: true,
      createdAt: "2026-05-25T10:00:00Z",
      jobId: "job-growth",
      jobTitle: "Growth Marketer",
      jobCompany: "Acme",
      userId: "user-a",
      questions: {
        q_growth_marketing_experience: {
          type: "MUST_HAVE",
          finalS: 0.7,
          finalC: 0.8,
          scored: { aggregate: { summary: "Helped on campaigns without ownership metrics." } },
        },
      },
    },
    {
      id: "committed-pass",
      terminal: "PASS",
      score: 3,
      scoreMax: 3,
      terminalActionPendingReview: false,
      createdAt: "2026-05-25T11:00:00Z",
      jobId: "job-pass",
      userId: "user-b",
      review: {
        finalTerminal: "PASS",
        candidateDecision: {
          candidateMessageBody: "Next step.",
          decisionReason: "Strong ownership.",
          recommendedActions: ["Watch for next steps."],
          finalTerminal: "PASS",
          reviewedAt: "2026-05-25T12:00:00Z",
        },
      },
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
      id: "pending-hard-stop",
      terminal: "HARD_STOP",
      score: 0,
      scoreMax: 3,
      terminalActionPendingReview: true,
      createdAt: "2026-05-25T12:00:00Z",
      jobId: "job-stop",
      userId: "user-c",
      questions: {},
    },
  ]

  assert.deepEqual(
    filterAndSortPrescreenRows(rows, {
      bucket: "all",
      sort: "strict_priority",
      search: "",
      queue: "committed",
      terminal: "PASS",
      action: "PASS",
      draft: "has_decision",
    }).map((row) => row.id),
    ["committed-pass"],
  )
  assert.deepEqual(
    filterAndSortPrescreenRows(rows, {
      bucket: "all",
      sort: "strict_priority",
      search: "",
      queue: "pending",
      terminal: "HARD_STOP",
      action: "HARD_STOP",
      draft: "missing_decision",
    }).map((row) => row.id),
    ["pending-hard-stop"],
  )
  assert.deepEqual(
    filterAndSortPrescreenRows(rows, {
      bucket: "all",
      sort: "strict_priority",
      search: "job-growth",
      queue: "all",
      terminal: "all",
      action: "all",
      draft: "all",
    }).map((row) => row.id),
    ["pending-reject"],
  )
  assert.deepEqual(
    filterAndSortPrescreenRows(rows, {
      bucket: "all",
      sort: "strict_priority",
      search: "growth marketer",
      queue: "all",
      terminal: "all",
      action: "all",
      draft: "all",
    }).map((row) => row.id),
    ["pending-reject"],
  )
  // Search matches candidate name (the whole point of attaching candidateName).
  assert.deepEqual(
    filterAndSortPrescreenRows([{ ...rows[0], candidateName: "Surbhit Agrawal" }], {
      bucket: "all",
      sort: "strict_priority",
      search: "surbhit",
      queue: "all",
      terminal: "all",
      action: "all",
      draft: "all",
    }).map((row) => row.id),
    ["pending-reject"],
  )
  assert.deepEqual(
    filterAndSortPrescreenRows(rows, {
      bucket: "all",
      sort: "strict_priority",
      search: "acme",
      queue: "all",
      terminal: "all",
      action: "all",
      draft: "all",
    }).map((row) => row.id),
    ["pending-reject"],
  )
})

test("classifyPrescreenReviewRow treats PAUSE as low-confidence paused state, not likely reject", () => {
  const pausedRow = {
    id: "paused",
    terminal: "PAUSE",
    score: 1.4,
    scoreMax: 3,
    terminalActionPendingReview: false,
    createdAt: "2026-05-25T13:00:00Z",
    jobId: "job-paused",
    userId: "user-paused",
    questions: {
      q_product_design_experience: {
        type: "MUST_HAVE",
        finalS: 0.76,
        finalC: 0.42,
        scored: { aggregate: { summary: "Shared partial design evidence but confidence stayed low." } },
      },
    },
  }

  const paused = classifyPrescreenReviewRow(pausedRow)

  assert.equal(paused.recommendation, "PAUSE")
  assert.equal(paused.bucket, "paused")
  assert.equal(paused.label, "Paused - low confidence")
  assert.doesNotMatch(paused.reasons.join(" "), /likely reject|AI did not propose PASS/i)

  const rejectRow = {
    id: "reject",
    terminal: "PASS",
    score: 2.4,
    scoreMax: 3,
    terminalActionPendingReview: true,
    createdAt: "2026-05-25T14:00:00Z",
    jobId: "job-reject",
    userId: "user-reject",
    questions: {
      q_product_design_experience: {
        type: "MUST_HAVE",
        finalS: 0.7,
        finalC: 0.8,
        scored: { aggregate: { summary: "Helped a team prototype without direct ownership." } },
      },
    },
  }
  const rows = [pausedRow, rejectRow]

  assert.deepEqual(
    filterAndSortPrescreenRows(rows, {
      bucket: "paused",
      sort: "strict_priority",
      search: "",
      terminal: "PAUSE",
      action: "all",
      draft: "all",
    }).map((row) => row.id),
    ["paused"],
  )
  assert.deepEqual(
    filterAndSortPrescreenRows(rows, {
      bucket: "batch_reject",
      sort: "strict_priority",
      search: "",
      terminal: "all",
      action: "all",
      draft: "all",
    }).map((row) => row.id),
    ["reject"],
  )
  assert.equal(summarizePrescreenReviewRows(rows).paused, 1)
})
