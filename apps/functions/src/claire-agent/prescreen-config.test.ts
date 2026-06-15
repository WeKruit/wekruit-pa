/**
 * config→thin-store seam (task #13). Proves a real pa-jobs prescreenConfig (Helium-shaped) maps into
 * the thin PrescreenState + probing prompts + per-question judge rubric, and that a resumed session
 * keeps prior scores + a committed terminal.
 */
import { strict as assert } from "node:assert"
import { test } from "node:test"
import { buildThinPrescreenSeed } from "./prescreen-config.js"
import { DEFAULT_PRESCREEN_THRESHOLD } from "./reducers/prescreen-fsm.js"

// Trimmed shape of the live Helium config (pa-jobs/helium-product-engineer-fullstack.prescreenConfig).
const HELIUM_CONFIG = {
  questions: [
    {
      qId: "q_fullstack_evidence",
      weight: 2,
      type: "MUST_HAVE",
      prompt: { zh: "讲讲你最近...", en: "Walk me through a feature you shipped end-to-end recently." },
      clarifyPrompt: { zh: "具体...", en: "Specific feature, your role on it, the stack you used." },
      keywords: [
        { hint: "Has personally shipped a user-facing feature touching both frontend and backend.", weight: 1, keyword: "full_stack" },
        { hint: "Modern web stack (TypeScript/JavaScript ideally).", weight: 1, keyword: "web_stack" },
      ],
    },
    {
      qId: "q_ownership",
      weight: 1,
      type: "NICE_TO_HAVE",
      prompt: { en: "Tell me about something you owned end-to-end and shipped." },
      clarifyPrompt: { en: "Scope, decisions you made, the outcome." },
      keywords: [{ hint: "Demonstrates real ownership and shipped outcomes.", weight: 1, keyword: "ownership" }],
    },
  ],
}

test("buildThinPrescreenSeed: maps a Helium-shaped config → questionIds + prompts + judge rubric", () => {
  const seed = buildThinPrescreenSeed(HELIUM_CONFIG)
  assert.deepEqual(seed.questionIds, ["q_fullstack_evidence", "q_ownership"])
  assert.deepEqual(seed.prescreen.questions, ["q_fullstack_evidence", "q_ownership"])
  assert.equal(seed.prescreen.threshold, DEFAULT_PRESCREEN_THRESHOLD)
  assert.equal(seed.prescreen.terminal, null)
  assert.deepEqual(seed.prescreen.scores, {})
  // prompts = the canonical question text (English), the DIRECTION the agent grounds + probes on.
  assert.match(seed.prompts.q_fullstack_evidence!, /end-to-end recently/i)
  // judgeContext = the rubric the judge scores against (keyword hints + clarify cue) — keeps probing on-rubric.
  assert.match(seed.judgeContext.q_fullstack_evidence!, /frontend and backend/i)
  assert.match(seed.judgeContext.q_fullstack_evidence!, /Probe for: Specific feature/i)
})

test("buildThinPrescreenSeed: resumed session keeps prior scores (no re-ask) + committed terminal", () => {
  const seed = buildThinPrescreenSeed(HELIUM_CONFIG, {
    scored: { q_fullstack_evidence: { score: 0.8, evidence: "shipped checkout w/ React + Node" } },
    terminal: null,
  })
  assert.deepEqual(Object.keys(seed.prescreen.scores), ["q_fullstack_evidence"])
  assert.equal(seed.prescreen.scores.q_fullstack_evidence!.score, 0.8)
  assert.equal(seed.prescreen.scores.q_fullstack_evidence!.evidence, "shipped checkout w/ React + Node")

  const terminalSeed = buildThinPrescreenSeed(HELIUM_CONFIG, {
    scored: { q_fullstack_evidence: { score: 0.9 }, q_ownership: { score: 0.7 } },
    terminal: "PASS",
  })
  assert.equal(terminalSeed.prescreen.terminal, "PASS")
  assert.equal(terminalSeed.prescreen.terminalCommits, 1)
})

test("buildThinPrescreenSeed: empty/missing config degrades, never throws", () => {
  for (const bad of [null, undefined, {}, { questions: "nope" }, { questions: [{}] }]) {
    const seed = buildThinPrescreenSeed(bad as Record<string, unknown> | null)
    assert.deepEqual(seed.questionIds, [])
    assert.equal(seed.prescreen.terminal, null)
    assert.equal(seed.prescreen.threshold, DEFAULT_PRESCREEN_THRESHOLD)
  }
})

test("buildThinPrescreenSeed: zh lang picks Mandarin prompt", () => {
  const seed = buildThinPrescreenSeed(HELIUM_CONFIG, null, "zh")
  assert.match(seed.prompts.q_fullstack_evidence!, /讲讲你最近/)
})

// ── SPEC §5a/§7 — cross-session shared-answer carry-over ──────────────────────

const SHARED_CONFIG = {
  threshold: 0.6,
  questions: [
    {
      qId: "q_fullstack_evidence",
      weight: 2,
      type: "MUST_HAVE",
      prompt: { en: "Walk me through a feature you shipped end-to-end." },
      clarifyPrompt: { en: "Specific feature, your role, the stack." },
      keywords: [{ hint: "shipped full-stack feature", keyword: "full_stack" }],
    },
    {
      qId: "q_ai_native",
      weight: 1,
      type: "GOOD_TO_HAVE",
      sharedKey: "ai_usage",
      prompt: { en: "How do you use AI in your work?" },
      clarifyPrompt: { en: "Tools, workflows, examples." },
      keywords: [{ hint: "concrete AI tooling", keyword: "ai_tools" }],
    },
  ],
}

test("SPEC §5a: an authored sharedKey on a config question is captured in seed.sharedKeys", () => {
  const seed = buildThinPrescreenSeed(SHARED_CONFIG)
  assert.equal(seed.sharedKeys["q_ai_native"], "ai_usage")
  assert.equal(seed.sharedKeys["q_fullstack_evidence"], undefined)
})

test("SPEC §5a: the appended AI question carries sharedKey ai_usage", () => {
  const seed = buildThinPrescreenSeed(HELIUM_CONFIG, null, "en", { append: true, roleFunction: ["software_engineering"] })
  assert.equal(seed.sharedKeys["q_ai_acceleration"], "ai_usage")
})

test("SPEC §7: a stored shared answer pre-answers the matching question (carried, not asked)", () => {
  const seed = buildThinPrescreenSeed(SHARED_CONFIG, null, "en", null, {
    sharedAnswers: {
      ai_usage: {
        sharedKey: "ai_usage",
        reply: "I use Cursor + Claude daily for tests and PR review.",
        finalS: 0.9,
        sourceSessionId: "sess_prior",
        sourceJobId: "job_prior",
        answeredAt: "2026-06-13T00:00:00.000Z",
        updatedAt: "2026-06-13T00:00:00.000Z",
      },
    },
  })
  // The shared question is pre-scored → the FSM auto-skips it (not pending).
  assert.ok("q_ai_native" in seed.prescreen.scores)
  assert.equal(seed.prescreen.scores["q_ai_native"].score, 0.9) // carried (no reJudgedScores → finalS)
  assert.deepEqual(seed.carriedQuestionIds, ["q_ai_native"])
  assert.ok(seed.carriedReferences["q_ai_native"].includes("Cursor"))
  // The job-specific question is NOT carried — still asked.
  assert.equal("q_fullstack_evidence" in seed.prescreen.scores, false)
})

test("SPEC §7: reJudgedScores override the carried score (re-judge against THIS job)", () => {
  const seed = buildThinPrescreenSeed(SHARED_CONFIG, null, "en", null, {
    sharedAnswers: {
      ai_usage: {
        sharedKey: "ai_usage",
        reply: "I use AI tools.",
        finalS: 0.9,
        sourceSessionId: "s",
        sourceJobId: "j",
        answeredAt: "2026-06-13T00:00:00.000Z",
        updatedAt: "2026-06-13T00:00:00.000Z",
      },
    },
    reJudgedScores: { q_ai_native: 0.4 },
  })
  assert.equal(seed.prescreen.scores["q_ai_native"].score, 0.4)
})

test("SPEC §7: a LIVE answer this session wins over the carried store (no override)", () => {
  const seed = buildThinPrescreenSeed(
    SHARED_CONFIG,
    { scored: { q_ai_native: { score: 0.55, evidence: "live answer" } } },
    "en",
    null,
    {
      sharedAnswers: {
        ai_usage: {
          sharedKey: "ai_usage",
          reply: "stored",
          finalS: 0.9,
          sourceSessionId: "s",
          sourceJobId: "j",
          answeredAt: "2026-06-13T00:00:00.000Z",
          updatedAt: "2026-06-13T00:00:00.000Z",
        },
      },
    },
  )
  assert.equal(seed.prescreen.scores["q_ai_native"].score, 0.55)
  assert.equal(seed.carriedQuestionIds.includes("q_ai_native"), false)
})

test("SPEC §10: no shared answers store → byte-identical legacy seed (dormant-safe)", () => {
  const a = buildThinPrescreenSeed(SHARED_CONFIG)
  const b = buildThinPrescreenSeed(SHARED_CONFIG, null, "en", null, { sharedAnswers: {} })
  assert.deepEqual(a.prescreen.scores, {})
  assert.deepEqual(b.prescreen.scores, {})
  assert.deepEqual(a.carriedQuestionIds, [])
  assert.deepEqual(b.carriedQuestionIds, [])
})
