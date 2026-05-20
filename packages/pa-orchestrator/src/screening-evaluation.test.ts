import assert from "node:assert/strict"
import test from "node:test"
import type {
  CandidateCompanyJobEvaluation,
  PracticeQuestionBankItem,
} from "@pa/core-types"
import type { PreScreenState } from "./prescreen/state.js"
import {
  externalSupplyEvalToEvaluationAttempt,
  practiceQuestionToEvaluationAttempt,
  prescreenSessionToEvaluationAttempt,
} from "./screening-evaluation.js"

const NOW = "2026-05-20T00:00:00.000Z"

test("prescreen adapter preserves terminal as proposed outcome and maps scored evidence", () => {
  const state: PreScreenState = {
    sessionId: "ps-1",
    userId: "cand-1",
    jobId: "job-1",
    currentQId: null,
    questions: {
      react: {
        qId: "react",
        type: "MUST_HAVE",
        weight: 2,
        matchThreshold: 0.85,
        clarifyRounds: 0,
        scored: {
          kind: "scored",
          answered: true,
          perKeyword: [
            {
              keyword: "React",
              match: 0.9,
              confidence: 0.86,
              evidence: "I shipped React dashboards.",
              reasoning: "Specific frontend evidence.",
            },
          ],
          aggregate: { s: 0.9, c: 0.86, summary: "Strong React experience." },
        },
        finalS: 0.9,
        finalC: 0.86,
        answeredAt: NOW,
      },
    },
    qOrder: ["react"],
    score: 1.8,
    scoreMax: 2,
    threshold: 0.65,
    confidenceThreshold: 0.7,
    maxClarifyRounds: 2,
    terminal: "PASS",
    createdAt: NOW,
    updatedAt: NOW,
  }

  const attempt = prescreenSessionToEvaluationAttempt({
    state,
    terminal: "PASS",
    nowIso: NOW,
  })

  assert.equal(attempt.source, "prescreen")
  assert.equal(attempt.proposedOutcome.prescreenTerminal, "PASS")
  assert.equal(attempt.humanReview.status, "pending")
  assert.equal(attempt.dimensions[0]?.score, 4)
  assert.equal(attempt.gates[0]?.status, "pass")
  assert.equal(attempt.evidence[0]?.quote, "I shipped React dashboards.")
})

test("practice adapter creates feedback-only artifact from question rubric", () => {
  const question: PracticeQuestionBankItem = {
    schemaVersion: 1,
    id: "pq-1",
    status: "active",
    kind: "behavioral",
    conversationMode: "behavioral_screen",
    title: "Ownership",
    prompt: "Tell me about ownership.",
    companyStyle: [],
    roleFamilies: [],
    categories: [],
    tags: [],
    keyConcepts: [],
    evaluation: {
      rubric: [{ criterion: "Impact", weight: 2, guidance: "Look for measurable impact." }],
      followUps: ["What changed?"],
      expectedSignals: ["metric"],
      redFlags: ["vague"],
    },
    sourceRefs: ["test"],
    contentFingerprint: "fp",
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: "test",
    updatedBy: "test",
  }

  const attempt = practiceQuestionToEvaluationAttempt({ question, nowIso: NOW, answerText: "I led a migration." })
  assert.equal(attempt.purpose, "interview_practice")
  assert.equal(attempt.proposedOutcome.kind, "practice_feedback")
  assert.equal(attempt.dimensions[0]?.label, "Impact")
  assert.equal(attempt.riskFlags[0], "vague")
})

test("external supply adapter maps gates, tier, and reviewer decision", () => {
  const row: CandidateCompanyJobEvaluation = {
    evaluationId: "eval-1",
    candidateId: "cand-1",
    companyId: "company-1",
    jobId: "job-1",
    evaluationRunId: "run-1",
    rubricVersion: "rubric-v1",
    generalRubricScore: 0.7,
    companyRubricScore: 0.6,
    jobRubricScore: 0.8,
    hardGateResult: "soft_block",
    hardGateReasons: ["location unclear"],
    softScore: 0.72,
    missingInfo: ["location"],
    risks: ["thin_location"],
    evidence: [{ source: "external_sourcing", summary: "Profile matched title", refId: "record-1" }],
    explanation: "Good fit but location unclear.",
    proposedTier: "tier_2_personal_email",
    reviewerDecision: {
      finalTier: "tier_3_general_email",
      reviewer: "operator@wekruit.com",
      reviewedAt: NOW,
      note: "Lower touch until location confirmed.",
    },
    createdAt: NOW,
  }

  const attempt = externalSupplyEvalToEvaluationAttempt({ evaluation: row, nowIso: NOW })
  assert.equal(attempt.source, "external_supply")
  assert.equal(attempt.gates[0]?.status, "soft_block")
  assert.equal(attempt.proposedOutcome.supplyTier, "tier_2_personal_email")
  assert.equal(attempt.humanReview.status, "approved")
  assert.equal(attempt.humanReview.finalOutcome?.supplyTier, "tier_3_general_email")
})
