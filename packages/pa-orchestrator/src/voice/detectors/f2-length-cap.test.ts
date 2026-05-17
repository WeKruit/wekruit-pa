/**
 * Phase 35 T3 — F2 length cap detector tests.
 *
 * Coverage:
 * - over-cap triggers
 * - within-cap does not
 * - decimal/URL/abbreviation protection (port from Phase 33 33-case set)
 * - zh terminator vs en terminator vs ellipsis
 * - cap override via env
 * - parity test vs Phase 33 .mjs sentence-split (12-case subset)
 * - false-positive on smoke fixtures ≤ 10%
 */
import assert from "node:assert/strict"
import test from "node:test"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  countSentences,
  detectLengthCap,
  isStructuredReply,
  splitSentences,
  stripToSentenceCap,
  stripToCharCap,
} from "./f2-length-cap.js"
import type { DetectorContext } from "./types.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..")
const SPLIT_MJS = path.join(REPO_ROOT, "tests", "scenarios", "lib", "sentence-split.mjs")

function ctx(assistant: string): DetectorContext {
  return { turn: { user: "u", assistant }, history: { claireReplies: [] } }
}

test("F2 over-cap (5 sentences) triggers", () => {
  const r = detectLengthCap(ctx("a. b. c. d. e."))
  assert.equal(r.triggered, true)
  assert.equal(r.score, 5)
  assert.equal(r.suggested_action, "strip")
  assert.equal(r.id, "f2_length_cap")
})

test("F2 within-cap (2 sentences) does not trigger", () => {
  const r = detectLengthCap(ctx("a. b."))
  assert.equal(r.triggered, false)
  assert.equal(r.score, 2)
  assert.equal(r.suggested_action, null)
})

test("F2 exactly cap (3 sentences) does not trigger", () => {
  const r = detectLengthCap(ctx("a. b. c."))
  assert.equal(r.triggered, false)
  assert.equal(r.score, 3)
})

test("F2 decimal protection — '3.14' is not a sentence boundary", () => {
  const r = detectLengthCap(ctx("Step 3.14 is hot. Try x. Maybe."))
  assert.equal(r.score, 3)
  assert.equal(r.triggered, false)
})

test("F2 URL protection — '://example.com' inner dot is safe", () => {
  // URL token extends to whitespace; trailing dot after URL is part of
  // the token (no boundary). Then `Try.` is the next sentence after WS.
  // Verified parity with Phase 33 .mjs helper.
  const r = detectLengthCap(ctx("see https://example.com/foo and try. Maybe later."))
  assert.equal(r.score, 2)
  assert.equal(r.triggered, false)
})

test("F2 abbreviation protection — 'Dr. Smith' is one sentence", () => {
  const r = detectLengthCap(ctx("Dr. Smith said yes."))
  assert.equal(r.score, 1)
})

test("F2 zh terminators 。！？ count correctly", () => {
  const r = detectLengthCap(ctx("今天累。但还撑着。下班吃啥？"))
  assert.equal(r.score, 3)
  assert.equal(r.triggered, false)
})

test("F2 ellipsis is one boundary, not three", () => {
  const r = detectLengthCap(ctx("嗯…再说吧。"))
  assert.equal(r.score, 2)
  assert.equal(r.triggered, false)
})

test("F2 mid-string 'test.com' is not a sentence boundary", () => {
  const r = detectLengthCap(ctx("Visit test.com and check."))
  assert.equal(r.score, 1)
})

test("F2 empty input → no trigger", () => {
  const r = detectLengthCap(ctx(""))
  assert.equal(r.triggered, false)
  assert.equal(r.score, 0)
  assert.equal(r.reason, "no_input")
})

test("F2 cap override via ctx.env.f2SentenceCap", () => {
  const c = ctx("a. b. c.")
  const strict = detectLengthCap({ ...c, env: { f2SentenceCap: 2 } })
  const lax = detectLengthCap({ ...c, env: { f2SentenceCap: 5 } })
  assert.equal(strict.triggered, true)
  assert.equal(lax.triggered, false)
})

test("F2 latencyMs populated and < 10ms", () => {
  const r = detectLengthCap(ctx("today was rough but I am okay. just sleep."))
  assert.ok(r.latencyMs < 10, `expected < 10ms, got ${r.latencyMs}`)
})

test("F2 PARITY vs Phase 33 .mjs sentence-split (12 fixed inputs)", async () => {
  const splitUrl = pathToFileURL(SPLIT_MJS).href
  const mjs = await import(splitUrl)
  const mjsCount = mjs.countSentences as (s: string) => number

  const inputs = [
    "今天累。但还撑着。下班吃啥？",
    "Step 3.14 is hot. Try x. Maybe.",
    "see https://example.com/foo. Try.",
    "Dr. Smith said yes.",
    "嗯…再说吧。",
    "a. b. c. d. e.",
    "a. b. c.",
    "",
    "👀",
    "今天累\n\n下班吃啥？",
    "U.S. is far. Try here.",
    "Hello! How are you? I am fine.",
  ]

  for (const text of inputs) {
    const tsCount = countSentences(text)
    const mjsResult = mjsCount(text)
    assert.equal(
      tsCount,
      mjsResult,
      `parity drift on ${JSON.stringify(text)}: ts=${tsCount} mjs=${mjsResult}`
    )
  }
})

test("F2 false-positive ≤ 10% on smoke-fixture-quality replies", () => {
  // Production-quality replies — short, within cap.
  const safeReplies = [
    "听起来真的累炸。今天能歇就歇。",
    "嗯。今晚少看手机, 早点睡。",
    "先别想'怎么办'。睡前少看手机一小时, 明天再聊.",
    "OPT runs 12 months. Sponsorship before clock runs out.",
    "Crickets sucks. Move to next app.",
    "Sleep tonight. Tomorrow's a different day.",
    "嗯, 那就先安静一下.",
    "深夜班. 先吃饭再说.",
    "戴耳机或者出门走走.",
    "怕断现金流可以. 先骑驴找马.",
  ]
  let fp = 0
  for (const text of safeReplies) {
    const r = detectLengthCap(ctx(text))
    if (r.triggered) fp += 1
  }
  const fpRate = fp / safeReplies.length
  assert.ok(
    fpRate <= 0.1,
    `F2 false-positive = ${(fpRate * 100).toFixed(1)}%, expected <= 10%. ` +
      `Counts: ${safeReplies.map((t) => countSentences(t)).join(", ")}`
  )
})

test("F2 splitSentences exported for wire-in strip impl", () => {
  // Wire-in patch will use splitSentences to truncate. Confirm export.
  const out = splitSentences("a. b. c. d.")
  assert.deepEqual(out, ["a.", "b.", "c.", "d."])
})

// -----------------------------------------------------------------------
// Adam iter 17 — stripToSentenceCap helper coverage.
// -----------------------------------------------------------------------

test("stripToSentenceCap: input ≤ cap → not stripped", () => {
  const r = stripToSentenceCap("one. two. three.")
  assert.equal(r.stripped, false)
  assert.equal(r.text, "one. two. three.")
})

test("stripToSentenceCap: 5 sentences EN → keeps first 3", () => {
  const r = stripToSentenceCap("one. two. three. four. five.")
  assert.equal(r.stripped, true)
  assert.equal(r.dropped, 2)
  assert.equal(r.text, "one. two. three.")
  assert.equal(countSentences(r.text), 3)
})

test("stripToSentenceCap: 5 sentences ZH → keeps first 3", () => {
  const r = stripToSentenceCap("一句。两句。三句。四句。五句。")
  assert.equal(r.stripped, true)
  assert.equal(r.dropped, 2)
  assert.equal(countSentences(r.text), 3)
})

test("stripToSentenceCap: empty string fails open", () => {
  const r = stripToSentenceCap("")
  assert.equal(r.stripped, false)
  assert.equal(r.text, "")
})

test("stripToSentenceCap: explicit cap=2 truncates 4-sentence reply", () => {
  const r = stripToSentenceCap("a. b. c. d.", 2)
  assert.equal(r.stripped, true)
  assert.equal(r.dropped, 2)
  assert.equal(countSentences(r.text), 2)
})

test("stripToSentenceCap: bilingual mixed → counts terminators correctly", () => {
  const text =
    "yeah I get it. 这个事儿确实挺难的。Honestly the right move is just to ship. 别想太多。然后再迭代。"
  const r = stripToSentenceCap(text)
  assert.equal(r.stripped, true)
  // 5 sentences → keep 3
  assert.equal(countSentences(r.text), 3)
})

// -----------------------------------------------------------------------
// Adam iter 19 — stripToCharCap helper coverage.
// -----------------------------------------------------------------------

test("stripToCharCap: short text → not stripped", () => {
  const r = stripToCharCap("hi there", 180)
  assert.equal(r.stripped, false)
})

test("stripToCharCap: 300-char run-on → truncated to last fitting sentence", () => {
  const text =
    "one short. two also short. " +
    "three is the offending run-on sentence that goes on forever past the cap because it just keeps adding more and more content without any terminator to break it."
  // sentences: 1=10ch, 2=14ch, 3=160+ch ; cap=60 → keep first 2
  const r = stripToCharCap(text, 60)
  assert.equal(r.stripped, true)
  assert.ok(r.text.length <= 60, `kept ${r.text.length} chars, cap 60`)
  assert.ok(!r.text.includes("offending"), "run-on sentence dropped")
})

test("stripToCharCap: single over-cap sentence → keep it (fail-open)", () => {
  const text = "this is one really long sentence that exceeds the cap on its own."
  const r = stripToCharCap(text, 20)
  // Whole sentence kept since dropping it would yield empty.
  assert.equal(r.stripped, false)
})

test("stripToCharCap: bilingual zh+en mix → boundary on terminators", () => {
  const text = "我之前确实碰过类似的职责。核心差别是延迟可观测性更硬。然后还有一些其它考虑比如审计链路。"
  // 3 sentences zh; cap=20 → keep first sentence only (12 chars + period)
  const r = stripToCharCap(text, 20)
  assert.equal(r.stripped, true)
  assert.ok(r.text.length <= 20)
})

test("stripToCharCap: anxious_grad-style 200-char zh run-on → cap honored", () => {
  // Real witnessed run-on from anxious_grad sim.
  const text =
    "我之前确实碰过偏支付/风控那类的职责，核心差别是你不只是把功能跑通，而是要把延迟、准确率、误杀/漏放、可审计、以及异常链路的闭环一起做出来；比如实时特征/规则命中、黑白名单与策略下发、以及事后追溯都很吃系统设计。"
  const r = stripToCharCap(text, 100)
  assert.equal(r.stripped, true)
  assert.ok(r.text.length <= 100, `text=${r.text.length}ch`)
})

test("stripToCharCap: env override PA_F2_CHAR_CAP", () => {
  const original = process.env.PA_F2_CHAR_CAP
  process.env.PA_F2_CHAR_CAP = "50"
  try {
    const r = stripToCharCap(
      "first sentence here. second sentence here. third sentence here. fourth sentence here."
    )
    assert.equal(r.stripped, true)
    assert.ok(r.text.length <= 50)
  } finally {
    if (original === undefined) delete process.env.PA_F2_CHAR_CAP
    else process.env.PA_F2_CHAR_CAP = original
  }
})

test("stripToCharCap: empty input fail-open", () => {
  const r = stripToCharCap("")
  assert.equal(r.stripped, false)
  assert.equal(r.text, "")
})

test("isStructuredReply: numbered parenthesis list bypasses caps", () => {
  const reply =
    "1)Contact was recommended because your JavaScript background fits backend-plus-web service work. " +
    "2)Rain matched the OFO dashboard and SQL evidence, especially stuck-order debugging and operator tooling. " +
    "3)Yes, internships and co-ops should be lower priority than early-stage fullstack roles."
  assert.equal(isStructuredReply(reply), true)
})

test("isStructuredReply: numbered colon list bypasses caps", () => {
  const reply =
    "1: Constant Contact is adjacent because of JavaScript service work. " +
    "2: Rain is closer where your OFO dashboard and SQL debugging overlap with internal tools."
  assert.equal(isStructuredReply(reply), true)
})
