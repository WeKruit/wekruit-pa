import assert from "node:assert/strict"
import test from "node:test"
import { normalizeForIMessage, STRIP_PARAMS } from "./output-normalizer.js"

const teslaMixed =
  "**特斯拉一季度业绩上升** ([axios.com](https://axios.com/2026/04/26/tesla-q1?utm_source=openai&utm_medium=referral))"

test("mixed markdown tesla/utm case", () => {
  const r = normalizeForIMessage(teslaMixed, { maxLength: 600 })
  assert.match(r.text, /特斯拉一季度业绩上升/)
  assert.match(r.text, /https:\/\/axios.com\/2026\/04\/26\/tesla-q1/)
  assert.doesNotMatch(r.text, /\*\*/)
  assert.doesNotMatch(r.text, /\]\(/)
  assert.ok(!r.text.includes("utm_source"))
  assert.ok(!r.text.includes("utm_medium"))
  assert.ok(r.droppedTracking.includes("utm_source") || r.droppedTracking.includes("utm_medium"))
})

test("UTM strip preserves non-tracking param", () => {
  const r = normalizeForIMessage("check this https://example.com/x?utm_source=newsletter&id=42", { maxLength: 600 })
  assert.equal(r.text, "check this https://example.com/x?id=42")
  assert.deepEqual(r.droppedTracking, ["utm_source"])
})

test("nested triple asterisk", () => {
  const r = normalizeForIMessage("***bold-italic***", { maxLength: 600 })
  assert.doesNotMatch(r.text, /\*/)
  assert.equal(r.text, "bold-italic")
})

test("fenced code block", () => {
  const r = normalizeForIMessage("```js\nconsole.log('hi')\n```", { maxLength: 600 })
  assert.equal(r.text, "console.log('hi')")
})

test("very long over 600 with chunker", () => {
  const sentence = "This is a sentence. ".repeat(80)
  const r = normalizeForIMessage(sentence, { maxLength: 600, planChunkOpts: { random: () => 0.5 } })
  assert.equal(r.wasOverLength, true)
  if (r.chunks) {
    assert.ok(r.chunks.every((c) => c.length <= 600))
  }
})

test("empty and whitespace", () => {
  const a = normalizeForIMessage("", { maxLength: 600 })
  assert.equal(a.text, "")
  assert.equal(a.droppedTracking.length, 0)
  assert.equal(a.wasOverLength, false)
  const b = normalizeForIMessage("   \n  \n", { maxLength: 600 })
  assert.equal(b.text, "")
})

test("Chinese list markers to middle dot", () => {
  const r = normalizeForIMessage("- 第一项\n- 第二项\n- 第三项", { maxLength: 600 })
  assert.match(r.text, /· 第一项/)
  assert.doesNotMatch(r.text, /^- /m)
})

test("fence only python", () => {
  const r = normalizeForIMessage("```python\ndef f(): pass\n```", { maxLength: 600 })
  assert.equal(r.text, "def f(): pass")
})

test("idempotence", () => {
  const samples = [teslaMixed, "plain ok", "- a\n- b", "`x` and **y**"]
  for (const s of samples) {
    const once = normalizeForIMessage(s, { maxLength: 600 })
    const twice = normalizeForIMessage(once.text, { maxLength: 600 })
    assert.equal(twice.text, once.text, `drift: ${s.slice(0, 40)}`)
  }
})

test("STRIP_PARAMS frozen shape", () => {
  assert.ok(STRIP_PARAMS.includes("utm_source"))
})
