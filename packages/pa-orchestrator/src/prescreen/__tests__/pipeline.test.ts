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
  qs: Array<{ qId: string; type: QuestionType; weight: number }>,
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

test("Phase 76: PreScreenPipeline FAILs when final ratio < threshold", async () => {
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
  const r = await pipeline.runTurn({
    sessionId: "s1", reply: "b", lang: "en", nowIso: "2026-05-12T00:02:00Z", judgeCtx: ctx,
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
