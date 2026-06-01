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

test("F2 ellipsis is one boundary, not three", () => {
  const r = detectLengthCap(ctx("hmm… let's talk later."))
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
    "Today was rough. Still hanging in. What's for dinner?",
    "Step 3.14 is hot. Try x. Maybe.",
    "see https://example.com/foo. Try.",
    "Dr. Smith said yes.",
    "hmm… let's talk later.",
    "a. b. c. d. e.",
    "a. b. c.",
    "",
    "👀",
    "Today was rough\n\nwhat's for dinner?",
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
    "Sounds exhausting. Rest if you can today.",
    "Yeah. Less screen time tonight, sleep early.",
    "Don't spiral on 'what now'. Less phone before bed, talk tomorrow.",
    "OPT runs 12 months. Sponsorship before clock runs out.",
    "Crickets sucks. Move to next app.",
    "Sleep tonight. Tomorrow's a different day.",
    "Okay, let's just take a quiet beat first.",
    "Late shift. Eat first, then we talk.",
    "Put on headphones or go for a walk.",
    "Worried about cash flow is fair. Line up the next thing first.",
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

test("stripToSentenceCap: 5 sentences with full-width terminators → keeps first 3", () => {
  // Build inputs from a codepoint escape (U+3002 ideographic full stop) to
  // verify full-width terminator handling without literal CJK in the file.
  const fs = String.fromCharCode(0x3002)
  const r = stripToSentenceCap(`one${fs}two${fs}three${fs}four${fs}five${fs}`)
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

test("stripToSentenceCap: mixed terminators → counts terminators correctly", () => {
  // Mix EN periods with a full-width terminator (U+3002) via codepoint escape
  // so both terminator classes are exercised without literal CJK.
  const fs = String.fromCharCode(0x3002)
  const text =
    `yeah I get it. this thing is genuinely hard${fs}Honestly the right move is just to ship. don't overthink${fs}then iterate${fs}`
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

test("stripToCharCap: full-width terminators → boundary on terminators", () => {
  // Three sentences delimited by U+3002 (via codepoint escape); cap=20 keeps
  // only the first (short) sentence.
  const fs = String.fromCharCode(0x3002)
  const text = `same duties${fs}latency differs${fs}also audit-trail concerns${fs}`
  const r = stripToCharCap(text, 20)
  assert.equal(r.stripped, true)
  assert.ok(r.text.length <= 20)
})

test("stripToCharCap: multi-sentence run-on with full-width terminators → cap honored", () => {
  // Several sentences delimited by U+3002 (via codepoint escape); cap=100 keeps
  // the leading sentences that fit.
  const fs = String.fromCharCode(0x3002)
  const text =
    `worked on payments and risk-control duties${fs}the difference is closing the loop end to end${fs}latency accuracy and auditability all matter${fs}exception paths get heavy too${fs}`
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
