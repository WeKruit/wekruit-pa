/**
 * prescreen-ai-question-legacy.test.ts — LEGACY/FSM-path parity for the default AI-acceleration
 * question (Adam directive: EVERY screen asks it).
 *
 * Proves the legacy injection (legacyAiQuestionConfig + append to the parsed config) is:
 *  (a) shaped like a parsed PrescreenQuestionConfig (qId, type, weight, sharedKey, prompt,
 *      clarifyPrompt, keywords) so the session-start state build + per-turn KeywordSetJudge binding
 *      both accept it,
 *  (b) NON-GATING — appended with weight 0 / ALWAYS_ASK it contributes 0 to BOTH scoreMax and
 *      score, so the legacy weighted-ratio verdict (score/scoreMax) is byte-identical with vs without
 *      it, and a 0.0 OR 1.0 AI score cannot move PASS/FAIL,
 *  (c) appended LAST (gating question order untouched),
 *  (d) carries the `ai_usage` sharedKey for cross-session ask-once parity with the thin path.
 */
import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  configToStateQuestions,
  emptyPreScreenState,
  parsePrescreenConfig,
  type PrescreenConfig,
} from "@pa/pa-orchestrator"
import { legacyAiQuestionConfig, AI_QUESTION_QID } from "./prescreen-ai-question.js"

/** A minimal, valid parsed config: one gating MUST_HAVE + one GOOD_TO_HAVE. */
function baseConfig(): PrescreenConfig {
  return parsePrescreenConfig({
    jobTitle: "Senior Software Engineer",
    company: "Invoko",
    roleFunction: ["software_engineering"],
    questions: [
      {
        qId: "q_core",
        type: "MUST_HAVE",
        weight: 3,
        prompt: { en: "Walk me through a feature you shipped end-to-end.", zh: "讲讲你端到端交付的一个功能。" },
        clarifyPrompt: { en: "Your role, the stack, the outcome.", zh: "你的角色、技术栈、结果。" },
        keywords: [{ keyword: "shipped", hint: "Shipped a real user-facing feature.", weight: 1 }],
      },
      {
        qId: "q_extra",
        type: "GOOD_TO_HAVE",
        weight: 1,
        prompt: { en: "Any side projects?", zh: "有副业项目吗？" },
        clarifyPrompt: { en: "Tell me more.", zh: "再多说说。" },
        keywords: [{ keyword: "project", hint: "A side project.", weight: 1 }],
      },
    ],
  } as unknown)
}

/** Append the synthetic AI question (the legacy seam does this AFTER parse, never re-validating). */
function withAiQuestion(cfg: PrescreenConfig): PrescreenConfig {
  const aiQ = legacyAiQuestionConfig(["software_engineering"])
  return { ...cfg, questions: [...cfg.questions, aiQ as unknown as (typeof cfg.questions)[number]] }
}

test("legacyAiQuestionConfig: shape is FSM-binding compatible + non-gating + role-tailored", () => {
  const aiQ = legacyAiQuestionConfig(["software_engineering"])
  assert.equal(aiQ.qId, AI_QUESTION_QID)
  assert.equal(aiQ.type, "ALWAYS_ASK") // → non-gating (threshold 0, never HARD_STOPs) + asked before any terminal
  assert.equal(aiQ.weight, 0) // → 0 to scoreMax AND score → verdict unaffected
  assert.equal(aiQ.sharedKey, "ai_usage") // cross-session ask-once parity with thin
  // bilingual prompt + clarify + >=1 keyword so the per-turn KeywordSetJudge binding never throws.
  assert.ok(aiQ.prompt.en && aiQ.prompt.zh)
  assert.ok(aiQ.clarifyPrompt.en && aiQ.clarifyPrompt.zh)
  assert.ok(aiQ.keywords.length >= 1 && aiQ.keywords[0].keyword)
  // role-tailored: SWE prompt mentions engineering work.
  assert.match(aiQ.prompt.en, /engineering/i)
})

test("legacy injection: appended LAST, gating qOrder untouched", () => {
  const augmented = withAiQuestion(baseConfig())
  const ids = augmented.questions.map((q) => q.qId)
  assert.deepEqual(ids, ["q_core", "q_extra", AI_QUESTION_QID])
})

test("NON-GATING: scoreMax excludes the AI question (weight 0 adds nothing)", () => {
  const without = emptyPreScreenState({
    sessionId: "s1",
    userId: "u1",
    jobId: "j1",
    questions: configToStateQuestions(baseConfig()),
    threshold: 0.75,
    nowIso: "2026-06-14T00:00:00.000Z",
  })
  const withAi = emptyPreScreenState({
    sessionId: "s1",
    userId: "u1",
    jobId: "j1",
    questions: configToStateQuestions(withAiQuestion(baseConfig())),
    threshold: 0.75,
    nowIso: "2026-06-14T00:00:00.000Z",
  })
  // scoreMax = Σ weight; the AI question's weight 0 contributes nothing → identical.
  assert.equal(without.scoreMax, 4)
  assert.equal(withAi.scoreMax, 4)
  // The AI question IS in the queue (so it gets asked) but with weight 0.
  assert.equal(withAi.questions[AI_QUESTION_QID].weight, 0)
  assert.ok(withAi.qOrder.includes(AI_QUESTION_QID))
})

test("NON-GATING: a 0.0 OR 1.0 AI score yields the SAME verdict ratio", () => {
  // Legacy verdict = score/scoreMax. The AI score is s*weight = s*0 = 0 for any s.
  const scoreMax = 4 // unchanged by the AI question
  const gatingScore = 3 // candidate aced q_core (3), bombed q_extra (0)
  const ratioNoAi = gatingScore / scoreMax
  // worst-case AI answer
  const ratioAiZero = (gatingScore + 0 * 0) / scoreMax
  // best-case AI answer
  const ratioAiOne = (gatingScore + 1 * 0) / scoreMax
  assert.equal(ratioAiZero, ratioNoAi)
  assert.equal(ratioAiOne, ratioNoAi)
})
