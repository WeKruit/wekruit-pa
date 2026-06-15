/**
 * prescreen-ai-question.test.ts — the DEFAULT, role-tailored, non-gating AI-acceleration question.
 *
 * Proves:
 *  (a) role tailoring (SWE / design / unknown→generic) + the seed append on a fresh candidate,
 *  (b) the cross-session SKIP signal (durable tag set → not appended),
 *  (c) NON-GATING: scoring the AI question never changes the PASS/FAIL verdict,
 *  (d) the captured answer would persist (covered in process-tools wiring; here we assert the
 *      seed shape + skip helpers the wiring relies on).
 */
import { strict as assert } from "node:assert"
import { test } from "node:test"
import { buildThinPrescreenSeed } from "./prescreen-config.js"
import {
  AI_QUESTION_QID,
  aiQuestionPromptFor,
  roleFunctionFromJob,
  shouldSkipAiQuestion,
} from "./prescreen-ai-question.js"
import { recordPrescreenScore, type PrescreenState } from "./reducers/prescreen-fsm.js"

const BASE_CONFIG = {
  questions: [
    {
      qId: "q_core",
      type: "MUST_HAVE",
      prompt: { en: "Walk me through a feature you shipped end-to-end." },
      clarifyPrompt: { en: "Your role, the stack, the outcome." },
      keywords: [{ hint: "Shipped a real user-facing feature.", weight: 1, keyword: "shipped" }],
    },
  ],
}

test("aiQuestionPromptFor: SWE role → engineering-tailored prompt", () => {
  const p = aiQuestionPromptFor(["software_engineering"])
  assert.match(p, /engineering work/i)
  assert.match(p, /AI/)
})

test("aiQuestionPromptFor: design role → designer-tailored prompt", () => {
  const p = aiQuestionPromptFor(["creatives_and_design"])
  assert.match(p, /design work/i)
})

test("aiQuestionPromptFor: PM role → product-tailored prompt", () => {
  const p = aiQuestionPromptFor(["product_management"])
  assert.match(p, /product work/i)
})

test("aiQuestionPromptFor: unknown/empty role → clean generic fallback", () => {
  const generic = aiQuestionPromptFor(null)
  assert.match(generic, /day-to-day work/i)
  assert.equal(aiQuestionPromptFor(["not_a_real_role"]), generic)
  assert.equal(aiQuestionPromptFor([]), generic)
})

test("roleFunctionFromJob: reads roleFunction off job doc, then config", () => {
  assert.deepEqual(roleFunctionFromJob({ roleFunction: ["software_engineering"] }, null), [
    "software_engineering",
  ])
  assert.deepEqual(roleFunctionFromJob({ roleFunction: "product_management" }, null), [
    "product_management",
  ])
  assert.deepEqual(roleFunctionFromJob(null, { roleFunction: ["marketing"] }), ["marketing"])
  assert.deepEqual(roleFunctionFromJob(null, null), [])
})

test("buildThinPrescreenSeed: fresh SWE candidate → AI question appended LAST, tailored, informational", () => {
  const seed = buildThinPrescreenSeed(BASE_CONFIG, null, "en", {
    append: true,
    roleFunction: ["software_engineering"],
  })
  assert.deepEqual(seed.questionIds, ["q_core", AI_QUESTION_QID])
  assert.equal(seed.questionIds[seed.questionIds.length - 1], AI_QUESTION_QID, "AI question is LAST")
  assert.match(seed.prompts[AI_QUESTION_QID]!, /engineering work/i)
  assert.ok(seed.judgeContext[AI_QUESTION_QID], "AI question has a judge rubric")
  assert.deepEqual(seed.prescreen.informational, [AI_QUESTION_QID], "AI question is informational")
})

test("buildThinPrescreenSeed: design role → designer-tailored AI prompt in the seed", () => {
  const seed = buildThinPrescreenSeed(BASE_CONFIG, null, "en", {
    append: true,
    roleFunction: ["creatives_and_design"],
  })
  assert.match(seed.prompts[AI_QUESTION_QID]!, /design work/i)
})

test("buildThinPrescreenSeed: unknown role → generic AI prompt in the seed", () => {
  const seed = buildThinPrescreenSeed(BASE_CONFIG, null, "en", { append: true, roleFunction: [] })
  assert.match(seed.prompts[AI_QUESTION_QID]!, /day-to-day work/i)
})

test("buildThinPrescreenSeed: append:false → AI question NOT added", () => {
  const seed = buildThinPrescreenSeed(BASE_CONFIG, null, "en", {
    append: false,
    roleFunction: ["software_engineering"],
  })
  assert.deepEqual(seed.questionIds, ["q_core"])
  assert.equal(seed.prescreen.informational, undefined)
})

test("buildThinPrescreenSeed: no aiQuestion arg → byte-identical legacy seed (no AI question)", () => {
  const seed = buildThinPrescreenSeed(BASE_CONFIG)
  assert.deepEqual(seed.questionIds, ["q_core"])
  assert.equal(seed.prescreen.informational, undefined)
})

test("shouldSkipAiQuestion: durable tag set → skip; absent → ask; prior-scored backup → skip", () => {
  // durable tag object form
  assert.equal(shouldSkipAiQuestion({ aiAccelerationUsage: { value: "I use Cursor daily" } }, false), true)
  // durable tag plain-string form (defensive)
  assert.equal(shouldSkipAiQuestion({ aiAccelerationUsage: "yes" }, false), true)
  // empty value → not a real answer → ask
  assert.equal(shouldSkipAiQuestion({ aiAccelerationUsage: { value: "   " } }, false), false)
  // no tag → ask
  assert.equal(shouldSkipAiQuestion({}, false), false)
  assert.equal(shouldSkipAiQuestion(null, false), false)
  // prior-session scored backup → skip even without the tag
  assert.equal(shouldSkipAiQuestion({}, true), true)
})

// ── NON-GATING proof: the informational AI question never changes PASS/FAIL ──

function seedState(questions: string[], informational: string[]): PrescreenState {
  return { questions, scores: {}, threshold: 0.6, terminal: null, terminalCommits: 0, informational }
}

test("non-gating: a 0-score AI answer does NOT drag a passing screen to FAIL", () => {
  const st = seedState(["q_core", AI_QUESTION_QID], [AI_QUESTION_QID])
  // strong core answer
  let r = recordPrescreenScore(st, "q_core", { score: 0.9 })
  assert.equal(r.ok, true)
  assert.equal(r.terminal, null, "not terminal until the AI question is recorded")
  // terrible AI answer (would tank a plain average to (0.9+0)/2 = 0.45 < 0.6 → FAIL)
  r = recordPrescreenScore(st, AI_QUESTION_QID, { score: 0.0 })
  assert.equal(r.ok, true)
  assert.equal(st.terminal, "PASS", "informational AI score excluded → verdict driven by q_core (0.9)")
})

test("non-gating: a high AI score does NOT rescue a failing screen", () => {
  const st = seedState(["q_core", AI_QUESTION_QID], [AI_QUESTION_QID])
  recordPrescreenScore(st, "q_core", { score: 0.2 }) // weak core
  recordPrescreenScore(st, AI_QUESTION_QID, { score: 1.0 }) // stellar AI usage
  assert.equal(st.terminal, "FAIL", "AI score excluded → verdict driven by q_core (0.2) → FAIL")
})

test("non-gating: identical verdict with vs without the AI question (PASS case)", () => {
  const withAi = seedState(["q_core", AI_QUESTION_QID], [AI_QUESTION_QID])
  recordPrescreenScore(withAi, "q_core", { score: 0.7 })
  recordPrescreenScore(withAi, AI_QUESTION_QID, { score: 0.0 })

  const withoutAi = seedState(["q_core"], [])
  recordPrescreenScore(withoutAi, "q_core", { score: 0.7 })

  assert.equal(withAi.terminal, withoutAi.terminal)
  assert.equal(withAi.terminal, "PASS")
})

test("resume: a session that already scored the AI question carries it (no re-ask)", () => {
  // append:true (tag write hadn't landed yet) but session.scored already has the AI answer
  const seed = buildThinPrescreenSeed(
    BASE_CONFIG,
    { scored: { q_core: { score: 0.8 }, [AI_QUESTION_QID]: { score: 0.5, evidence: "Cursor" } } },
    "en",
    { append: true, roleFunction: ["software_engineering"] },
  )
  assert.ok(AI_QUESTION_QID in seed.prescreen.scores, "carried prior AI score")
  // both scored → next is null → recording is moot; the FSM won't re-ask either.
  const next = seed.prescreen.questions.find((q) => !(q in seed.prescreen.scores))
  assert.equal(next, undefined, "nothing pending — AI question not re-asked")
})
