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

test("fullwidth bold markers stripped", () => {
  const r = normalizeForIMessage("＊＊粗体＊＊ normal", { maxLength: 600 })
  assert.equal(r.text, "粗体 normal")
  assert.doesNotMatch(r.text, /＊/)
})

test("numbered list lines lose digit prefix", () => {
  const r = normalizeForIMessage("1. 第一步\n2. 第二步", { maxLength: 600 })
  assert.match(r.text, /· 第一步/)
  assert.doesNotMatch(r.text, /^1\./m)
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

test("Phase 40 — flatten nested citation single (domain (url))", () => {
  const r = normalizeForIMessage(
    "I saw a few articles on this (fortune.com (https://www.fortune.com/2026/04/news)).",
    { maxLength: 600 }
  )
  assert.match(r.text, /https:\/\/www\.fortune\.com\/2026\/04\/news/)
  assert.doesNotMatch(r.text, /fortune\.com\s+\(/)
  assert.doesNotMatch(r.text, /\(\s*https/)
})

test("Phase 40 — flatten nested citation multiple sources", () => {
  const r = normalizeForIMessage(
    "Several outlets covered it (fortune.com (https://fortune.com/x) and axios.com (https://axios.com/y)).",
    { maxLength: 600 }
  )
  assert.match(r.text, /https:\/\/fortune\.com\/x/)
  assert.match(r.text, /https:\/\/axios\.com\/y/)
  assert.doesNotMatch(r.text, /fortune\.com\s+\(/)
  assert.doesNotMatch(r.text, /axios\.com\s+\(/)
})

test("Phase 40 — bare-domain prefix + (url) collapses to bare url", () => {
  const r = normalizeForIMessage(
    "see fortune.com (https://fortune.com/article) for the source",
    { maxLength: 600 }
  )
  assert.match(r.text, /https:\/\/fortune\.com\/article/)
  assert.doesNotMatch(r.text, /fortune\.com\s+\(/)
})

test("Phase 40 — dangling bare-domain in parens dropped", () => {
  const r = normalizeForIMessage("Tesla up this quarter (axios.com).", { maxLength: 600 })
  assert.doesNotMatch(r.text, /axios\.com/)
  assert.match(r.text, /Tesla up this quarter/)
})

test("Phase 40 — citation flatten idempotent + does not break clean URL", () => {
  const clean = "check this out https://fortune.com/article"
  const r = normalizeForIMessage(clean, { maxLength: 600 })
  assert.equal(r.text, clean)
  const r2 = normalizeForIMessage(r.text, { maxLength: 600 })
  assert.equal(r2.text, r.text)
})

test("Phase 40 — long markdown link → newline-separated bare URL (iMessage preview)", () => {
  // iMessage Smart Linkify only previews URLs when they're standalone tokens.
  // Paren-wrapped or otherwise-attached URLs do NOT preview. Long URLs go on
  // their own line so the preview card renders below the prose.
  const r = normalizeForIMessage(
    "Read more here [Fortune Magazine Article on Q1 Earnings](https://www.fortune.com/2026/04/26/tesla-q1-earnings-up)",
    { maxLength: 600 }
  )
  assert.match(r.text, /https:\/\/www\.fortune\.com\/2026\/04\/26\/tesla-q1-earnings-up/)
  // Must NOT be wrapped in parens (kills preview)
  assert.doesNotMatch(r.text, /\(https:/)
  // Must be on its own line OR preceded by whitespace/newline
  assert.match(r.text, /\n\s*https:\/\//)
})

test("Phase 40 — short markdown link → inline bare URL (still previews)", () => {
  const r = normalizeForIMessage(
    "see [link](https://x.com/p)",
    { maxLength: 600 }
  )
  assert.match(r.text, /https:\/\/x\.com\/p/)
  assert.doesNotMatch(r.text, /\(https/)
})
