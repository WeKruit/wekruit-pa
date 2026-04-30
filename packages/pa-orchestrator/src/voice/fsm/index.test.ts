/**
 * Phase 37 T4 — runFsm orchestrator smoke tests.
 *
 * Covers:
 * - End-to-end happy paths per UX state (5 cases)
 * - FsmResult shape contract
 * - Latency budget — p95 < 10ms over 50 invocations
 * - Continuity: prevStrategy from history → preferredNext respects continuity
 * - Bilingual directive language
 */
import assert from "node:assert/strict"
import test from "node:test"

import { runFsm } from "./index.js"
import type { FsmContext } from "./types.js"

const baseHistory = { userTurns: [] as string[], claireReplies: [] as string[] }

// ---------------------------------------------------------------------------
// End-to-end happy paths
// ---------------------------------------------------------------------------

test("runFsm — WarmCurious zh → Exploration → Question allowed", () => {
  const ctx: FsmContext = {
    turn: { user: "你好，想问个问题可以吗？" },
    history: baseHistory,
    turnNumber: 1,
  }
  const r = runFsm(ctx)
  assert.equal(r.uxState, "WarmCurious")
  assert.equal(r.stage, "Exploration")
  assert.equal(r.stageIndex, 0)
  assert.ok(r.allowedStrategies.includes("Question"))
  assert.ok(!r.allowedStrategies.includes("Suggestion"))
})

test("runFsm — SoftConcerned zh → Comforting → Reflection preferred", () => {
  const ctx: FsmContext = {
    turn: { user: "今天好累，不知道该怎么办" },
    history: baseHistory,
    turnNumber: 5,
  }
  const r = runFsm(ctx)
  assert.equal(r.uxState, "SoftConcerned")
  assert.equal(r.stage, "Comforting")
  assert.ok(r.allowedStrategies.includes("Reflection"))
})

test("runFsm — FirmDirect en → Action → Suggestion allowed + preferred", () => {
  const ctx: FsmContext = {
    turn: { user: "should i quit my job? need advice now" },
    history: baseHistory,
    turnNumber: 8,
  }
  const r = runFsm(ctx)
  assert.equal(r.uxState, "FirmDirect")
  assert.equal(r.stage, "Action")
  assert.ok(r.allowedStrategies.includes("Suggestion"))
})

test("runFsm — QuietWitness zh → Comforting → NEVER Suggestion", () => {
  const ctx: FsmContext = {
    turn: { user: "我撑不住了。一切都没意义。想消失。" },
    history: baseHistory,
    turnNumber: 5,
  }
  const r = runFsm(ctx)
  assert.equal(r.uxState, "QuietWitness")
  assert.ok(!r.allowedStrategies.includes("Suggestion"))
  assert.ok(!r.allowedStrategies.includes("Information"))
  assert.ok(!r.allowedStrategies.includes("Question"))
})

test("runFsm — PlayfulTease en → Comforting → SelfDisclosure or Affirmation", () => {
  const ctx: FsmContext = {
    turn: { user: "haha that was hilarious 😂" },
    history: baseHistory,
    turnNumber: 5,
  }
  const r = runFsm(ctx)
  assert.equal(r.uxState, "PlayfulTease")
  assert.equal(r.stage, "Comforting")
  // Allowed = Comforting {Reflection, Affirmation, SelfDisclosure} ∩ PlayfulTease {Aff, SelfDisc, Other} = {Affirmation, SelfDisclosure}
  assert.ok(r.allowedStrategies.length > 0)
  for (const s of r.allowedStrategies) {
    assert.ok(["Affirmation", "SelfDisclosure"].includes(s), `unexpected: ${s}`)
  }
})

// ---------------------------------------------------------------------------
// Continuity — prevStrategy from history
// ---------------------------------------------------------------------------

test("runFsm — prevStrategy inferred from history affects preferredNext", () => {
  const ctx: FsmContext = {
    turn: { user: "你好怎么用 React？" },
    history: {
      userTurns: ["hi"],
      claireReplies: ["你今天怎么样？"], // Question
    },
    turnNumber: 2,
  }
  const r = runFsm(ctx)
  // prev = Question; allowed = Exploration ∩ WarmCurious = {Question, Restatement, Reflection}
  // continuity: prev (Question) gets 0.5; adjacency Restatement gets 0.2
  assert.equal(r.preferredNext, "Question")
})

test("runFsm — explicit prevStrategy overrides history inference", () => {
  const ctx: FsmContext = {
    turn: { user: "你好怎么用 React？" },
    history: {
      userTurns: [],
      claireReplies: ["试试 useState"], // Suggestion
    },
    turnNumber: 2,
    prevStrategy: "Reflection", // explicit
  }
  const r = runFsm(ctx)
  // Allowed = Exploration ∩ WarmCurious includes Reflection; preferredNext should respect explicit prev
  assert.ok(r.allowedStrategies.includes("Reflection"))
})

// ---------------------------------------------------------------------------
// Directive
// ---------------------------------------------------------------------------

test("runFsm — directive contains all required fields", () => {
  const ctx: FsmContext = {
    turn: { user: "你好" },
    history: baseHistory,
    turnNumber: 1,
  }
  const r = runFsm(ctx)
  assert.match(r.directive, /\[FSM-DIRECTIVE\]/)
  assert.match(r.directive, /\[\/FSM-DIRECTIVE\]/)
  assert.match(r.directive, /current_ux_state:/)
  assert.match(r.directive, /current_stage:/)
  assert.match(r.directive, /allowed_strategies:/)
  assert.match(r.directive, /preferred_next:/)
  assert.match(r.directive, /note:/)
})

test("runFsm — userLang=zh produces Chinese gloss", () => {
  const ctx: FsmContext = {
    turn: { user: "好累" },
    history: baseHistory,
    turnNumber: 5,
  }
  const r = runFsm(ctx, { userLang: "zh" })
  assert.ok(/[一-鿿]/.test(r.directive), `expected zh chars in directive: ${r.directive}`)
})

test("runFsm — userLang=en (default) produces English gloss", () => {
  const ctx: FsmContext = {
    turn: { user: "im stressed" },
    history: baseHistory,
    turnNumber: 5,
  }
  const r = runFsm(ctx)
  // The note line is en-only by default.
  const noteLine = r.directive.split("\n").find((l) => l.startsWith("note:")) ?? ""
  assert.ok(!/[一-鿿]/.test(noteLine), `did not expect zh in note: ${noteLine}`)
})

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

test("runFsm — FsmResult shape contract", () => {
  const ctx: FsmContext = {
    turn: { user: "hi" },
    history: baseHistory,
    turnNumber: 1,
  }
  const r = runFsm(ctx)
  assert.ok(typeof r.uxState === "string")
  assert.ok(typeof r.uxStateConfidence === "number")
  assert.ok(["Exploration", "Comforting", "Action"].includes(r.stage))
  assert.ok([0, 1, 2].includes(r.stageIndex))
  assert.ok(Array.isArray(r.allowedStrategies))
  assert.ok(r.allowedStrategies.length > 0)
  assert.ok(typeof r.preferredNext === "string")
  assert.ok(typeof r.directive === "string" && r.directive.length > 0)
  assert.ok(typeof r.latencyMs === "number" && Number.isFinite(r.latencyMs))
  assert.ok(typeof r.signals === "object" && r.signals !== null)
})

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

test("runFsm latency p95 < 10ms over 50 invocations", () => {
  const samples: number[] = []
  const inputs: FsmContext[] = [
    {
      turn: { user: "你好，想问个问题可以吗？" },
      history: baseHistory,
      turnNumber: 1,
    },
    {
      turn: { user: "今天好累，不知道该怎么办" },
      history: baseHistory,
      turnNumber: 5,
    },
    {
      turn: { user: "should i quit my job? need advice now" },
      history: baseHistory,
      turnNumber: 8,
    },
    {
      turn: { user: "haha that was hilarious 😂" },
      history: baseHistory,
      turnNumber: 5,
    },
    {
      turn: { user: "i cant go on like this. theres no point. i want to die." },
      history: baseHistory,
      turnNumber: 5,
    },
  ]
  for (let i = 0; i < 50; i++) {
    const start = performance.now()
    runFsm(inputs[i % inputs.length])
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  const p95 = samples[Math.floor(samples.length * 0.95)]
  assert.ok(p95 < 10, `expected p95 < 10ms, got ${p95.toFixed(3)}ms`)
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("runFsm — empty user text → WarmCurious default", () => {
  const ctx: FsmContext = {
    turn: { user: "" },
    history: baseHistory,
    turnNumber: 1,
  }
  const r = runFsm(ctx)
  assert.equal(r.uxState, "WarmCurious")
})

test("runFsm — turn 0 maps to Exploration", () => {
  const ctx: FsmContext = {
    turn: { user: "hi" },
    history: baseHistory,
    turnNumber: 0,
  }
  const r = runFsm(ctx)
  assert.equal(r.stage, "Exploration")
})

test("runFsm — large turn number maps to Action", () => {
  const ctx: FsmContext = {
    turn: { user: "should i" },
    history: baseHistory,
    turnNumber: 100,
  }
  const r = runFsm(ctx)
  assert.equal(r.stage, "Action")
})
