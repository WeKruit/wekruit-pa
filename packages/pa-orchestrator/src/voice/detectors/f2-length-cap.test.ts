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
  splitSentences,
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
