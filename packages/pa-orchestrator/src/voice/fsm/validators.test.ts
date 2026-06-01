/**
 * Phase 37 T2 — strategy_fit validator tests + Phase 33 parity audit
 * (English-only).
 *
 * Parity oracle: dynamic-import voice-axes.mjs:inferStrategy. Asserts:
 * - fixed English inputs return identical strategy
 * - confidence may differ by ≤ 0.1 (TS port allows wider keyword bank
 *   evolution; documented)
 */
import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import path from "node:path"

import {
  inferPrevStrategyFromHistory,
  inferStrategy,
  runFsmGate,
  validateStrategyFit,
} from "./validators.js"
import { allowedStrategies } from "./transitions.js"

import type { Strategy } from "./types.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const VOICE_AXES_MJS = path.resolve(
  __dirname,
  "../../../../../tests/scenarios/lib/voice-axes.mjs"
)

// ---------------------------------------------------------------------------
// Fixed English inputs for parity audit
// ---------------------------------------------------------------------------

const PARITY_INPUTS: { reply: string; expectedStrategy?: Strategy }[] = [
  { reply: "How are you feeling today?", expectedStrategy: "Question" },
  { reply: "So you're saying she just left?", expectedStrategy: "Restatement" },
  { reply: "That sounds like a lot.", expectedStrategy: "Reflection" },
  { reply: "I once had a similar thing happen.", expectedStrategy: "SelfDisclosure" },
  { reply: "That makes sense, you got this.", expectedStrategy: "Affirmation" },
  { reply: "Maybe try writing it down first.", expectedStrategy: "Suggestion" },
]

test("Phase 33 parity — inferStrategy returns same strategy on fixed English inputs", async () => {
  const mjs = await import(VOICE_AXES_MJS)
  for (const { reply } of PARITY_INPUTS) {
    const ts = inferStrategy(reply)
    const m = mjs.inferStrategy(reply)
    assert.equal(ts.strategy, m.strategy, `mismatch on "${reply}": ts=${ts.strategy} mjs=${m.strategy}`)
    // Confidence within 0.1
    assert.ok(
      Math.abs(ts.confidence - m.confidence) <= 0.1,
      `confidence drift on "${reply}": ts=${ts.confidence} mjs=${m.confidence}`
    )
  }
})

test("Phase 33 parity — empty / whitespace input → Other", async () => {
  const mjs = await import(VOICE_AXES_MJS)
  for (const reply of ["", "   ", "\n"]) {
    const ts = inferStrategy(reply)
    const m = mjs.inferStrategy(reply)
    assert.equal(ts.strategy, m.strategy)
    assert.equal(ts.strategy, "Other")
  }
})

// ---------------------------------------------------------------------------
// inferStrategy semantics
// ---------------------------------------------------------------------------

test("inferStrategy — en question via 'how'", () => {
  const r = inferStrategy("How have things been lately?")
  assert.equal(r.strategy, "Question")
})

test("inferStrategy — short non-keyword text → Other", () => {
  const r = inferStrategy("ok")
  assert.equal(r.strategy, "Other")
})

test("inferStrategy — long non-keyword statement → Information", () => {
  const r = inferStrategy("this message is very detailed and needs careful reading")
  assert.equal(r.strategy, "Information")
})

test("inferStrategy — en suggestion via 'try'", () => {
  const r = inferStrategy("Maybe try a different framework.")
  assert.equal(r.strategy, "Suggestion")
})

// ---------------------------------------------------------------------------
// validateStrategyFit + runFsmGate
// ---------------------------------------------------------------------------

test("validateStrategyFit — Reflection ∈ Comforting allowed-set", () => {
  const allowed = allowedStrategies(1, "SoftConcerned")
  const r = validateStrategyFit("That sounds like a lot.", allowed)
  assert.equal(r.strategy, "Reflection")
  assert.equal(r.allowed, true)
})

test("validateStrategyFit — Suggestion NOT in Exploration allowed-set", () => {
  const allowed = allowedStrategies(0, "WarmCurious")
  const r = validateStrategyFit("Maybe try this approach.", allowed)
  assert.equal(r.strategy, "Suggestion")
  assert.equal(r.allowed, false)
})

test("validateStrategyFit — Suggestion NOT in QuietWitness allowed-set even at Action stage", () => {
  const allowed = allowedStrategies(2, "QuietWitness")
  const r = validateStrategyFit("Maybe try resting first.", allowed)
  assert.equal(r.strategy, "Suggestion")
  assert.equal(r.allowed, false)
})

test("validateStrategyFit — Suggestion ALLOWED in FirmDirect Action stage", () => {
  const allowed = allowedStrategies(2, "FirmDirect")
  const r = validateStrategyFit("Maybe try writing a quick list first.", allowed)
  assert.equal(r.strategy, "Suggestion")
  assert.equal(r.allowed, true)
})

test("runFsmGate — pass when reply ∈ allowed-set", () => {
  const r = runFsmGate("That sounds like a lot, you got this.", {
    uxState: "SoftConcerned",
    turnNumber: 5,
  })
  assert.equal(r.pass, true)
  assert.equal(r.allowed, true)
})

test("runFsmGate — fail with descriptive reason when reply ∉ allowed-set", () => {
  const r = runFsmGate("Maybe try a new tool.", {
    uxState: "WarmCurious",
    turnNumber: 1,
  })
  assert.equal(r.pass, false)
  assert.equal(r.strategy, "Suggestion")
  assert.match(r.reason, /Suggestion NOT in allowed-set/)
})

test("runFsmGate — empty reply → Other strategy", () => {
  const r = runFsmGate("", { uxState: "WarmCurious", turnNumber: 1 })
  assert.equal(r.strategy, "Other")
})

// ---------------------------------------------------------------------------
// inferPrevStrategyFromHistory
// ---------------------------------------------------------------------------

test("inferPrevStrategyFromHistory — empty history → undefined", () => {
  assert.equal(inferPrevStrategyFromHistory([]), undefined)
})

test("inferPrevStrategyFromHistory — picks last non-empty reply", () => {
  const r = inferPrevStrategyFromHistory([
    "How are you today?",
    "That sounds like a lot.",
  ])
  // Last is "That sounds like a lot." → Reflection
  assert.equal(r, "Reflection")
})

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

test("validator latency < 3ms p95 over 50 invocations", () => {
  const samples: number[] = []
  const replies = [
    "That sounds like a lot.",
    "Maybe try writing it down first.",
    "You got this, you've come a long way.",
    "How are you feeling today?",
    "I once had a similar thing happen.",
  ]
  for (let i = 0; i < 50; i++) {
    const start = performance.now()
    inferStrategy(replies[i % replies.length])
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  const p95 = samples[Math.floor(samples.length * 0.95)]
  assert.ok(p95 < 3, `expected p95 < 3ms, got ${p95.toFixed(3)}ms`)
})
