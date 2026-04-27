import test from "node:test"
import assert from "node:assert/strict"
import { normalizeForIMessage, isIMessageRenderSafe, STRIP_PARAMS } from "./output-normalizer.js"

test("mixed markdown + UTM — Tesla-style line", () => {
  const input =
    "**特斯拉一季度业绩上升** ([axios.com](https://axios.com/2026/04/26/tesla-q1?utm_source=openai&utm_medium=referral))"
  const { text, droppedTracking } = normalizeForIMessage(input)
  assert.ok(text.includes("特斯拉一季度业绩上升"))
  assert.ok(text.includes("https://axios.com/2026/04/26/tesla-q1"))
  assert.ok(!text.includes("**"))
  assert.ok(!text.includes("]("))
  assert.ok(!text.includes("utm_source"))
  assert.ok(droppedTracking.includes("utm_source"))
  assert.ok(droppedTracking.includes("utm_medium"))
})

test("UTM strip preserves id= on bare URL", () => {
  const { text, droppedTracking } = normalizeForIMessage(
    "check this https://example.com/x?utm_source=newsletter&id=42"
  )
  assert.equal(text, "check this https://example.com/x?id=42")
  assert.deepEqual(droppedTracking, ["utm_source"])
})

test("nested emphasis ***a***", () => {
  const { text } = normalizeForIMessage("***bold-italic***")
  assert.equal(text, "bold-italic")
  assert.ok(!text.includes("*"))
})

test("fenced code", () => {
  const { text } = normalizeForIMessage("```js\nconsole.log('hi')\n```")
  assert.equal(text, "console.log('hi')")
})

test("very long input yields chunks or truncate", () => {
  const sentence = "A".repeat(200) + ". " + "B".repeat(200) + ". " + "C".repeat(200) + "."
  const { wasOverLength, chunks, text } = normalizeForIMessage(sentence, { maxLength: 600 })
  assert.equal(wasOverLength, true)
  if (chunks) {
    assert.ok(chunks.length >= 2)
    assert.ok(chunks.every((c) => c.length <= 600))
  } else {
    assert.ok(text.endsWith("…") || text.length <= 600)
  }
})

test("empty / whitespace", () => {
  assert.equal(normalizeForIMessage("").text, "")
  const w = normalizeForIMessage("   \n  \n")
  assert.equal(w.text, "")
  assert.equal(w.wasOverLength, false)
})

test("all-Chinese list markers", () => {
  const { text } = normalizeForIMessage("- 第一项\n- 第二项\n- 第三项")
  assert.ok(text.includes("· 第一项"))
  assert.ok(text.includes("· 第二项"))
})

test("pure fenced without wrapper", () => {
  const { text } = normalizeForIMessage("```python\ndef f(): pass\n```")
  assert.equal(text, "def f(): pass")
})

test("idempotence on samples", () => {
  const samples = [
    "**x** and `y`",
    "https://x.com/?utm_source=1&ref=y",
    "- a\n- b",
  ]
  for (const s of samples) {
    const once = normalizeForIMessage(s)
    const twice = normalizeForIMessage(once.text)
    assert.equal(once.text, twice.text, `idempotent: ${s}`)
  }
})

test("markdown link where label equals href", () => {
  const { text } = normalizeForIMessage("[https://example.com](https://example.com)")
  assert.match(text, /^https:\/\/example.com\/?$/)
})

test("numbered list preserved", () => {
  const s = "1. first\n2. second"
  assert.equal(normalizeForIMessage(s).text, s)
})

test("triple+ blank lines collapsed", () => {
  const { text } = normalizeForIMessage("a\n\n\n\nb")
  assert.equal(text, "a\n\nb")
})

test("STRIP_PARAMS is non-empty and frozen-ish", () => {
  assert.ok(STRIP_PARAMS.length > 5)
})

test("isIMessageRenderSafe", () => {
  assert.equal(isIMessageRenderSafe("plain ok"), true)
  assert.equal(isIMessageRenderSafe("**nope**"), false)
})
