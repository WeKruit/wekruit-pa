import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  type EvaluationAttempt,
  type EvaluationDimensionScore,
} from "@pa/core-types"
import {
  getEvaluationAttempt,
  listEvaluationAttempts,
  saveEvaluationAttempt,
  saveHumanReview,
} from "./evaluation-attempts.js"

const NOW = "2026-05-20T00:00:00.000Z"

function dimension(): EvaluationDimensionScore {
  return {
    dimensionId: "role_fit",
    label: "Role fit",
    criterion: "Shows relevant role-fit evidence.",
    weight: 1,
    score: 3,
    anchor: "meets_bar",
    confidence: 0.8,
    evidenceRefs: ["ev-1"],
    missingEvidence: [],
    rationale: "Candidate gave a relevant example.",
    riskFlags: [],
  }
}

function attempt(overrides: Partial<EvaluationAttempt> = {}): EvaluationAttempt {
  return {
    schemaVersion: 1,
    attemptId: overrides.attemptId ?? "attempt-1",
    source: overrides.source ?? "prescreen",
    purpose: overrides.purpose ?? "employment_prescreen",
    candidateId: overrides.candidateId ?? "cand-1",
    jobId: overrides.jobId ?? "job-1",
    rubricVersion: overrides.rubricVersion ?? "rubric-v1",
    algorithmVersion: overrides.algorithmVersion ?? "screening-eval-v1",
    evaluator: overrides.evaluator ?? { kind: "hybrid" },
    dimensions: overrides.dimensions ?? [dimension()],
    gates: overrides.gates ?? [],
    weightedFitScore: overrides.weightedFitScore ?? 0.75,
    evidenceConfidence: overrides.evidenceConfidence ?? 0.8,
    missingEvidence: overrides.missingEvidence ?? [],
    riskFlags: overrides.riskFlags ?? [],
    proposedOutcome: overrides.proposedOutcome ?? { kind: "pass", prescreenTerminal: "PASS" },
    reviewPriority: overrides.reviewPriority ?? "low",
    explanation: overrides.explanation ?? "Candidate meets the initial bar.",
    evidence: overrides.evidence ?? [{ refId: "ev-1", source: "transcript_turn", summary: "Relevant evidence" }],
    humanReview: overrides.humanReview ?? { status: "pending" },
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
    ...overrides,
  }
}

function makeDb(seed: EvaluationAttempt[] = []): { db: Firestore; store: Map<string, Map<string, unknown>> } {
  const store = new Map<string, Map<string, unknown>>([
    [PA_COLLECTIONS.evaluationAttempts, new Map(seed.map((row) => [row.attemptId, row]))],
    [PA_COLLECTIONS.correctionEvents, new Map()],
  ])

  function collection(name: string) {
    if (!store.has(name)) store.set(name, new Map())
    const col = store.get(name)!
    const filters: Array<{ field: string; value: unknown }> = []
    const query = {
      where(field: string, op: string, value: unknown) {
        assert.equal(op, "==")
        filters.push({ field, value })
        return query
      },
      limit() {
        return query
      },
      async get() {
        const rows = [...col.entries()].filter(([, value]) => {
          const row = value as Record<string, unknown>
          return filters.every((filter) => readPath(row, filter.field) === filter.value)
        })
        return { docs: rows.map(([id, value]) => ({ id, data: () => value })) }
      },
      doc(id: string) {
        return {
          async get() {
            const found = col.get(id)
            return { exists: Boolean(found), data: () => found }
          },
          async set(value: unknown) {
            col.set(id, value)
          },
        }
      },
    }
    return query
  }

  return { db: { collection } as unknown as Firestore, store }
}

function readPath(row: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, part) => {
    if (!value || typeof value !== "object") return undefined
    return (value as Record<string, unknown>)[part]
  }, row)
}

test("save/get/list evaluation attempts", async () => {
  const { db } = makeDb()
  await saveEvaluationAttempt(db, attempt())
  const found = await getEvaluationAttempt(db, "attempt-1")
  assert.equal(found?.attemptId, "attempt-1")
  const rows = await listEvaluationAttempts(db, {
    source: "prescreen",
    humanReviewStatus: "pending",
  })
  assert.deepEqual(rows.map((row) => row.attemptId), ["attempt-1"])
})

test("saveHumanReview writes evaluation_attempt correction event for override", async () => {
  const { db, store } = makeDb([attempt()])
  const result = await saveHumanReview(db, {
    attemptId: "attempt-1",
    reviewer: "operator@wekruit.com",
    nowIso: "2026-05-20T01:00:00.000Z",
    correctionReason: "operator saw stronger evidence",
    review: {
      status: "overridden",
      finalOutcome: { kind: "hold", prescreenTerminal: "FAIL" },
      note: "Needs another look.",
    },
  })

  assert.equal(result.attempt.humanReview.status, "overridden")
  assert.equal(result.attempt.humanReview.reviewer, "operator@wekruit.com")
  assert.equal(result.correctionEvent?.targetType, "evaluation_attempt")
  assert.equal(store.get(PA_COLLECTIONS.correctionEvents)!.size, 1)
})
