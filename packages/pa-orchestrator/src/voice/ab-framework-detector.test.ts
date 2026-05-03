import assert from "node:assert/strict"
import test from "node:test"
import {
  detectABFramework,
  stripABFramework,
} from "./ab-framework-detector.js"

// ---------------------------------------------------------------------------
// Detector — match cases
// ---------------------------------------------------------------------------

test("zh: 如果你想 X，那可以 Y → matches", () => {
  const r = detectABFramework("如果你想转 PM 方向，那可以先做 product analyst")
  assert.equal(r.matched, true)
  assert.equal(r.pattern, "zh_conditional_if_then")
  assert.ok(r.segment && r.segment.includes("如果你想"))
})

test("zh: 如果想 X，可以 Y → matches (variant head)", () => {
  const r = detectABFramework("如果想换工作，可以先看看 base")
  assert.equal(r.matched, true)
  assert.equal(r.pattern, "zh_conditional_if_then")
})

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

test("zh: 如果 X (no 你想) → no match", () => {
  // Plain "如果" without "你想" / "想" qualifier shouldn't trip — that's
  // generic conditional reasoning, not the clinical advice frame.
  const r = detectABFramework("如果天气不好，我们就改约")
  assert.equal(r.matched, false)
})

test("en: 'I want to X' (no leading 'if you') → no match", () => {
  const r = detectABFramework("I want to switch to PM, can you help?")
  assert.equal(r.matched, false)
})

test("en: 'X or Y?' question → no match (different pattern, owned by stripABProbeFromTail)", () => {
  // checkABFramework in voice-axes.mjs handles this; our module ignores it.
  const r = detectABFramework("Want to talk about it or just vent?")
  assert.equal(r.matched, false)
})

test("zh: 你想 Y 吗？ (open question, no 如果) → no match", () => {
  const r = detectABFramework("你想换工作吗？")
  assert.equal(r.matched, false)
})

// ---------------------------------------------------------------------------
// Strip — happy path
// ---------------------------------------------------------------------------

test("strip zh: 如果你想转 PM 方向，那可以先做 product analyst", () => {
  const r = stripABFramework("如果你想转 PM 方向，那可以先做 product analyst")
  assert.equal(r.applied, true)
  assert.equal(r.pattern, "zh_conditional_if_then")
  // Then-clause survives — "先做 product analyst" must remain
  assert.match(r.text, /先做 product analyst/u)
  // Head must be gone
  assert.doesNotMatch(r.text, /如果你想/u)
})

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
  const input = "如果你想转 PM 方向，那可以先做 product analyst"
  const once = stripABFramework(input)
  const twice = stripABFramework(once.text)
  assert.equal(twice.applied, false)
  assert.equal(twice.text, once.text)
})

test("strip preserves leading sentence when match is in second sentence", () => {
  // First sentence is normal advice, conditional appears after period.
  const input = "听起来挺累的。如果你想换工作，那可以先看看 base"
  const r = stripABFramework(input)
  assert.equal(r.applied, true)
  // "听起来挺累的。" must remain at the start.
  assert.match(r.text, /^听起来挺累的。/u)
  // Then-clause survives.
  assert.match(r.text, /先看看 base/u)
  // Head removed.
  assert.doesNotMatch(r.text, /如果你想换工作/u)
})

test("strip on empty / null / non-string is no-op", () => {
  assert.equal(stripABFramework("").applied, false)
  // @ts-expect-error — defensive guard tests
  assert.equal(stripABFramework(null).applied, false)
  // @ts-expect-error — defensive guard tests
  assert.equal(stripABFramework(undefined).applied, false)
})

test("strip falls back to original when result would be empty", () => {
  // Pure head with nothing else — strip would leave empty. We guard and return original.
  const onlyHead = "如果你想，"
  const r = stripABFramework(onlyHead)
  // Either no match (regex requires non-empty X clause) or applied=false fallback.
  // Either way, the text is preserved.
  assert.equal(r.text, onlyHead)
  assert.equal(r.applied, false)
})
