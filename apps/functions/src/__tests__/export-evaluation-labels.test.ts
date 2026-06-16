import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { type EvaluationAttempt, type HumanEvalLabel } from "@pa/core-types"
import {
  buildEvaluationLabelExport,
  normalizeEvaluationLabelRow,
  runExportEvaluationLabels,
} from "../export-evaluation-labels.js"

const NOW = "2026-06-15T00:00:00.000Z"
const ADMIN_AUTH = {
  uid: "operator-1",
  token: { email: "operator@wekruit.com", email_verified: true },
}

function attempt(overrides: Partial<EvaluationAttempt> = {}): EvaluationAttempt {
  return {
    schemaVersion: 1,
    attemptId: overrides.attemptId ?? "attempt-1",
    source: overrides.source ?? "prescreen",
    purpose: overrides.purpose ?? "employment_prescreen",
    candidateId: overrides.candidateId ?? "cand-1",
    jobId: overrides.jobId ?? "job-1",
    prescreenSessionId: overrides.prescreenSessionId ?? "ps-1",
    rubricVersion: overrides.rubricVersion ?? "rubric-v1",
    algorithmVersion: "screening-eval-v1",
    evaluator: { kind: "hybrid" },
    dimensions: [],
    gates: [],
    weightedFitScore: 0.8,
    evidenceConfidence: 0.8,
    missingEvidence: [],
    riskFlags: [],
    proposedOutcome: overrides.proposedOutcome ?? { kind: "pass", prescreenTerminal: "PASS" },
    reviewPriority: "low",
    explanation: "Looks good.",
    evidence: [],
    humanReview: overrides.humanReview ?? { status: "pending" },
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function labeled(
  label: Partial<HumanEvalLabel> & Pick<HumanEvalLabel, "decision">,
  attemptOverrides: Partial<EvaluationAttempt> = {},
): EvaluationAttempt {
  return attempt({
    ...attemptOverrides,
    humanReview: {
      status: label.decision === "agree" ? "approved" : "overridden",
      label: {
        errorCategories: [],
        evidenceRefs: [],
        labeledBy: "operator-1",
        labeledAt: NOW,
        rubricVersion: "rubric-v1",
        ...label,
      },
    },
  })
}

// The in-memory Firestore fake exposes only `.doc()` — the export's paginated
// reader needs `.where()/.orderBy()/.startAfter()`, so we drive the pure handler
// through the `loadAttempts` test seam (production omits it and paginates).
function makeDb(): Firestore {
  return { collection: () => ({}) } as unknown as Firestore
}

test("only attempts with a humanReview.label are exported", async () => {
  const attempts = [
    labeled({ decision: "agree", qualityRating: 5 }, { attemptId: "a-1" }),
    attempt({ attemptId: "a-2", humanReview: { status: "pending" } }), // no label → excluded
    attempt({ attemptId: "a-3", humanReview: { status: "approved" } }), // approved but no label → excluded
    labeled({ decision: "disagree", rationale: "wrong", errorCategories: ["over_lenient"] }, { attemptId: "a-4" }),
  ]

  const result = await runExportEvaluationLabels({}, ADMIN_AUTH, {
    db: makeDb(),
    now: () => NOW,
    loadAttempts: async () => attempts,
  })

  assert.equal(result.ok, true)
  assert.equal(result.aggregate.totalLabeled, 2)
  assert.deepEqual(
    result.rows.map((r) => r.attemptId).sort(),
    ["a-1", "a-4"],
  )
  // JSONL has exactly one line per exported row and round-trips.
  const lines = result.jsonl.split("\n")
  assert.equal(lines.length, 2)
  const parsed = JSON.parse(lines[0]) as { attemptId: string; agreed: boolean }
  assert.ok(["a-1", "a-4"].includes(parsed.attemptId))
})

test("agreed flag tracks decision === 'agree' and the AI verdict is preserved next to the label", () => {
  const agree = normalizeEvaluationLabelRow(labeled({ decision: "agree" }, { attemptId: "ag" }))
  const partial = normalizeEvaluationLabelRow(labeled({ decision: "partial", rationale: "mostly" }, { attemptId: "pa" }))
  const disagree = normalizeEvaluationLabelRow(
    labeled(
      { decision: "disagree", rationale: "no", correctedOutcome: { kind: "reject", prescreenTerminal: "FAIL" } },
      { attemptId: "di", proposedOutcome: { kind: "pass", prescreenTerminal: "PASS" } },
    ),
  )

  assert.equal(agree?.agreed, true)
  assert.equal(partial?.agreed, false)
  assert.equal(disagree?.agreed, false)
  // AI proposal coexists with the human-corrected verdict (additive, never overwritten).
  assert.deepEqual(disagree?.aiOutcome, { kind: "pass", prescreenTerminal: "PASS" })
  assert.deepEqual(disagree?.humanLabel.correctedOutcome, { kind: "reject", prescreenTerminal: "FAIL" })
  // A null is returned for an attempt with no label.
  assert.equal(normalizeEvaluationLabelRow(attempt({ humanReview: { status: "pending" } })), null)
})

test("per-source agreeRate is correct", () => {
  const attempts = [
    // prescreen: 2 of 3 agree → 0.6667
    labeled({ decision: "agree" }, { attemptId: "p1", source: "prescreen" }),
    labeled({ decision: "agree" }, { attemptId: "p2", source: "prescreen" }),
    labeled({ decision: "disagree", rationale: "x" }, { attemptId: "p3", source: "prescreen" }),
    // recruiter_submission: 0 of 2 agree → 0
    labeled({ decision: "partial", rationale: "y" }, { attemptId: "r1", source: "recruiter_submission", purpose: "candidate_job_fit" }),
    labeled({ decision: "disagree", rationale: "z" }, { attemptId: "r2", source: "recruiter_submission", purpose: "candidate_job_fit" }),
    // external_supply: 1 of 1 agree → 1
    labeled({ decision: "agree" }, { attemptId: "e1", source: "external_supply", purpose: "candidate_job_fit" }),
  ]

  const built = buildEvaluationLabelExport(attempts, {}, NOW)

  assert.equal(built.aggregate.totalLabeled, 6)
  assert.equal(built.aggregate.agreeCount, 3)
  assert.equal(built.aggregate.agreeRate, 0.5)
  assert.equal(built.aggregate.perSource.prescreen.total, 3)
  assert.equal(built.aggregate.perSource.prescreen.agreeCount, 2)
  assert.equal(built.aggregate.perSource.prescreen.agreeRate, 0.6667)
  assert.equal(built.aggregate.perSource.recruiter_submission.agreeRate, 0)
  assert.equal(built.aggregate.perSource.external_supply.agreeRate, 1)
  // No source key exists for a source with zero labeled rows.
  assert.equal(built.aggregate.perSource.practice_question, undefined)
})

test("quality histogram + top error categories are tallied; goldOnly filters", () => {
  const attempts = [
    labeled({ decision: "agree", qualityRating: 5, isGoldSample: true }, { attemptId: "g1" }),
    labeled({ decision: "disagree", rationale: "a", qualityRating: 2, errorCategories: ["over_strict", "missed_evidence"] }, { attemptId: "n1" }),
    labeled({ decision: "disagree", rationale: "b", qualityRating: 2, errorCategories: ["over_strict"] }, { attemptId: "n2" }),
    labeled({ decision: "partial", rationale: "c", errorCategories: ["missed_evidence"] }, { attemptId: "n3" }), // no qualityRating
  ]

  const all = buildEvaluationLabelExport(attempts, {}, NOW)
  assert.deepEqual(all.aggregate.qualityHistogram, { "5": 1, "2": 2 })
  // over_strict=2 ranks above missed_evidence=2 only by alpha tiebreak (m < o) → missed_evidence first.
  assert.deepEqual(all.aggregate.topErrorCategories, [
    { category: "missed_evidence", count: 2 },
    { category: "over_strict", count: 2 },
  ])
  assert.equal(all.aggregate.goldCount, 1)

  const goldOnly = buildEvaluationLabelExport(attempts, { goldOnly: true }, NOW)
  assert.equal(goldOnly.aggregate.totalLabeled, 1)
  assert.equal(goldOnly.rows[0]?.attemptId, "g1")
  assert.equal(goldOnly.rows[0]?.humanLabel.isGoldSample, true)
})

test("admin gate rejects a non-wekruit caller", async () => {
  await assert.rejects(
    () =>
      runExportEvaluationLabels({}, { uid: "x", token: { email: "x@gmail.com" } }, {
        db: makeDb(),
        loadAttempts: async () => [],
      }),
    /admin/i,
  )
})
