/**
 * v1.8 Phase 74 — ScoredJudgeResult + QuestionType + weight tests.
 *
 * Verifies:
 *   1. Discriminated union: isScoredJudgeResult correctly narrows
 *   2. JudgeResult and ScoredJudgeResult coexist (additive, not breaking)
 *   3. makeQuestion defaults type="MUST_HAVE" + weight=1.0 (zero break)
 *   4. Explicit type/weight overrides survive
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  isScoredJudgeResult,
  makeQuestion,
  type JudgeResult,
  type ScoredJudgeResult,
  type Question,
  type QuestionType,
} from "../question.js"

test("Phase 74: isScoredJudgeResult narrows binary JudgeResult to false", () => {
  const binary: JudgeResult<string> = {
    accept: true,
    value: "test@example.com",
    confidence: 0.95,
  }
  assert.equal(isScoredJudgeResult(binary), false)
})

test("Phase 74: isScoredJudgeResult narrows ScoredJudgeResult to true", () => {
  const scored: ScoredJudgeResult<{ answered: boolean }> = {
    kind: "scored",
    answered: true,
    value: { answered: true },
    perKeyword: [
      {
        keyword: "react",
        match: 0.9,
        confidence: 0.85,
        evidence: "shipped 3 production React apps at last role",
        reasoning: "explicit experience mentioned",
      },
    ],
    aggregate: {
      s: 0.9,
      c: 0.85,
      summary: "strong react background, multiple production apps",
    },
  }
  assert.equal(isScoredJudgeResult(scored), true)
  if (isScoredJudgeResult(scored)) {
    assert.equal(scored.perKeyword.length, 1)
    assert.equal(scored.aggregate.s, 0.9)
  }
})

test("Phase 74: ScoredJudgeResult.abortHint surfaces off-topic routing", () => {
  const scored: ScoredJudgeResult = {
    kind: "scored",
    answered: false,
    perKeyword: [],
    aggregate: { s: 0, c: 0.9, summary: "candidate went off-topic" },
    abortHint: { kind: "off_topic", reason: "asked about salary instead" },
  }
  assert.equal(scored.abortHint?.kind, "off_topic")
})

const baseSpec: Question<string> = {
  id: "q_test",
  prompt: { zh: "测试", en: "test" },
  judge: {
    kind: "test",
    async judge() {
      return { accept: true, value: "ok" }
    },
  },
  rephraser: {
    kind: "test",
    async rephrase() {
      return "rephrased"
    },
  },
}

test("Phase 74: makeQuestion defaults type to MUST_HAVE", () => {
  const q = makeQuestion(baseSpec)
  assert.equal(q.type, "MUST_HAVE")
})

test("Phase 74: makeQuestion defaults weight to 1.0", () => {
  const q = makeQuestion(baseSpec)
  assert.equal(q.weight, 1.0)
})

test("Phase 74: makeQuestion preserves explicit type=PROBING override", () => {
  const q = makeQuestion({ ...baseSpec, type: "PROBING" })
  assert.equal(q.type, "PROBING")
})

test("Phase 74: makeQuestion preserves explicit weight=2.5 override", () => {
  const q = makeQuestion({ ...baseSpec, weight: 2.5 })
  assert.equal(q.weight, 2.5)
})

test("Phase 74: makeQuestion preserves maxAttempts=5 default (no regression)", () => {
  const q = makeQuestion(baseSpec)
  assert.equal(q.maxAttempts, 5)
})

test("Phase 74: supports all three QuestionType values", () => {
  const types: QuestionType[] = ["MUST_HAVE", "PROBING", "GOOD_TO_HAVE"]
  for (const t of types) {
    const q = makeQuestion({ ...baseSpec, type: t })
    assert.equal(q.type, t)
  }
})
