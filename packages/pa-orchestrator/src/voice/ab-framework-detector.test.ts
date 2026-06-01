import assert from "node:assert/strict"
import test from "node:test"
import {
  detectABFramework,
  stripABFramework,
} from "./ab-framework-detector.js"

// ---------------------------------------------------------------------------
// Detector — match cases
// ---------------------------------------------------------------------------

test("en: If you want to X, you could Y → matches", () => {
  const r = detectABFramework("If you want to switch to PM, you could try product analyst first")
  assert.equal(r.matched, true)
  assert.equal(r.pattern, "en_conditional_if_then")
})

test("en: If you'd like to X, Y → matches (apostrophe head)", () => {
  const r = detectABFramework("If you'd like to switch to PM, try product analyst first")
  assert.equal(r.matched, true)
  assert.equal(r.pattern, "en_conditional_if_then")
})

// ---------------------------------------------------------------------------
// Detector — no-match cases (false-positive guards)
// ---------------------------------------------------------------------------

test("en: 'I want to X' (no leading 'if you') → no match", () => {
  const r = detectABFramework("I want to switch to PM, can you help?")
  assert.equal(r.matched, false)
})

test("en: 'X or Y?' question → no match (different pattern, owned by stripABProbeFromTail)", () => {
  // checkABFramework in voice-axes.mjs handles this; our module ignores it.
  const r = detectABFramework("Want to talk about it or just vent?")
  assert.equal(r.matched, false)
})

// ---------------------------------------------------------------------------
// Strip — happy path
// ---------------------------------------------------------------------------

test("strip en: If you want to switch to PM, you could try product analyst first", () => {
  const r = stripABFramework(
    "If you want to switch to PM, you could try product analyst first"
  )
  assert.equal(r.applied, true)
  assert.equal(r.pattern, "en_conditional_if_then")
  assert.doesNotMatch(r.text, /If you want/iu)
  assert.match(r.text, /product analyst first/u)
  // First surviving char should be capitalized (sentence start orthography).
  assert.match(r.text, /^[A-Z]/u)
})

// ---------------------------------------------------------------------------
// Strip — edge cases
// ---------------------------------------------------------------------------

test("strip is idempotent (re-running yields same)", () => {
  const input = "If you want to switch to PM, you could try product analyst first"
  const once = stripABFramework(input)
  const twice = stripABFramework(once.text)
  assert.equal(twice.applied, false)
  assert.equal(twice.text, once.text)
})

test("strip preserves leading sentence when match is in second sentence", () => {
  // First sentence is normal advice, conditional appears after period.
  const input = "Sounds rough. If you want to switch jobs, you could check the base first"
  const r = stripABFramework(input)
  assert.equal(r.applied, true)
  // "Sounds rough." must remain at the start.
  assert.match(r.text, /^Sounds rough\./u)
  // Then-clause survives (first surviving char re-capitalized).
  assert.match(r.text, /check the base first/iu)
  // Head removed.
  assert.doesNotMatch(r.text, /If you want to switch jobs/iu)
})

test("strip on empty / null / non-string is no-op", () => {
  assert.equal(stripABFramework("").applied, false)
  // @ts-expect-error — defensive guard tests
  assert.equal(stripABFramework(null).applied, false)
  // @ts-expect-error — defensive guard tests
  assert.equal(stripABFramework(undefined).applied, false)
})
