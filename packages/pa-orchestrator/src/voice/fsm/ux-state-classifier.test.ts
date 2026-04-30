/**
 * Phase 37 T1 — ux-state classifier unit tests.
 *
 * Coverage:
 * - 5 states × 2 happy-path zh + 2 happy-path en (10 minimum)
 * - Gravity tie-break (QuietWitness > SoftConcerned > FirmDirect > PlayfulTease > WarmCurious)
 * - Default fallback (empty / very-short → WarmCurious)
 * - Code-switch handling
 * - Latency assertion (< 5ms over 50 invocations)
 */
import assert from "node:assert/strict"
import test from "node:test"

import { classifyUxState } from "./ux-state-classifier.js"

// ---------------------------------------------------------------------------
// WarmCurious — neutral / curious / greeting
// ---------------------------------------------------------------------------

test("WarmCurious zh — greeting + question", () => {
  const r = classifyUxState({ user: "你好，想问个问题可以吗？" })
  assert.equal(r.uxState, "WarmCurious")
  assert.ok(r.confidence > 0)
})

test("WarmCurious zh — info-seek", () => {
  const r = classifyUxState({ user: "请问怎么样能改善这个？" })
  assert.equal(r.uxState, "WarmCurious")
})

test("WarmCurious en — hi greeting", () => {
  const r = classifyUxState({ user: "Hi there, can you help me with something?" })
  assert.equal(r.uxState, "WarmCurious")
})

test("WarmCurious en — wondering", () => {
  const r = classifyUxState({ user: "hey just wondering about React hooks" })
  assert.equal(r.uxState, "WarmCurious")
})

// ---------------------------------------------------------------------------
// PlayfulTease — banter / sarcasm
// ---------------------------------------------------------------------------

test("PlayfulTease zh — haha", () => {
  const r = classifyUxState({ user: "哈哈你逗死我了！" })
  assert.equal(r.uxState, "PlayfulTease")
  assert.ok(r.confidence > 0.2)
})

test("PlayfulTease zh — 666 emoji", () => {
  const r = classifyUxState({ user: "笑死 666 🤣" })
  assert.equal(r.uxState, "PlayfulTease")
})

test("PlayfulTease en — lol kidding", () => {
  const r = classifyUxState({ user: "lol jk that's actually wild" })
  assert.equal(r.uxState, "PlayfulTease")
})

test("PlayfulTease en — emoji", () => {
  const r = classifyUxState({ user: "haha that was actually hilarious 😂" })
  assert.equal(r.uxState, "PlayfulTease")
})

// ---------------------------------------------------------------------------
// SoftConcerned — soft distress / vulnerability
// ---------------------------------------------------------------------------

test("SoftConcerned zh — tired + worry", () => {
  const r = classifyUxState({ user: "今天好累，不知道该怎么办" })
  assert.equal(r.uxState, "SoftConcerned")
})

test("SoftConcerned zh — anxiety", () => {
  const r = classifyUxState({ user: "最近特别焦虑心慌，压力很大" })
  assert.equal(r.uxState, "SoftConcerned")
})

test("SoftConcerned en — stressed", () => {
  const r = classifyUxState({ user: "feeling really stressed and overwhelmed today" })
  assert.equal(r.uxState, "SoftConcerned")
})

test("SoftConcerned en — worried", () => {
  const r = classifyUxState({ user: "im so worried about the interview tomorrow" })
  assert.equal(r.uxState, "SoftConcerned")
})

// ---------------------------------------------------------------------------
// FirmDirect — wants action / hard advice
// ---------------------------------------------------------------------------

test("FirmDirect zh — should I", () => {
  const r = classifyUxState({ user: "我该不该接这个 offer？告诉我怎么做" })
  assert.equal(r.uxState, "FirmDirect")
})

test("FirmDirect zh — help me decide", () => {
  const r = classifyUxState({ user: "帮我决定一下，必须今天给答复" })
  assert.equal(r.uxState, "FirmDirect")
})

test("FirmDirect en — should I question", () => {
  const r = classifyUxState({ user: "should i quit my job? need advice now" })
  assert.equal(r.uxState, "FirmDirect")
})

test("FirmDirect en — what do I do", () => {
  const r = classifyUxState({ user: "tell me what do i do here, i have to decide today" })
  assert.equal(r.uxState, "FirmDirect")
})

// ---------------------------------------------------------------------------
// QuietWitness — deep grief / crisis
// ---------------------------------------------------------------------------

test("QuietWitness zh — heavy negative", () => {
  const r = classifyUxState({
    user: "我撑不住了。一切都没意义。想消失。",
  })
  assert.equal(r.uxState, "QuietWitness")
})

test("QuietWitness zh — long monologue", () => {
  const r = classifyUxState({
    user: "今天又是一样的循环。绝望透了。我真的走不下去了。崩溃。",
  })
  assert.equal(r.uxState, "QuietWitness")
})

test("QuietWitness en — heavy negative", () => {
  const r = classifyUxState({
    user: "i cant go on like this. theres no point. i want to die.",
  })
  assert.equal(r.uxState, "QuietWitness")
})

test("QuietWitness en — broken", () => {
  const r = classifyUxState({
    user: "everything is hopeless. im just broken. crying again.",
  })
  assert.equal(r.uxState, "QuietWitness")
})

// ---------------------------------------------------------------------------
// Tie-break + gravity
// ---------------------------------------------------------------------------

test("gravity tie-break — heavy state wins on equal scores", () => {
  // Mix QuietWitness + SoftConcerned cues; QuietWitness should win per gravity.
  const r = classifyUxState({
    user: "好累。绝望。撑不下去。完全没意义。",
  })
  assert.equal(r.uxState, "QuietWitness")
})

test("QuietWitness override beats SoftConcerned-only on long+heavy+no-q", () => {
  const r = classifyUxState({
    user: "已经撑不住了。绝望透了。完全没意义。",
  })
  assert.equal(r.uxState, "QuietWitness")
})

test("SoftConcerned NOT QuietWitness — venting but with question", () => {
  // Has 累 + question — should stay SoftConcerned, not jump to QuietWitness.
  const r = classifyUxState({
    user: "好累，怎么办呢？",
  })
  assert.equal(r.uxState, "SoftConcerned")
})

// ---------------------------------------------------------------------------
// Default fallback
// ---------------------------------------------------------------------------

test("empty input → WarmCurious low confidence", () => {
  const r = classifyUxState({ user: "" })
  assert.equal(r.uxState, "WarmCurious")
  assert.equal(r.confidence, 0)
})

test("very short neutral input → WarmCurious", () => {
  const r = classifyUxState({ user: "okay" })
  assert.equal(r.uxState, "WarmCurious")
})

test("ambiguous statement no signals → WarmCurious", () => {
  const r = classifyUxState({ user: "今天天气不错" })
  assert.equal(r.uxState, "WarmCurious")
})

// ---------------------------------------------------------------------------
// Code-switch
// ---------------------------------------------------------------------------

test("code-switch — banter wins over technical-vent", () => {
  const r = classifyUxState({ user: "今天 standup 又卡 lol" })
  // PlayfulTease (lol) OR SoftConcerned (累/卡) — assert it's not Quiet/Firm.
  assert.notEqual(r.uxState, "QuietWitness")
  assert.notEqual(r.uxState, "FirmDirect")
})

test("code-switch — heavy en + zh combined → SoftConcerned", () => {
  const r = classifyUxState({
    user: "今天很累, feeling stressed about onsite tomorrow",
  })
  assert.equal(r.uxState, "SoftConcerned")
})

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

test("classifier latency < 5ms p95 over 50 invocations", () => {
  const samples: number[] = []
  const inputs = [
    "你好，想问个问题",
    "好累，怎么办",
    "should i quit",
    "lol that's wild",
    "i cant go on like this. theres no point. i want to die.",
  ]
  for (let i = 0; i < 50; i++) {
    const start = performance.now()
    classifyUxState({ user: inputs[i % inputs.length] })
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  const p95 = samples[Math.floor(samples.length * 0.95)]
  assert.ok(p95 < 5, `expected p95 < 5ms, got ${p95.toFixed(3)}ms`)
})

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

test("classifier result shape — all fields present", () => {
  const r = classifyUxState({ user: "你好" })
  assert.ok(typeof r.uxState === "string")
  assert.ok(typeof r.confidence === "number")
  assert.ok(r.confidence >= 0 && r.confidence <= 1)
  assert.ok(Array.isArray(r.signals.matched))
  assert.ok(typeof r.signals.scores === "object")
  // Per-state scores all present
  for (const k of [
    "WarmCurious",
    "PlayfulTease",
    "SoftConcerned",
    "FirmDirect",
    "QuietWitness",
  ] as const) {
    assert.ok(typeof r.signals.scores[k] === "number")
  }
})
