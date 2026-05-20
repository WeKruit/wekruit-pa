import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  type EvaluationAttempt,
} from "@pa/core-types"
import { runReviewEvaluationAttempt } from "../evaluation-attempts.js"

const NOW = "2026-05-20T00:00:00.000Z"
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
    rubricVersion: "rubric-v1",
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
    humanReview: { status: "pending" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeDb(seed: Record<string, Record<string, unknown>>): { db: Firestore; store: Map<string, Map<string, unknown>> } {
  const store = new Map<string, Map<string, unknown>>()
  for (const [collection, docs] of Object.entries(seed)) {
    store.set(collection, new Map(Object.entries(docs)))
  }
  function collection(name: string) {
    if (!store.has(name)) store.set(name, new Map())
    const col = store.get(name)!
    return {
      doc(id: string) {
        return {
          async get() {
            const found = col.get(id)
            return { exists: Boolean(found), data: () => found }
          },
          async set(value: unknown, opts?: { merge?: boolean }) {
            const prev = (col.get(id) ?? {}) as Record<string, unknown>
            col.set(id, opts?.merge ? { ...prev, ...(value as Record<string, unknown>) } : value)
          },
        }
      },
    }
  }
  return { db: { collection } as unknown as Firestore, store }
}

test("operator approval commits prescreen terminal action after review", async () => {
  const { db, store } = makeDb({
    [PA_COLLECTIONS.evaluationAttempts]: { "attempt-1": attempt() },
    "pa-prescreen-sessions": { "ps-1": { e164: "+15555550100" } },
    [PA_COLLECTIONS.correctionEvents]: {},
  })
  const terminalCalls: Array<Record<string, unknown>> = []

  const result = await runReviewEvaluationAttempt(
    { attemptId: "attempt-1", status: "approved" },
    ADMIN_AUTH,
    {
      db,
      now: () => NOW,
      runTerminalAction: async (args) => {
        terminalCalls.push(args as unknown as Record<string, unknown>)
        return { alreadyFired: false, level1Sent: true, jobRecsFired: false }
      },
    },
  )

  assert.equal(result.prescreenTerminalActionFired, true)
  assert.equal(terminalCalls.length, 1)
  assert.equal(terminalCalls[0]?.terminal, "PASS")
  const saved = store.get(PA_COLLECTIONS.evaluationAttempts)!.get("attempt-1") as EvaluationAttempt
  assert.equal(saved.humanReview.status, "approved")
})

test("operator override writes correction event and updates external-supply projection", async () => {
  const external = attempt({
    source: "external_supply",
    purpose: "candidate_job_fit",
    prescreenSessionId: undefined,
    externalEvaluationId: "external-eval-1",
    proposedOutcome: { kind: "pass", supplyTier: "tier_2_personal_email" },
  })
  const { db, store } = makeDb({
    [PA_COLLECTIONS.evaluationAttempts]: { "attempt-1": external },
    [PA_COLLECTIONS.candidateCompanyJobEvaluations]: { "external-eval-1": { evaluationId: "external-eval-1" } },
    [PA_COLLECTIONS.correctionEvents]: {},
  })

  const result = await runReviewEvaluationAttempt(
    {
      attemptId: "attempt-1",
      status: "overridden",
      finalOutcome: { kind: "hold", supplyTier: "tier_3_general_email" },
      correctionReason: "operator lowered tier",
    },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )

  assert.equal(result.externalEvaluationUpdated, true)
  assert.equal(Boolean(result.correctionEventId), true)
  assert.equal(store.get(PA_COLLECTIONS.correctionEvents)!.size, 1)
  const projected = store.get(PA_COLLECTIONS.candidateCompanyJobEvaluations)!.get("external-eval-1") as {
    reviewerDecision?: { finalTier?: string }
  }
  assert.equal(projected.reviewerDecision?.finalTier, "tier_3_general_email")
})
