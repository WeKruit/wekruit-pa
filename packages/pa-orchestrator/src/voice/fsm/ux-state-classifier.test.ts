/**
 * Phase 37 T1 — ux-state classifier unit tests (English-only).
 *
 * Coverage:
 * - 5 states × happy-path en
 * - Gravity tie-break (QuietWitness > SoftConcerned > FirmDirect > PlayfulTease > WarmCurious)
 * - Default fallback (empty / very-short → WarmCurious)
 * - Latency assertion (< 5ms over 50 invocations)
 */
import assert from "node:assert/strict"
import test from "node:test"

import { classifyUxState } from "./ux-state-classifier.js"

// ---------------------------------------------------------------------------
// WarmCurious — neutral / curious / greeting
// ---------------------------------------------------------------------------

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
    user: "so tired. hopeless. cant go on. no point at all.",
  })
  assert.equal(r.uxState, "QuietWitness")
})

test("QuietWitness override beats SoftConcerned-only on long+heavy+no-q", () => {
  const r = classifyUxState({
    user: "i already cant go on. so hopeless. no point in any of it.",
  })
  assert.equal(r.uxState, "QuietWitness")
})

test("SoftConcerned NOT QuietWitness — venting but with question", () => {
  // Has tired + question — should stay SoftConcerned, not jump to QuietWitness.
  const r = classifyUxState({
    user: "so tired, what now?",
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
  const r = classifyUxState({ user: "the weather is nice today" })
  assert.equal(r.uxState, "WarmCurious")
})

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

test("classifier latency < 5ms p95 over 50 invocations", () => {
  const samples: number[] = []
  const inputs = [
    "hi there, just wondering",
    "so tired, what do i do",
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
  const r = classifyUxState({ user: "hi there" })
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
