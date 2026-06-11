/**
 * v1.8 Phase 78 — PrescreenConfig schema tests.
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  PrescreenConfigSchema,
  configMaxScore,
  configRequiredScore,
  configToStateQuestions,
  parsePrescreenConfig,
  safeParsePrescreenConfig,
} from "../config.js"

const validQuestion = {
  qId: "q_react_experience",
  type: "MUST_HAVE" as const,
  weight: 2,
  prompt: { zh: "请描述你的 React 经验", en: "Describe your React experience" },
  clarifyPrompt: {
    zh: "为了准确评估，能否更具体一点",
    en: "For accurate evaluation, could you be more specific",
  },
  keywords: [
    { keyword: "react", weight: 2 },
    { keyword: "production", weight: 1 },
  ],
}

const validConfig = {
  version: 1 as const,
  jobTitle: "Senior Frontend Engineer",
  company: "WeKruit",
  threshold: 0.65,
  confidenceThreshold: 0.7,
  maxClarifyRounds: 2,
  voiceMode: "professional_prescreen" as const,
  questions: [validQuestion],
}

// ════════════════════════════════════════════════════════════════════════════
// Strict parse
// ════════════════════════════════════════════════════════════════════════════

test("Phase 78: parsePrescreenConfig accepts a valid config", () => {
  const cfg = parsePrescreenConfig(validConfig)
  assert.equal(cfg.jobTitle, "Senior Frontend Engineer")
  assert.equal(cfg.questions.length, 1)
  assert.equal(cfg.questions[0].qId, "q_react_experience")
})

test("Phase 78: parsePrescreenConfig applies defaults", () => {
  const minimal = {
    jobTitle: "x",
    questions: [
      {
        qId: "q1",
        type: "MUST_HAVE" as const,
        prompt: { zh: "测试", en: "test" },
        clarifyPrompt: { zh: "再说说", en: "say more" },
        keywords: [{ keyword: "a" }],
      },
    ],
  }
  const cfg = parsePrescreenConfig(minimal)
  assert.equal(cfg.threshold, 0.75)
  assert.equal(cfg.confidenceThreshold, 0.7)
  assert.equal(cfg.maxClarifyRounds, 2)
  assert.equal(cfg.voiceMode, "professional_prescreen")
  assert.equal(cfg.questions[0].weight, 1.0)
})

test("Phase 78: parsePrescreenConfig normalizes legacy lenient thresholds to the review floor (0.75 — Adam 2026-06-11)", () => {
  const cfg = parsePrescreenConfig({ ...validConfig, threshold: 0.65 })
  assert.equal(cfg.threshold, 0.75)
  // per-job configs may still choose stricter than the floor
  const strict = parsePrescreenConfig({ ...validConfig, threshold: 0.9 })
  assert.equal(strict.threshold, 0.9)
})

test("Phase 78: parsePrescreenConfig treats blank optional Level 1 fields as absent", () => {
  const cfg = parsePrescreenConfig({
    ...validConfig,
    level1Reveal: {
      applyUrl: " ",
      salaryRange: "",
      nextStepEta: " within 5 business days ",
    },
  })
  assert.deepEqual(cfg.level1Reveal, {
    applyUrl: undefined,
    salaryRange: undefined,
    nextStepEta: "within 5 business days",
  })
})

test("Phase 78: parsePrescreenConfig still rejects non-empty invalid Level 1 URLs", () => {
  assert.throws(() =>
    parsePrescreenConfig({
      ...validConfig,
      level1Reveal: {
        applyUrl: "not-a-url",
      },
    })
  )
})

test("Phase 78: parsePrescreenConfig rejects invalid qId charset", () => {
  assert.throws(() =>
    parsePrescreenConfig({
      ...validConfig,
      questions: [{ ...validQuestion, qId: "Has-Caps-And-Dashes" }],
    })
  )
})

test("Phase 78: parsePrescreenConfig rejects empty keywords", () => {
  assert.throws(() =>
    parsePrescreenConfig({
      ...validConfig,
      questions: [{ ...validQuestion, keywords: [] }],
    })
  )
})

test("Phase 78: parsePrescreenConfig rejects duplicate qIds", () => {
  assert.throws(() =>
    parsePrescreenConfig({
      ...validConfig,
      questions: [validQuestion, validQuestion],
    })
  )
})

test("Phase 78: parsePrescreenConfig rejects out-of-range threshold", () => {
  assert.throws(() => parsePrescreenConfig({ ...validConfig, threshold: 0.1 }))
  assert.throws(() => parsePrescreenConfig({ ...validConfig, threshold: 1.5 }))
})

test("Phase 78: parsePrescreenConfig rejects unknown questionType", () => {
  assert.throws(() =>
    parsePrescreenConfig({
      ...validConfig,
      questions: [{ ...validQuestion, type: "WHATEVER" }],
    })
  )
})

test("Phase 78: parsePrescreenConfig rejects > 20 questions", () => {
  const tooMany = Array.from({ length: 21 }, (_, i) => ({
    ...validQuestion,
    qId: `q_${i}`,
  }))
  assert.throws(() => parsePrescreenConfig({ ...validConfig, questions: tooMany }))
})

// ════════════════════════════════════════════════════════════════════════════
// Safe parse
// ════════════════════════════════════════════════════════════════════════════

test("Phase 78: safeParsePrescreenConfig returns ok:true on valid", () => {
  const r = safeParsePrescreenConfig(validConfig)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.config.jobTitle, "Senior Frontend Engineer")
})

test("Phase 78: safeParsePrescreenConfig returns ok:false on invalid", () => {
  const r = safeParsePrescreenConfig({ jobTitle: "x", questions: [] })
  assert.equal(r.ok, false)
  if (!r.ok) assert.ok(r.error.issues.length > 0)
})

test("Phase 78: safeParsePrescreenConfig does not throw on garbage", () => {
  const r = safeParsePrescreenConfig("not even an object")
  assert.equal(r.ok, false)
})

// ════════════════════════════════════════════════════════════════════════════
// Mapping helpers
// ════════════════════════════════════════════════════════════════════════════

test("Phase 78: configToStateQuestions strips down to {qId, type, weight}", () => {
  const cfg = parsePrescreenConfig({
    ...validConfig,
    questions: [
      { ...validQuestion, qId: "q_a", weight: 3 },
      { ...validQuestion, qId: "q_b", weight: 1, type: "PROBING" as const },
      { ...validQuestion, qId: "q_c", weight: 1, type: "GOOD_TO_HAVE" as const },
    ],
  })
  const mapped = configToStateQuestions(cfg)
  assert.equal(mapped.length, 3)
  assert.deepEqual(mapped[0], { qId: "q_a", type: "MUST_HAVE", weight: 3 })
  assert.deepEqual(mapped[1], { qId: "q_b", type: "PROBING", weight: 1 })
  assert.deepEqual(mapped[2], { qId: "q_c", type: "GOOD_TO_HAVE", weight: 1 })
})

test("Phase 78: configMaxScore sums weights", () => {
  const cfg = parsePrescreenConfig({
    ...validConfig,
    questions: [
      { ...validQuestion, qId: "q1", weight: 2 },
      { ...validQuestion, qId: "q2", weight: 1 },
      { ...validQuestion, qId: "q3", weight: 1.5 },
    ],
  })
  assert.equal(configMaxScore(cfg), 4.5)
})

test("Phase 78: configRequiredScore multiplies threshold × scoreMax", () => {
  const cfg = parsePrescreenConfig({
    ...validConfig,
    threshold: 0.98,
    questions: [
      { ...validQuestion, qId: "q1", weight: 2 },
      { ...validQuestion, qId: "q2", weight: 3 },
    ],
  })
  // 0.98 * 5 = 4.9
  assert.equal(configRequiredScore(cfg), 4.9)
})

test("Phase 78: PrescreenConfigSchema lets author pick ordering (no auto-sort)", () => {
  const cfg = parsePrescreenConfig({
    ...validConfig,
    questions: [
      { ...validQuestion, qId: "q_z", type: "GOOD_TO_HAVE" as const },
      { ...validQuestion, qId: "q_a", type: "MUST_HAVE" as const },
    ],
  })
  // GOOD_TO_HAVE stays first; author intent preserved
  assert.equal(cfg.questions[0].qId, "q_z")
  assert.equal(cfg.questions[0].type, "GOOD_TO_HAVE")
})
