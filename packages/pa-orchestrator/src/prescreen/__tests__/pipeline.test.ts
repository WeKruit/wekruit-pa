/**
 * v1.8 Phase 76 — PreScreenPipeline integration tests.
 *
 * Exercises the full 4-gate state machine over fully-stubbed LLM judges so
 * the orchestrator path is deterministic.
 *
 * Coverage:
 *   - Happy path: 2 MUST_HAVE Qs accepted → PASS
 *   - MUST_HAVE mismatch → probe up to maxClarifyRounds before HARD_STOP
 *   - PROBING s<τ_m → probe up to maxClarifyRounds before HARD_STOP
 *   - GOOD_TO_HAVE s=0 → keeps going
 *   - Low confidence triggers clarify (k bumps)
 *   - max_clarify_exhausted falls through to Type Gate
 *   - mergeScored monotonicity across clarify rounds
 *   - Viability PAUSE after hysteresis
 *   - FAIL when final ratio < threshold
 *   - Session-not-found returns synthesized FAIL state
 *   - Terminal state is sticky — subsequent turns re-emit terminal text
 */
import test from "node:test"
import assert from "node:assert/strict"

import { PreScreenPipeline, type PreScreenQuestion } from "../pipeline.js"
import { InMemoryPreScreenStore, emptyPreScreenState } from "../state.js"
import { KeywordSetJudge, type KeywordSetLlmCaller, type KeywordSetLlmOutput } from "../../onboarding/judges/keyword-set.js"
import type { JudgeCtx, QuestionType } from "../../onboarding/question.js"

const ctx: JudgeCtx = { userId: "u1", turnId: "t1" }

function makeCaller(seq: KeywordSetLlmOutput[]): KeywordSetLlmCaller {
  let i = 0
  return {
    async score() {
      const out = seq[Math.min(i, seq.length - 1)]
      i++
      return out
    },
  }
}

function makeQ(qId: string, scored: KeywordSetLlmOutput[]): PreScreenQuestion {
  return {
    qId,
    prompt: { zh: `请描述你的 ${qId} 经验`, en: `Describe your ${qId} experience` },
    clarifyPrompt: {
      zh: `为了准确评估，能否更具体一点 (${qId})`,
      en: `For accurate evaluation, could you be more specific (${qId})`,
    },
    judge: new KeywordSetJudge({
      questionId: qId,
      keywords: [{ keyword: qId, weight: 1 }],
      llmCaller: makeCaller(scored),
    }),
  }
}

async function setupSession(
  pipeline: PreScreenPipeline,
  store: InMemoryPreScreenStore,
  qs: Array<{ qId: string; type: QuestionType; weight: number; matchThreshold?: number }>,
  threshold = 0.65
) {
  const state = emptyPreScreenState({
    sessionId: "s1",
    userId: "u1",
    jobId: "j1",
    questions: qs,
    threshold,
    nowIso: "2026-05-12T00:00:00Z",
  })
  await store.save(state)
}

// ════════════════════════════════════════════════════════════════════════════
// Happy path
// ════════════════════════════════════════════════════════════════════════════

test("Phase 76: PreScreenPipeline happy path 2 MUST_HAVE → PASS", async () => {
  const store = new InMemoryPreScreenStore()
  const pipeline = new PreScreenPipeline({
    questions: {
      q1: makeQ("q1", [
        { perKeyword: [{ keyword: "q1", match: 1.0, confidence: 0.9, evidence: "ok", reasoning: "yes" }] },
      ]),
      q2: makeQ("q2", [
        { perKeyword: [{ keyword: "q2", match: 1.0, confidence: 0.9, evidence: "ok", reasoning: "yes" }] },
      ]),
    },
    store,
  })
  await setupSession(pipeline, store, [
    { qId: "q1", type: "MUST_HAVE", weight: 1 },
    { qId: "q2", type: "MUST_HAVE", weight: 1 },
  ])
  const r1 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "yes I do q1",
    lang: "en",
    nowIso: "2026-05-12T00:01:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r1.action.kind, "advance")
  const r2 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "yes q2",
    lang: "en",
    nowIso: "2026-05-12T00:02:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r2.action.kind, "terminal")
  if (r2.action.kind === "terminal") assert.equal(r2.action.terminal, "PASS")
  assert.equal(r2.state.score, 2)
})

// ════════════════════════════════════════════════════════════════════════════
// MUST_HAVE hard-stop after probing
// ════════════════════════════════════════════════════════════════════════════

test("Phase 76: PreScreenPipeline MUST_HAVE mismatch probes before HARD_STOP", async () => {
  const store = new InMemoryPreScreenStore()
  const pipeline = new PreScreenPipeline({
    questions: {
      q1: makeQ("q1", [
        { perKeyword: [{ keyword: "q1", match: 0.7, confidence: 0.9, evidence: "x", reasoning: "y" }] },
        { perKeyword: [{ keyword: "q1", match: 0.6, confidence: 0.9, evidence: "x", reasoning: "y" }] },
        { perKeyword: [{ keyword: "q1", match: 0.5, confidence: 0.9, evidence: "x", reasoning: "y" }] },
      ]),
    },
    store,
  })
  await setupSession(pipeline, store, [{ qId: "q1", type: "MUST_HAVE", weight: 1 }])
  const r1 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "kinda",
    lang: "en",
    nowIso: "2026-05-12T00:01:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r1.action.kind, "clarify")
  assert.match(r1.text, /more specific/i)
  assert.equal(r1.state.currentQId, "q1")
  assert.equal(r1.state.terminal, null)

  const r2 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "still kinda",
    lang: "en",
    nowIso: "2026-05-12T00:02:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r2.action.kind, "clarify")
  if (r2.action.kind === "clarify") assert.equal(r2.action.kAfter, 2)
  assert.equal(r2.state.currentQId, "q1")
  assert.equal(r2.state.terminal, null)

  const r3 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "no other example",
    lang: "en",
    nowIso: "2026-05-12T00:03:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r3.action.kind, "terminal")
  if (r3.action.kind === "terminal") assert.equal(r3.action.terminal, "HARD_STOP")
  assert.equal(r3.state.questions.q1.terminalCause, "type_gate_fail")
})

test("Phase 76: PreScreenPipeline type-gate probe can recover and advance", async () => {
  const store = new InMemoryPreScreenStore()
  const pipeline = new PreScreenPipeline({
    questions: {
      q1: makeQ("q1", [
        { perKeyword: [{ keyword: "q1", match: 0.6, confidence: 0.9, evidence: "weak", reasoning: "weak" }] },
        { perKeyword: [{ keyword: "q1", match: 1.0, confidence: 0.9, evidence: "strong", reasoning: "strong" }] },
      ]),
      q2: makeQ("q2", [
        { perKeyword: [{ keyword: "q2", match: 1.0, confidence: 0.9, evidence: "ok", reasoning: "yes" }] },
      ]),
    },
    store,
  })
  await setupSession(pipeline, store, [
    { qId: "q1", type: "MUST_HAVE", weight: 1 },
    { qId: "q2", type: "MUST_HAVE", weight: 1 },
  ])
  const r1 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "weak example",
    lang: "en",
    nowIso: "2026-05-12T00:01:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r1.action.kind, "clarify")

  const r2 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "strong concrete example",
    lang: "en",
    nowIso: "2026-05-12T00:02:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r2.action.kind, "advance")
  if (r2.action.kind === "advance") assert.equal(r2.action.toQId, "q2")
  assert.equal(r2.state.questions.q1.finalS, 1)
})

test("Phase 76: PreScreenPipeline soft-accepts credible MUST_HAVE overlap after repeated probing", async () => {
  const store = new InMemoryPreScreenStore()
  const pipeline = new PreScreenPipeline({
    questions: {
      q1: makeQ("q1", [
        { perKeyword: [{ keyword: "q1", match: 0.15, confidence: 0.9, evidence: "weak", reasoning: "weak" }] },
        { perKeyword: [{ keyword: "q1", match: 0.72, confidence: 0.9, evidence: "dashboard", reasoning: "adjacent" }] },
        { perKeyword: [{ keyword: "q1", match: 0.78, confidence: 0.9, evidence: "sql dashboard", reasoning: "credible overlap" }] },
      ]),
      q2: makeQ("q2", [
        { perKeyword: [{ keyword: "q2", match: 1.0, confidence: 0.9, evidence: "ok", reasoning: "yes" }] },
      ]),
    },
    store,
  })
  const state = emptyPreScreenState({
    sessionId: "s1",
    userId: "u1",
    jobId: "j1",
    questions: [
      { qId: "q1", type: "MUST_HAVE", weight: 1, matchThreshold: 0.85 },
      { qId: "q2", type: "PROBING", weight: 1 },
    ],
    threshold: 0.65,
    confidenceThreshold: 0.7,
    maxClarifyRounds: 4,
    nowIso: "2026-05-12T00:00:00Z",
  })
  await store.save(state)

  const r1 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "not exact",
    lang: "en",
    nowIso: "2026-05-12T00:01:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r1.action.kind, "clarify")

  const r2 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "owned dashboard and SQL reports",
    lang: "en",
    nowIso: "2026-05-12T00:02:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r2.action.kind, "clarify")

  const r3 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "built the SQL-backed dashboard and used it to fix repeated failures",
    lang: "en",
    nowIso: "2026-05-12T00:03:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r3.action.kind, "advance")
  if (r3.action.kind === "advance") assert.equal(r3.action.toQId, "q2")
  assert.equal(r3.state.questions.q1.finalS, 0.78)
})

test("Phase 76: max-probed adjacent engineering evidence advances instead of hard-stopping", async () => {
  const store = new InMemoryPreScreenStore()
  const pipeline = new PreScreenPipeline({
    questions: {
      q1: makeQ("q1", [
        { perKeyword: [{ keyword: "q1", match: 0.15, confidence: 0.62, evidence: "not owned production fullstack", reasoning: "not exact" }] },
        { perKeyword: [{ keyword: "q1", match: 0.72, confidence: 0.74, evidence: "dashboard and SQL", reasoning: "adjacent ownership" }] },
        { perKeyword: [{ keyword: "q1", match: 0.72, confidence: 0.66, evidence: "failure tracing", reasoning: "needs systems detail" }] },
        { perKeyword: [{ keyword: "q1", match: 0.78, confidence: 0.74, evidence: "order DB plus dispatch events", reasoning: "credible adjacent system ownership" }] },
        { perKeyword: [{ keyword: "q1", match: 0.78, confidence: 0.74, evidence: "operator workflow end to end", reasoning: "credible adjacent system ownership" }] },
      ]),
      q2: makeQ("q2", [
        { perKeyword: [{ keyword: "q2", match: 1.0, confidence: 0.9, evidence: "ok", reasoning: "yes" }] },
      ]),
    },
    store,
  })
  const state = emptyPreScreenState({
    sessionId: "s1",
    userId: "u1",
    jobId: "rain-software-engineer-fullstack-8849f6ef",
    questions: [
      { qId: "q1", type: "MUST_HAVE", weight: 1, matchThreshold: 0.85 },
      { qId: "q2", type: "PROBING", weight: 1 },
    ],
    threshold: 0.65,
    confidenceThreshold: 0.7,
    maxClarifyRounds: 4,
    nowIso: "2026-05-12T00:00:00Z",
  })
  await store.save(state)

  const replies = [
    "I have not owned a production fullstack system. Most of my work was product ops, dashboards, SQL reports, and scripts.",
    "For OFO Delivery, I owned the merchant order dashboard and dispatch tooling.",
    "The hardest part was failure tracing across merchant order states.",
    "The data came from our order DB plus courier dispatch events and merchant config tables.",
  ]

  for (let i = 0; i < replies.length - 1; i++) {
    const r = await pipeline.runTurn({
      sessionId: "s1",
      reply: replies[i],
      lang: "en",
      nowIso: `2026-05-12T00:0${i + 1}:00Z`,
      judgeCtx: ctx,
    })
    assert.equal(r.action.kind, "clarify")
    assert.equal(r.state.terminal, null)
  }

  const finalProbe = await pipeline.runTurn({
    sessionId: "s1",
    reply: replies[3],
    lang: "en",
    nowIso: "2026-05-12T00:04:00Z",
    judgeCtx: ctx,
  })

  assert.equal(finalProbe.action.kind, "advance")
  if (finalProbe.action.kind === "advance") assert.equal(finalProbe.action.toQId, "q2")
  assert.equal(finalProbe.state.questions.q1.finalS, 0.78)
  assert.equal(finalProbe.state.terminal, null)
})

test("Phase 76: weak engineering evidence gets four probes before HARD_STOP", async () => {
  const store = new InMemoryPreScreenStore()
  const pipeline = new PreScreenPipeline({
    questions: {
      q1: makeQ("q1", [
        { perKeyword: [{ keyword: "q1", match: 0.1, confidence: 0.9, evidence: "no direct experience", reasoning: "not aligned" }] },
        { perKeyword: [{ keyword: "q1", match: 0.12, confidence: 0.9, evidence: "no project", reasoning: "not aligned" }] },
        { perKeyword: [{ keyword: "q1", match: 0.12, confidence: 0.9, evidence: "still no project", reasoning: "not aligned" }] },
        { perKeyword: [{ keyword: "q1", match: 0.12, confidence: 0.9, evidence: "unrelated", reasoning: "not aligned" }] },
        { perKeyword: [{ keyword: "q1", match: 0.12, confidence: 0.9, evidence: "unrelated", reasoning: "not aligned" }] },
      ]),
    },
    store,
  })
  const state = emptyPreScreenState({
    sessionId: "s1",
    userId: "u1",
    jobId: "rain-software-engineer-fullstack-8849f6ef",
    questions: [{ qId: "q1", type: "MUST_HAVE", weight: 1, matchThreshold: 0.85 }],
    threshold: 0.65,
    confidenceThreshold: 0.7,
    maxClarifyRounds: 4,
    nowIso: "2026-05-12T00:00:00Z",
  })
  await store.save(state)

  const replies = [
    "I have not done software engineering work.",
    "I do not have a related project.",
    "I mainly did customer service and scheduling.",
    "No engineering system, just spreadsheets.",
    "I cannot think of a closer example.",
  ]

  for (let i = 0; i < 4; i++) {
    const r = await pipeline.runTurn({
      sessionId: "s1",
      reply: replies[i],
      lang: "en",
      nowIso: `2026-05-12T00:0${i + 1}:00Z`,
      judgeCtx: ctx,
    })
    assert.equal(r.action.kind, "clarify")
    assert.equal(r.state.terminal, null)
    assert.equal(r.state.questions.q1.clarifyRounds, i + 1)
  }

  const terminal = await pipeline.runTurn({
    sessionId: "s1",
    reply: replies[4],
    lang: "en",
    nowIso: "2026-05-12T00:05:00Z",
    judgeCtx: ctx,
  })

  assert.equal(terminal.action.kind, "terminal")
  if (terminal.action.kind === "terminal") assert.equal(terminal.action.terminal, "HARD_STOP")
  assert.equal(terminal.state.questions.q1.terminalCause, "type_gate_fail")
  assert.equal(terminal.state.questions.q1.clarifyRounds, 4)
})

test("Phase 76: PreScreenPipeline PROBING s<τ_m probes before HARD_STOP", async () => {
  const store = new InMemoryPreScreenStore()
  const pipeline = new PreScreenPipeline({
    questions: {
      q1: makeQ("q1", [
        { perKeyword: [{ keyword: "q1", match: 0.5, confidence: 0.9, evidence: "", reasoning: "" }] },
        { perKeyword: [{ keyword: "q1", match: 0.4, confidence: 0.9, evidence: "", reasoning: "" }] },
        { perKeyword: [{ keyword: "q1", match: 0.3, confidence: 0.9, evidence: "", reasoning: "" }] },
      ]),
    },
    store,
  })
  await setupSession(pipeline, store, [{ qId: "q1", type: "PROBING", weight: 1 }])
  const r1 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "x",
    lang: "en",
    nowIso: "2026-05-12T00:01:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r1.action.kind, "clarify")

  const r2 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "still x",
    lang: "en",
    nowIso: "2026-05-12T00:02:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r2.action.kind, "clarify")
  if (r2.action.kind === "clarify") assert.equal(r2.action.kAfter, 2)

  const r3 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "no other example",
    lang: "en",
    nowIso: "2026-05-12T00:03:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r3.action.kind, "terminal")
  if (r3.action.kind === "terminal") assert.equal(r3.action.terminal, "HARD_STOP")
})

test("Phase 76: PreScreenPipeline type-gate probe can use custom maxClarifyRounds", async () => {
  const store = new InMemoryPreScreenStore()
  const pipeline = new PreScreenPipeline({
    questions: {
      q1: makeQ("q1", [
        { perKeyword: [{ keyword: "q1", match: 0.5, confidence: 0.9, evidence: "", reasoning: "" }] },
        { perKeyword: [{ keyword: "q1", match: 0.4, confidence: 0.9, evidence: "", reasoning: "" }] },
      ]),
    },
    store,
  })
  const state = emptyPreScreenState({
    sessionId: "s1",
    userId: "u1",
    jobId: "j1",
    questions: [{ qId: "q1", type: "MUST_HAVE", weight: 1 }],
    maxClarifyRounds: 1,
    nowIso: "2026-05-12T00:00:00Z",
  })
  await store.save(state)
  const r1 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "weak",
    lang: "en",
    nowIso: "2026-05-12T00:01:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r1.action.kind, "clarify")

  const r2 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "still weak",
    lang: "en",
    nowIso: "2026-05-12T00:02:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r2.action.kind, "terminal")
  if (r2.action.kind === "terminal") assert.equal(r2.action.terminal, "HARD_STOP")
  assert.equal(r2.state.questions.q1.terminalCause, "type_gate_fail")
})

// ════════════════════════════════════════════════════════════════════════════
// PROBING + GOOD_TO_HAVE
// ════════════════════════════════════════════════════════════════════════════

test("Phase 76: PreScreenPipeline GOOD_TO_HAVE s=0 keeps going (no hard-stop) and PASSes if ratio sufficient", async () => {
  const store = new InMemoryPreScreenStore()
  // q1 GOOD_TO_HAVE weight=1 s=0; q2 MUST_HAVE weight=2 s=1.0.
  // After q1: S=0, R_max=2, upper=2 ≥ required=1.95 → proceed.
  // After q2 (last Q, skip viability): S=2, ratio=0.667 ≥ 0.65 → PASS.
  // Proves: (a) GOOD_TO_HAVE s=0 does NOT hard-stop; (b) ratio over all Qs
  // determines final decision.
  const pipeline = new PreScreenPipeline({
    questions: {
      q1: makeQ("q1", [
        { perKeyword: [{ keyword: "q1", match: 0, confidence: 0.9, evidence: "", reasoning: "" }] },
      ]),
      q2: makeQ("q2", [
        { perKeyword: [{ keyword: "q2", match: 1.0, confidence: 0.9, evidence: "", reasoning: "" }] },
      ]),
    },
    store,
  })
  await setupSession(pipeline, store, [
    { qId: "q1", type: "GOOD_TO_HAVE", weight: 1 },
    { qId: "q2", type: "MUST_HAVE", weight: 2 },
  ])
  const r1 = await pipeline.runTurn({
    sessionId: "s1", reply: "no exp", lang: "en", nowIso: "2026-05-12T00:01:00Z", judgeCtx: ctx,
  })
  assert.equal(r1.action.kind, "advance")
  const r2 = await pipeline.runTurn({
    sessionId: "s1", reply: "yes q2", lang: "en", nowIso: "2026-05-12T00:02:00Z", judgeCtx: ctx,
  })
  assert.equal(r2.action.kind, "terminal")
  if (r2.action.kind === "terminal") assert.equal(r2.action.terminal, "PASS")
})

// ════════════════════════════════════════════════════════════════════════════
// Confidence gate → clarify
// ════════════════════════════════════════════════════════════════════════════

test("Phase 76: PreScreenPipeline low confidence triggers clarify and bumps k", async () => {
  const store = new InMemoryPreScreenStore()
  const pipeline = new PreScreenPipeline({
    questions: {
      q1: makeQ("q1", [
        { perKeyword: [{ keyword: "q1", match: 0.9, confidence: 0.3, evidence: "", reasoning: "" }] },
      ]),
    },
    store,
  })
  await setupSession(pipeline, store, [{ qId: "q1", type: "MUST_HAVE", weight: 1 }])
  const r = await pipeline.runTurn({
    sessionId: "s1",
    reply: "umm yes I think",
    lang: "en",
    nowIso: "2026-05-12T00:01:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r.action.kind, "clarify")
  if (r.action.kind === "clarify") {
    assert.equal(r.action.kAfter, 1)
  }
  assert.match(r.text, /more specific/i)
  assert.equal(r.state.questions.q1.clarifyRounds, 1)
  // currentQId NOT advanced
  assert.equal(r.state.currentQId, "q1")
})

test("Phase 76: placeholder clarify copy falls back to probing friend-tone text", async () => {
  const store = new InMemoryPreScreenStore()
  const pipeline = new PreScreenPipeline({
    questions: {
      q1: {
        qId: "q1",
        prompt: { zh: "讲讲最匹配的经历", en: "Tell me about the closest fit." },
        clarifyPrompt: {
          zh: "Please add one concrete example tied to this job.",
          en: "Please add one concrete example tied to this job.",
        },
        judge: new KeywordSetJudge({
          questionId: "q1",
          keywords: [{ keyword: "q1", weight: 1 }],
          llmCaller: makeCaller([
            { perKeyword: [{ keyword: "q1", match: 0.9, confidence: 0.3, evidence: "", reasoning: "" }] },
          ]),
        }),
      },
    },
    store,
  })
  await setupSession(pipeline, store, [{ qId: "q1", type: "MUST_HAVE", weight: 1 }])
  const r = await pipeline.runTurn({
    sessionId: "s1",
    reply: "closest project maybe dashboards",
    lang: "en",
    nowIso: "2026-05-12T00:01:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r.action.kind, "clarify")
  assert.match(r.text, /closest overlap/i)
  assert.doesNotMatch(r.text, /Please add one concrete example/)
})

test("Phase 76: hard-filter questions clarify the condition directly", async () => {
  const store = new InMemoryPreScreenStore()
  const pipeline = new PreScreenPipeline({
    questions: {
      location_alignment: {
        qId: "location_alignment",
        prompt: { zh: "Does this location or remote setup work for you?", en: "Does this location or remote setup work for you?" },
        clarifyPrompt: {
          zh: "Please add one concrete example from your own work.",
          en: "Please add one concrete example from your own work.",
        },
        judge: new KeywordSetJudge({
          questionId: "location_alignment",
          keywords: [{ keyword: "location_alignment", weight: 1 }],
          llmCaller: makeCaller([
            { perKeyword: [{ keyword: "location_alignment", match: 0.2, confidence: 0.55, evidence: "Los Angeles", reasoning: "not the listed location" }] },
          ]),
        }),
      },
    },
    store,
  })
  await setupSession(pipeline, store, [{ qId: "location_alignment", type: "PROBING", weight: 1 }])
  const r = await pipeline.runTurn({
    sessionId: "s1",
    reply: "I am in Los Angeles and can travel to the Bay Area sometimes.",
    lang: "en",
    nowIso: "2026-05-12T00:01:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r.action.kind, "clarify")
  assert.match(r.text, /listed location\/remote arrangement/)
  assert.doesNotMatch(r.text, /project|owned|measurable|shipped/i)
})

test("Phase 76: hard-filter mismatch abortHint overrides a noisy high score", async () => {
  const store = new InMemoryPreScreenStore()
  const pipeline = new PreScreenPipeline({
    questions: {
      location_alignment: {
        qId: "location_alignment",
        prompt: { zh: "Does this location or remote setup work for you?", en: "Does this location or remote setup work for you?" },
        clarifyPrompt: {
          zh: "Please answer directly whether the listed setup works.",
          en: "Please answer directly whether the listed setup works.",
        },
        judge: new KeywordSetJudge({
          questionId: "location_alignment",
          keywords: [{ keyword: "location_alignment", weight: 1 }],
          llmCaller: makeCaller([
            {
              perKeyword: [
                {
                  keyword: "location_alignment",
                  match: 0.85,
                  confidence: 0.78,
                  evidence: "cannot relocate to New York",
                  reasoning: "noisy high score despite mismatch",
                },
              ],
              summary: "Remote from LA works; cannot relocate to New York or be there weekly.",
              abortHint: { kind: "low_confidence", reason: "candidate declines NYC weekly" },
            },
          ]),
        }),
      },
      compensation_alignment: makeQ("compensation_alignment", [
        { perKeyword: [{ keyword: "compensation_alignment", match: 1, confidence: 1, evidence: "", reasoning: "" }] },
      ]),
    },
    store,
  })
  await setupSession(pipeline, store, [
    { qId: "location_alignment", type: "PROBING", weight: 1 },
    { qId: "compensation_alignment", type: "PROBING", weight: 1 },
  ])
  const r = await pipeline.runTurn({
    sessionId: "s1",
    reply: "I cannot relocate to New York or be in NYC weekly. I need remote from Los Angeles.",
    lang: "en",
    nowIso: "2026-05-12T00:01:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r.action.kind, "clarify")
  assert.equal(r.state.currentQId, "location_alignment")
  assert.equal(r.state.questions.location_alignment.scored?.aggregate.s, 0.25)
  assert.match(r.state.questions.location_alignment.scored?.aggregate.summary ?? "", /different location/)
})

test("Phase 76: confirmed hard-filter mismatch stops after one direct clarify", async () => {
  const store = new InMemoryPreScreenStore()
  const pipeline = new PreScreenPipeline({
    questions: {
      location_alignment: {
        qId: "location_alignment",
        prompt: { zh: "Does this location or remote setup work for you?", en: "Does this location or remote setup work for you?" },
        clarifyPrompt: {
          zh: "Please answer directly whether the listed setup works.",
          en: "Please answer directly whether the listed setup works.",
        },
        judge: new KeywordSetJudge({
          questionId: "location_alignment",
          keywords: [{ keyword: "location_alignment", weight: 1 }],
          llmCaller: makeCaller([
            {
              perKeyword: [
                {
                  keyword: "location_alignment",
                  match: 0.85,
                  confidence: 0.78,
                  evidence: "cannot relocate to New York",
                  reasoning: "noisy high score despite mismatch",
                },
              ],
              summary: "Remote from LA works; cannot relocate to New York or be there weekly.",
              abortHint: { kind: "low_confidence", reason: "candidate declines NYC weekly" },
            },
            {
              perKeyword: [
                {
                  keyword: "location_alignment",
                  match: 0.8,
                  confidence: 0.82,
                  evidence: "can only do remote from Los Angeles",
                  reasoning: "noisy high score despite confirmed mismatch",
                },
              ],
              summary: "Candidate can only do remote from Los Angeles and cannot do NYC onsite.",
            },
          ]),
        }),
      },
      compensation_alignment: makeQ("compensation_alignment", [
        { perKeyword: [{ keyword: "compensation_alignment", match: 1, confidence: 1, evidence: "", reasoning: "" }] },
      ]),
    },
    store,
  })
  await setupSession(pipeline, store, [
    { qId: "location_alignment", type: "PROBING", weight: 1 },
    { qId: "compensation_alignment", type: "PROBING", weight: 1 },
  ])
  const first = await pipeline.runTurn({
    sessionId: "s1",
    reply: "I cannot relocate to New York or be in NYC weekly. I need remote from Los Angeles.",
    lang: "en",
    nowIso: "2026-05-12T00:01:00Z",
    judgeCtx: ctx,
  })
  assert.equal(first.action.kind, "clarify")
  assert.equal(first.state.currentQId, "location_alignment")

  const second = await pipeline.runTurn({
    sessionId: "s1",
    reply: "No. I can only do remote from Los Angeles and cannot do New York onsite or relocation.",
    lang: "en",
    nowIso: "2026-05-12T00:02:00Z",
    judgeCtx: ctx,
  })
  assert.deepEqual(second.action, {
    kind: "terminal",
    terminal: "HARD_STOP",
    reason: "hard_filter_mismatch at qId=location_alignment s=0.25 c=0.85: Candidate needs a different location or remote setup than this role requires.",
  })
  assert.equal(second.state.currentQId, null)
  assert.equal(second.state.questions.location_alignment.finalS, 0.25)
  assert.equal(second.state.questions.location_alignment.finalC, 0.85)
  assert.match(second.text, /do not want to force-fit/i)
})

test("Phase 76: repeated clarify on the same question asks a new targeted probe", async () => {
  const store = new InMemoryPreScreenStore()
  const pipeline = new PreScreenPipeline({
    questions: {
      q1: {
        qId: "q1",
        prompt: { zh: "讲讲最匹配的经历", en: "What recent work best matches this software engineering role?" },
        clarifyPrompt: {
          zh: "Please add one concrete example tied to this job.",
          en: "Please add one concrete example tied to this job.",
        },
        judge: new KeywordSetJudge({
          questionId: "q1",
          keywords: [
            { keyword: "fullstack ownership", weight: 1 },
            { keyword: "API integration", weight: 1 },
          ],
          llmCaller: makeCaller([
            {
              perKeyword: [
                { keyword: "fullstack ownership", match: 0.2, confidence: 0.55, evidence: "dashboards", reasoning: "unclear ownership" },
                { keyword: "API integration", match: 0.1, confidence: 0.55, evidence: "", reasoning: "not shown" },
              ],
            },
            {
              perKeyword: [
                { keyword: "fullstack ownership", match: 0.45, confidence: 0.6, evidence: "merchant dashboard", reasoning: "partial ownership" },
                { keyword: "API integration", match: 0.2, confidence: 0.6, evidence: "scripts", reasoning: "unclear API work" },
              ],
            },
          ]),
        }),
      },
    },
    store,
  })
  await setupSession(pipeline, store, [{ qId: "q1", type: "MUST_HAVE", weight: 1 }])
  const r1 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "I mostly did dashboards and scripts.",
    lang: "en",
    nowIso: "2026-05-12T00:01:00Z",
    judgeCtx: ctx,
  })
  const r2 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "I owned the merchant dashboard and dispatch tooling.",
    lang: "en",
    nowIso: "2026-05-12T00:02:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r1.action.kind, "clarify")
  assert.equal(r2.action.kind, "clarify")
  assert.notEqual(r2.text, r1.text)
  assert.match(r2.text, /remaining gap|fullstack ownership|API integration/i)
})

test("Phase 76: PreScreenPipeline 3rd low-conf reply exhausts clarify and falls to Type Gate", async () => {
  const store = new InMemoryPreScreenStore()
  const pipeline = new PreScreenPipeline({
    questions: {
      q1: makeQ("q1", [
        { perKeyword: [{ keyword: "q1", match: 1.0, confidence: 0.3, evidence: "", reasoning: "" }] },
        { perKeyword: [{ keyword: "q1", match: 1.0, confidence: 0.3, evidence: "", reasoning: "" }] },
        { perKeyword: [{ keyword: "q1", match: 1.0, confidence: 0.3, evidence: "", reasoning: "" }] },
      ]),
    },
    store,
  })
  await setupSession(pipeline, store, [{ qId: "q1", type: "MUST_HAVE", weight: 1 }])
  // Turn 1: clarify (k=1)
  const r1 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "first",
    lang: "en",
    nowIso: "2026-05-12T00:01:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r1.action.kind, "clarify")
  // Turn 2: clarify (k=2)
  const r2 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "second",
    lang: "en",
    nowIso: "2026-05-12T00:02:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r2.action.kind, "clarify")
  if (r2.action.kind === "clarify") assert.equal(r2.action.kAfter, 2)
  // Turn 3: exhausted → falls to Type Gate; MUST_HAVE s=1.0 passes → PASS
  const r3 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "third",
    lang: "en",
    nowIso: "2026-05-12T00:03:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r3.action.kind, "terminal")
  if (r3.action.kind === "terminal") assert.equal(r3.action.terminal, "PASS")
})

// ════════════════════════════════════════════════════════════════════════════
// mergeScored monotonicity
// ════════════════════════════════════════════════════════════════════════════

test("Phase 76: PreScreenPipeline keeps best s across clarification rounds", async () => {
  const store = new InMemoryPreScreenStore()
  // Round 1: s=0.9 c=0.3 → clarify
  // Round 2: s=0.5 c=0.4 → clarify; merged keeps s=0.9 from round 1
  // Round 3: s=0.7 c=0.4 → exhausted; merged still s=0.9 → MUST_HAVE
  //          requires s=1.0 so this still FAILs type gate
  const pipeline = new PreScreenPipeline({
    questions: {
      q1: makeQ("q1", [
        { perKeyword: [{ keyword: "q1", match: 0.9, confidence: 0.3, evidence: "", reasoning: "" }] },
        { perKeyword: [{ keyword: "q1", match: 0.5, confidence: 0.4, evidence: "", reasoning: "" }] },
        { perKeyword: [{ keyword: "q1", match: 0.7, confidence: 0.4, evidence: "", reasoning: "" }] },
      ]),
    },
    store,
  })
  await setupSession(pipeline, store, [{ qId: "q1", type: "MUST_HAVE", weight: 1 }])
  await pipeline.runTurn({ sessionId: "s1", reply: "a", lang: "en", nowIso: "2026-05-12T00:01:00Z", judgeCtx: ctx })
  await pipeline.runTurn({ sessionId: "s1", reply: "b", lang: "en", nowIso: "2026-05-12T00:02:00Z", judgeCtx: ctx })
  const r3 = await pipeline.runTurn({
    sessionId: "s1", reply: "c", lang: "en", nowIso: "2026-05-12T00:03:00Z", judgeCtx: ctx,
  })
  // mergedS = max(0.9, 0.5, 0.7) = 0.9 < 1.0 (MUST_HAVE) → HARD_STOP
  assert.equal(r3.action.kind, "terminal")
  if (r3.action.kind === "terminal") assert.equal(r3.action.terminal, "HARD_STOP")
})

test("Phase 76: PreScreenPipeline scores clarifications with accumulated same-question evidence", async () => {
  const store = new InMemoryPreScreenStore()
  const scoredInputs: string[] = []
  const caller: KeywordSetLlmCaller = {
    async score({ reply }) {
      scoredInputs.push(reply)
      const hasAccumulatedEvidence =
        reply.includes("Answer 1:") &&
        reply.includes("Answer 2:") &&
        reply.includes("campus delivery dashboards") &&
        reply.includes("DB rows, dispatch event logs")
      return {
        perKeyword: [
          {
            keyword: "q1",
            match: hasAccumulatedEvidence ? 0.78 : 0.42,
            confidence: 0.9,
            evidence: hasAccumulatedEvidence ? "DB rows, dispatch event logs" : "dashboards",
            reasoning: hasAccumulatedEvidence ? "combined ownership story" : "too thin alone",
          },
        ],
        summary: hasAccumulatedEvidence
          ? "Accumulated evidence shows UI, DB, events, and tradeoff ownership."
          : "Initial answer is too thin.",
        answered: true,
      }
    },
  }
  const pipeline = new PreScreenPipeline({
    questions: {
      q1: {
        qId: "q1",
        prompt: { zh: "What matches?", en: "What matches?" },
        clarifyPrompt: { zh: "Tell me more.", en: "Tell me more." },
        judge: new KeywordSetJudge({
          questionId: "q1",
          keywords: [{ keyword: "q1", weight: 1 }],
          llmCaller: caller,
        }),
      },
      q2: makeQ("q2", [
        { perKeyword: [{ keyword: "q2", match: 1, confidence: 0.9, evidence: "ok", reasoning: "ok" }] },
      ]),
    },
    store,
  })
  await setupSession(pipeline, store, [
    { qId: "q1", type: "MUST_HAVE", weight: 1, matchThreshold: 0.7 },
    { qId: "q2", type: "PROBING", weight: 1 },
  ])

  const r1 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "I mostly did product ops and campus delivery dashboards.",
    lang: "en",
    nowIso: "2026-05-12T00:01:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r1.action.kind, "clarify")

  const r2 = await pipeline.runTurn({
    sessionId: "s1",
    reply: "The dashboard touched admin UI, DB rows, dispatch event logs, and merchant config.",
    lang: "en",
    nowIso: "2026-05-12T00:02:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r2.action.kind, "advance")
  if (r2.action.kind === "advance") assert.equal(r2.action.toQId, "q2")
  assert.equal(scoredInputs.length, 2)
  assert.match(scoredInputs[1]!, /Answer 1: I mostly did product ops/)
  assert.match(scoredInputs[1]!, /Answer 2: The dashboard touched admin UI/)

  const state = await store.load("s1")
  assert.deepEqual(state?.questions.q1.evidenceReplies, [
    "I mostly did product ops and campus delivery dashboards.",
    "The dashboard touched admin UI, DB rows, dispatch event logs, and merchant config.",
  ])
  assert.equal(state?.questions.q1.finalS, 0.78)
  assert.equal(state?.currentQId, "q2")
})

// ════════════════════════════════════════════════════════════════════════════
// Viability → PAUSE
// ════════════════════════════════════════════════════════════════════════════

test("Phase 76: PreScreenPipeline pauses on viability after hysteresis", async () => {
  // 6 Qs all GOOD_TO_HAVE weight=1. After ⌈6/3⌉=2 answered with s=0 each:
  // S=0, R_max=4, S_max=6, T=0.65 → required=3.9, upper=4 ≥ 3.9 → still
  // proceeds. After 3 answered: S=0, R_max=3, upper=3 < 3.9 → PAUSE.
  const store = new InMemoryPreScreenStore()
  const lowOutput: KeywordSetLlmOutput = {
    perKeyword: [{ keyword: "qX", match: 0, confidence: 0.9, evidence: "", reasoning: "" }],
  }
  const qIds = ["q1", "q2", "q3", "q4", "q5", "q6"]
  const questions: Record<string, PreScreenQuestion> = {}
  for (const qId of qIds) {
    questions[qId] = makeQ(qId, [{ perKeyword: [{ keyword: qId, match: 0, confidence: 0.9, evidence: "", reasoning: "" }] }])
    void lowOutput
  }
  const pipeline = new PreScreenPipeline({ questions, store })
  await setupSession(
    pipeline, store,
    qIds.map((qId) => ({ qId, type: "GOOD_TO_HAVE", weight: 1 } as const))
  )

  let result
  for (let i = 0; i < 6; i++) {
    result = await pipeline.runTurn({
      sessionId: "s1", reply: `t${i}`, lang: "en", nowIso: `2026-05-12T00:0${i}:00Z`, judgeCtx: ctx,
    })
    if (result.action.kind === "terminal") break
  }
  assert.equal(result?.action.kind, "terminal")
  if (result?.action.kind === "terminal") assert.equal(result.action.terminal, "PAUSE")
})

// ════════════════════════════════════════════════════════════════════════════
// FAIL on final ratio
// ════════════════════════════════════════════════════════════════════════════

test("Phase 76: PreScreenPipeline probes before final FAIL when ratio < threshold", async () => {
  const store = new InMemoryPreScreenStore()
  // 2 GOOD_TO_HAVE Qs with s=0.5 each → ratio = 0.5 < 0.65 → FAIL
  const pipeline = new PreScreenPipeline({
    questions: {
      q1: makeQ("q1", [
        { perKeyword: [{ keyword: "q1", match: 0.5, confidence: 0.9, evidence: "", reasoning: "" }] },
      ]),
      q2: makeQ("q2", [
        { perKeyword: [{ keyword: "q2", match: 0.5, confidence: 0.9, evidence: "", reasoning: "" }] },
      ]),
    },
    store,
  })
  await setupSession(pipeline, store, [
    { qId: "q1", type: "GOOD_TO_HAVE", weight: 1 },
    { qId: "q2", type: "GOOD_TO_HAVE", weight: 1 },
  ])
  await pipeline.runTurn({ sessionId: "s1", reply: "a", lang: "en", nowIso: "2026-05-12T00:01:00Z", judgeCtx: ctx })
  const firstLowFinal = await pipeline.runTurn({
    sessionId: "s1", reply: "b", lang: "en", nowIso: "2026-05-12T00:02:00Z", judgeCtx: ctx,
  })
  assert.equal(firstLowFinal.action.kind, "clarify")
  assert.match(firstLowFinal.text, /That helps|specific/i)

  const secondLowFinal = await pipeline.runTurn({
    sessionId: "s1", reply: "more detail", lang: "en", nowIso: "2026-05-12T00:03:00Z", judgeCtx: ctx,
  })
  assert.equal(secondLowFinal.action.kind, "clarify")

  const r = await pipeline.runTurn({
    sessionId: "s1", reply: "still thin", lang: "en", nowIso: "2026-05-12T00:04:00Z", judgeCtx: ctx,
  })
  assert.equal(r.action.kind, "terminal")
  if (r.action.kind === "terminal") assert.equal(r.action.terminal, "FAIL")
})

// ════════════════════════════════════════════════════════════════════════════
// Session not found + terminal stickiness
// ════════════════════════════════════════════════════════════════════════════

test("Phase 76: PreScreenPipeline returns FAIL when session not found", async () => {
  const store = new InMemoryPreScreenStore()
  const pipeline = new PreScreenPipeline({ questions: {}, store })
  const r = await pipeline.runTurn({
    sessionId: "missing",
    reply: "x",
    lang: "en",
    nowIso: "2026-05-12T00:00:00Z",
    judgeCtx: ctx,
  })
  assert.equal(r.action.kind, "error")
  assert.equal(r.state.terminal, "FAIL")
  assert.equal(r.state.terminalReason, "session_not_found")
})

test("Phase 76: PreScreenPipeline terminal state is sticky — re-emits terminal text", async () => {
  const store = new InMemoryPreScreenStore()
  const pipeline = new PreScreenPipeline({
    questions: {
      q1: makeQ("q1", [
        { perKeyword: [{ keyword: "q1", match: 0.7, confidence: 0.9, evidence: "", reasoning: "" }] },
        { perKeyword: [{ keyword: "q1", match: 0.6, confidence: 0.9, evidence: "", reasoning: "" }] },
        { perKeyword: [{ keyword: "q1", match: 0.5, confidence: 0.9, evidence: "", reasoning: "" }] },
      ]),
    },
    store,
  })
  await setupSession(pipeline, store, [{ qId: "q1", type: "MUST_HAVE", weight: 1 }])
  // Turn 1: MUST_HAVE s=0.7 < 1.0 → one required-area clarify.
  const r1 = await pipeline.runTurn({
    sessionId: "s1", reply: "kinda", lang: "en", nowIso: "2026-05-12T00:01:00Z", judgeCtx: ctx,
  })
  assert.equal(r1.action.kind, "clarify")
  // Turn 2: still below threshold → one more probe.
  const r2 = await pipeline.runTurn({
    sessionId: "s1", reply: "still kinda", lang: "en", nowIso: "2026-05-12T00:02:00Z", judgeCtx: ctx,
  })
  assert.equal(r2.action.kind, "clarify")
  // Turn 3: still below threshold after probes → HARD_STOP.
  const r3 = await pipeline.runTurn({
    sessionId: "s1", reply: "no other example", lang: "en", nowIso: "2026-05-12T00:03:00Z", judgeCtx: ctx,
  })
  assert.equal(r3.action.kind, "terminal")
  if (r3.action.kind === "terminal") assert.equal(r3.action.terminal, "HARD_STOP")
  // Turn 4: even after the candidate types again, the pipeline re-emits
  // the terminal text and doesn't run the judge.
  const r4 = await pipeline.runTurn({
    sessionId: "s1", reply: "wait actually let me try again", lang: "en", nowIso: "2026-05-12T00:04:00Z", judgeCtx: ctx,
  })
  assert.equal(r4.action.kind, "terminal")
  if (r4.action.kind === "terminal") assert.equal(r4.action.terminal, "HARD_STOP")
})

// ════════════════════════════════════════════════════════════════════════════
// Terminal text never leaks reason to candidate
// ════════════════════════════════════════════════════════════════════════════

test("Phase 76: terminal text does not contain the reason string (PS15)", async () => {
  const store = new InMemoryPreScreenStore()
  const pipeline = new PreScreenPipeline({
    questions: {
      q1: makeQ("q1", [
        { perKeyword: [{ keyword: "q1", match: 0.5, confidence: 0.9, evidence: "", reasoning: "" }] },
        { perKeyword: [{ keyword: "q1", match: 0.4, confidence: 0.9, evidence: "", reasoning: "" }] },
        { perKeyword: [{ keyword: "q1", match: 0.3, confidence: 0.9, evidence: "", reasoning: "" }] },
      ]),
    },
    store,
  })
  await setupSession(pipeline, store, [{ qId: "q1", type: "MUST_HAVE", weight: 1 }])
  await pipeline.runTurn({
    sessionId: "s1", reply: "x", lang: "en", nowIso: "2026-05-12T00:01:00Z", judgeCtx: ctx,
  })
  await pipeline.runTurn({
    sessionId: "s1", reply: "still x", lang: "en", nowIso: "2026-05-12T00:02:00Z", judgeCtx: ctx,
  })
  const r = await pipeline.runTurn({
    sessionId: "s1", reply: "no other example", lang: "en", nowIso: "2026-05-12T00:03:00Z", judgeCtx: ctx,
  })
  // Reason contains "MUST_HAVE failed at qId=q1 s=0.50" — must NOT leak to text
  assert.ok(!r.text.includes("MUST_HAVE"))
  assert.ok(!r.text.includes("0.50"))
  assert.ok(!r.text.includes("qId=q1"))
  // But state.terminalReason captures it for dashboard
  assert.ok(r.state.terminalReason?.includes("MUST_HAVE"))
})
