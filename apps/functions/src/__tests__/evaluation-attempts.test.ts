import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  type EvaluationAttempt,
} from "@pa/core-types"
import {
  runDraftPrescreenReviewMessages,
  runReviewEvaluationAttempt,
} from "../evaluation-attempts.js"

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
          async update(value: unknown) {
            const prev = (col.get(id) ?? {}) as Record<string, unknown>
            col.set(id, { ...prev, ...(value as Record<string, unknown>) })
          },
        }
      },
    }
  }
  return { db: { collection } as unknown as Firestore, store }
}

test("operator approval requires a candidate message for prescreen review", async () => {
  const { db } = makeDb({
    [PA_COLLECTIONS.evaluationAttempts]: { "attempt-1": attempt() },
    "pa-prescreen-sessions": { "ps-1": { e164: "+15555550100" } },
    [PA_COLLECTIONS.correctionEvents]: {},
  })

  await assert.rejects(
    () =>
      runReviewEvaluationAttempt(
        { attemptId: "attempt-1", status: "approved" },
        ADMIN_AUTH,
        { db, now: () => NOW },
      ),
    /candidateMessageBody/i,
  )
})

test("operator approval commits prescreen state and queues exactly the approved candidate message", async () => {
  const { db, store } = makeDb({
    [PA_COLLECTIONS.evaluationAttempts]: { "attempt-1": attempt() },
    "pa-prescreen-sessions": { "ps-1": { sessionId: "ps-1", e164: "+15555550100", terminalActionPendingReview: true } },
    [PA_COLLECTIONS.correctionEvents]: {},
  })
  const outcomeCalls: Array<Record<string, unknown>> = []
  const sent: Array<Record<string, unknown>> = []
  const approvedBody = "Thanks for the detail here. WeKruit reviewed your first screen and wants to move you forward for the next step."

  const result = await runReviewEvaluationAttempt(
    {
      attemptId: "attempt-1",
      status: "approved",
      candidateMessageBody: approvedBody,
      decisionReason: "The screen showed enough direct ownership for this role.",
      recommendedActions: ["Watch for the next WeKruit text.", "Keep your profile details current."],
    },
    ADMIN_AUTH,
    {
      db,
      now: () => NOW,
      markPrescreenOutcome: async (args) => {
        outcomeCalls.push(args as unknown as Record<string, unknown>)
        return { changed: true } as never
      },
      sendSms: async (args) => {
        sent.push(args as unknown as Record<string, unknown>)
        return { outboundId: "out-approved-message", created: true }
      },
    },
  )

  assert.equal(result.prescreenOutcomeCommitted, true)
  assert.equal(result.candidateOutboundId, "out-approved-message")
  assert.deepEqual(result.candidateDecision, {
    candidateMessageBody: approvedBody,
    decisionReason: "The screen showed enough direct ownership for this role.",
    recommendedActions: ["Watch for the next WeKruit text.", "Keep your profile details current."],
    finalTerminal: "PASS",
    reviewedAt: NOW,
    decisionOutboundId: "out-approved-message",
  })
  assert.equal(outcomeCalls.length, 1)
  assert.equal(outcomeCalls[0]?.terminal, "PASS")
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.content, approvedBody)
  assert.equal(sent[0]?.runtimeSource, "pa_operator_review")
  const saved = store.get(PA_COLLECTIONS.evaluationAttempts)!.get("attempt-1") as EvaluationAttempt
  assert.equal(saved.humanReview.status, "approved")
  const session = store.get("pa-prescreen-sessions")!.get("ps-1") as Record<string, unknown>
  assert.equal(session.terminalActionPendingReview, false)
  assert.equal((session.review as { status?: string; decisionOutboundId?: string } | undefined)?.status, "approved")
  assert.equal((session.review as { status?: string; decisionOutboundId?: string } | undefined)?.decisionOutboundId, "out-approved-message")
  assert.deepEqual(
    (session.review as { candidateDecision?: unknown } | undefined)?.candidateDecision,
    {
      candidateMessageBody: approvedBody,
      decisionReason: "The screen showed enough direct ownership for this role.",
      recommendedActions: ["Watch for the next WeKruit text.", "Keep your profile details current."],
      finalTerminal: "PASS",
      reviewedAt: NOW,
      decisionOutboundId: "out-approved-message",
    },
  )
})

test("operator approval accepts terminal-only prescreen outcome and derives canonical outcome kind", async () => {
  const { db } = makeDb({
    [PA_COLLECTIONS.evaluationAttempts]: { "attempt-1": attempt() },
    "pa-prescreen-sessions": { "ps-1": { sessionId: "ps-1", e164: "+15555550100", terminalActionPendingReview: true } },
    [PA_COLLECTIONS.correctionEvents]: {},
  })

  const result = await runReviewEvaluationAttempt(
    {
      attemptId: "attempt-1",
      status: "overridden",
      finalOutcome: { prescreenTerminal: "FAIL" },
      candidateMessageBody: "WeKruit reviewed the screen. This specific role is not the right fit, but we will keep you in mind for better matches.",
    },
    ADMIN_AUTH,
    {
      db,
      now: () => NOW,
      markPrescreenOutcome: async () => ({ changed: true }) as never,
      sendSms: async () => ({ outboundId: "out-terminal-only", created: true }),
    },
  )

  assert.equal(result.finalOutcome?.kind, "reject")
  assert.equal(result.finalOutcome?.prescreenTerminal, "FAIL")
  assert.equal(result.candidateOutboundId, "out-terminal-only")
})

test("operator can draft prescreen review messages without committing state or sending outbound", async () => {
  const { db, store } = makeDb({
    [PA_COLLECTIONS.evaluationAttempts]: { "attempt-1": attempt() },
    "pa-prescreen-sessions": {
      "ps-1": {
        sessionId: "ps-1",
        userId: "cand-1",
        jobId: "job-1",
        terminal: "PASS",
        terminalActionPendingReview: true,
        evaluationAttemptId: "attempt-1",
        score: 2.7,
        scoreMax: 3,
        threshold: 0.8,
      },
    },
    [PA_COLLECTIONS.correctionEvents]: {},
  })
  const contexts: Array<Record<string, unknown>> = []

  const result = await runDraftPrescreenReviewMessages(
    { sessionIds: ["ps-1"], terminal: "FAIL" },
    ADMIN_AUTH,
    {
      db,
      loadTurns: async () => [
        {
          qId: "gtm_growth",
          reply: "I mostly worked on lifecycle campaigns, not enterprise GTM.",
          scored: { aggregate: { s: 0.35, c: 0.8, summary: "Partial GTM overlap only." } },
        },
      ],
      composeDraft: async (context) => {
        contexts.push(context as unknown as Record<string, unknown>)
        return {
          candidateMessageBody:
            "Thanks for completing the screen. We reviewed it, and this role does not look like the right next step because the GTM-growth evidence was still partial.",
          decisionReason: "The GTM-growth evidence was still partial for this role.",
          recommendedActions: ["Add a direct GTM growth example to your profile.", "Keep your profile active for stronger matches."],
          evidenceSummary: "Partial GTM overlap only.",
        }
      },
    },
  )

  assert.equal(result.ok, true)
  assert.equal(result.drafts.length, 1)
  assert.equal(result.drafts[0]?.sessionId, "ps-1")
  assert.equal(result.drafts[0]?.attemptId, "attempt-1")
  assert.equal(result.drafts[0]?.finalTerminal, "FAIL")
  assert.match(result.drafts[0]?.candidateMessageBody ?? "", /GTM-growth evidence/)
  assert.match(result.drafts[0]?.decisionReason ?? "", /GTM-growth evidence/)
  assert.deepEqual(result.drafts[0]?.recommendedActions, [
    "Add a direct GTM growth example to your profile.",
    "Keep your profile active for stronger matches.",
  ])
  assert.equal(contexts[0]?.finalTerminal, "FAIL")
  const session = store.get("pa-prescreen-sessions")!.get("ps-1") as Record<string, unknown>
  assert.equal(session.terminalActionPendingReview, true)
  assert.equal(store.get(PA_COLLECTIONS.correctionEvents)!.size, 0)
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
