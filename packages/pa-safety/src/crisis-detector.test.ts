/**
 * Phase 51 (v1.5 §3.1) — crisis-detector unit tests.
 *
 * Coverage targets (from P7 Task §"测试要求"):
 *   - 4 true-positive cases (zh + en × ideation/self-harm/plan/ambiguous)
 *   - 4 false-positive cases (rhetorical "活不下去这种工作" / "can't go on with this deadline")
 *   - 4 integration cases (guardCrisisHotline end-to-end + hotline-already-present)
 *
 * Bias: FN cost > FP cost — when ambiguous, prefer triggering. Tests assert
 * that core ideation phrasing always fires while clearly-rhetorical usage
 * is suppressed.
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  detectCrisisInInput,
  replyContainsHotline,
  appendHotlineIfMissing,
  guardCrisisHotline,
  hashForAudit,
  HOTLINE_TRAILERS,
} from "./crisis-detector.js"

// ---------------------------------------------------------------------------
// True-positive: ZH ideation + self-harm + plan + ambiguous
// ---------------------------------------------------------------------------

test("ZH high-confidence — explicit suicide ideation triggers", () => {
  const r = detectCrisisInInput("我真的不知道怎么办了，我想自杀")
  assert.equal(r.detected, true)
  assert.equal(r.confidence, "high")
  assert.equal(r.language, "zh")
  assert.ok(r.signals.length > 0)
  assert.ok(r.signals.some((s) => s.startsWith("zh_high")))
})

test("ZH high-confidence — self-harm phrase triggers", () => {
  const r = detectCrisisInInput("最近又开始割腕了，没人能帮我")
  assert.equal(r.detected, true)
  assert.equal(r.confidence, "high")
  assert.equal(r.language, "zh")
})

test("ZH high-confidence — plan phrasing (一了百了) triggers", () => {
  const r = detectCrisisInInput("我想一了百了")
  assert.equal(r.detected, true)
  assert.equal(r.confidence, "high")
})

test("ZH low-confidence — bare 不想活 (no rhetorical anchor) triggers", () => {
  // Ambiguous in form but with no rhetorical anchor following → must fire.
  // (Anchor "这种" only suppresses when present; here it is not.)
  const r = detectCrisisInInput("撑不下去了，真的不想活")
  assert.equal(r.detected, true)
  assert.equal(r.confidence, "low")
  assert.equal(r.language, "zh")
})

// ---------------------------------------------------------------------------
// True-positive: EN ideation + self-harm + plan + ambiguous
// ---------------------------------------------------------------------------

test("EN high-confidence — kill myself triggers", () => {
  const r = detectCrisisInInput("i want to kill myself, i can't take it anymore")
  assert.equal(r.detected, true)
  assert.equal(r.confidence, "high")
  assert.equal(r.language, "en")
  assert.ok(r.signals.some((s) => s.startsWith("en_high")))
})

test("EN high-confidence — self-harm (cutting) triggers", () => {
  const r = detectCrisisInInput("i started cutting myself again last night")
  assert.equal(r.detected, true)
  assert.equal(r.confidence, "high")
})

test("EN high-confidence — plan/method (overdose) triggers", () => {
  const r = detectCrisisInInput("how many tylenol would it take to overdose")
  assert.equal(r.detected, true)
  assert.equal(r.confidence, "high")
})

test("EN low-confidence — 'end it all' alone triggers", () => {
  // The intent-routing scenario stub uses this exact phrasing.
  const r = detectCrisisInInput("i can't do this anymore. i want to end it all")
  assert.equal(r.detected, true)
  // Either confidence tier is acceptable here — phrase is in the LOW bank
  // but `can't do this anymore` is also LOW; first-fire wins on precedence.
  assert.ok(r.confidence === "low" || r.confidence === "high")
  assert.equal(r.language, "en")
})

// ---------------------------------------------------------------------------
// False-positive: rhetorical phrasing must NOT trigger
// ---------------------------------------------------------------------------

test("ZH false-positive — '活不下去 + 这种工作日子' suppressed by anchor", () => {
  // Classic rhetorical complaint about deadlines/work, not crisis.
  const r = detectCrisisInInput("我快活不下去这种工作日子了，每天加班到三点")
  assert.equal(
    r.detected,
    false,
    "rhetorical 活不下去 + 这种工作日子 must be suppressed"
  )
  assert.equal(r.confidence, null)
})

test("ZH false-positive — '不想活了 + 这种 deadline' suppressed", () => {
  const r = detectCrisisInInput("真的不想活了 这种 deadline 还要再来一次吗")
  assert.equal(r.detected, false)
})

test("EN false-positive — 'can't go on with this deadline' suppressed", () => {
  const r = detectCrisisInInput("i literally can't go on with this deadline")
  assert.equal(
    r.detected,
    false,
    "rhetorical 'can't go on' + 'this deadline' must be suppressed"
  )
})

test("EN false-positive — 'don't want to live without offers' suppressed", () => {
  const r = detectCrisisInInput("i don't want to live without offers any longer")
  assert.equal(r.detected, false)
})

// ---------------------------------------------------------------------------
// Integration: guardCrisisHotline end-to-end
// ---------------------------------------------------------------------------

test("integration — clean input is no-op (reply unchanged)", () => {
  const result = guardCrisisHotline({
    userInput: "今天有什么新职位推荐吗",
    reply: "嗯，让我看看。",
  })
  assert.equal(result.injected, false)
  assert.equal(result.reason, "not_detected")
  assert.equal(result.reply, "嗯，让我看看。")
})

test("integration — crisis input + reply already has hotline → no double-append", () => {
  const result = guardCrisisHotline({
    userInput: "我想自杀",
    reply: "我听到了。心理援助热线 400-161-9995（24h），随时拨。",
  })
  assert.equal(result.injected, false)
  assert.equal(result.reason, "detected_already_has")
  // Reply unchanged
  assert.equal(result.reply, "我听到了。心理援助热线 400-161-9995（24h），随时拨。")
})

test("integration — crisis input + reply lacking hotline → trailer appended", () => {
  const result = guardCrisisHotline({
    userInput: "我想自杀",
    // Imagine Bible directive failed and LLM produced empty empathetic body.
    reply: "我听到了。我在这。",
  })
  assert.equal(result.injected, true)
  assert.equal(result.reason, "detected_injected")
  assert.match(result.reply, /400-?161-?9995/)
  // Original body preserved
  assert.ok(result.reply.startsWith("我听到了。我在这。"))
  // Inputs hash + length set
  assert.equal(result.inputLength, "我想自杀".length)
  assert.equal(result.inputHash.length, 16)
})

test("integration — EN crisis lacking hotline gets EN trailer with both 741741 and 988", () => {
  const result = guardCrisisHotline({
    userInput: "i want to kill myself",
    reply: "i hear you. that's a lot to be carrying.",
  })
  assert.equal(result.injected, true)
  assert.match(result.reply, /741741/)
  assert.match(result.reply, /\b988\b/)
  // Body preserved
  assert.ok(result.reply.startsWith("i hear you."))
})

// ---------------------------------------------------------------------------
// Auxiliary smoke
// ---------------------------------------------------------------------------

test("aux — replyContainsHotline catches all canonical strings", () => {
  assert.equal(replyContainsHotline("call 988 if you need to"), true)
  assert.equal(replyContainsHotline("text HOME to 741741"), true)
  assert.equal(replyContainsHotline("心理援助热线 400-161-9995"), true)
  assert.equal(replyContainsHotline("12320 也可以"), true)
  assert.equal(replyContainsHotline("Crisis Text Line is staffed 24/7"), true)
  assert.equal(replyContainsHotline("just a regular reply"), false)
  // Avoid false-positive on non-hotline numbers ("$98800", "1988").
  assert.equal(replyContainsHotline("salary is $98800"), false)
  assert.equal(replyContainsHotline("born in 1988"), false)
})

test("aux — appendHotlineIfMissing picks language-correct trailer", () => {
  const zh = appendHotlineIfMissing({ reply: "我听到了", language: "zh" })
  assert.ok(zh.text.includes(HOTLINE_TRAILERS.zh))
  const en = appendHotlineIfMissing({ reply: "i hear you", language: "en" })
  assert.ok(en.text.includes(HOTLINE_TRAILERS.en))
  const mixed = appendHotlineIfMissing({
    reply: "听到了 / heard you",
    language: "mixed",
  })
  assert.ok(mixed.text.includes(HOTLINE_TRAILERS.mixed))
})

test("aux — hashForAudit is deterministic and PII-safe (no raw text)", () => {
  const a = hashForAudit("我想自杀")
  const b = hashForAudit("我想自杀")
  const c = hashForAudit("different")
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.equal(a.length, 16)
  // Contains only hex characters
  assert.match(a, /^[0-9a-f]{16}$/)
})

test("aux — empty / whitespace input is no-op", () => {
  const r = guardCrisisHotline({ userInput: "", reply: "hello" })
  assert.equal(r.injected, false)
  assert.equal(r.reason, "not_detected")
  const r2 = guardCrisisHotline({ userInput: "我想自杀", reply: "" })
  assert.equal(r2.injected, false)
  assert.equal(r2.reason, "empty_reply")
})

test("aux — mixed-language input gets bilingual trailer", () => {
  const r = guardCrisisHotline({
    userInput: "i can't anymore 真的活不下去了",
    reply: "听到了 / i hear you",
  })
  // mixed-CJK language detection → mixed trailer (covers both hotlines)
  assert.equal(r.injected, true)
  // Mixed trailer contains BOTH zh and en hotlines
  assert.match(r.reply, /400-?161-?9995/)
  assert.match(r.reply, /741741/)
})
