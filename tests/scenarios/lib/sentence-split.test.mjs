/**
 * Phase 33 — sentence-split unit tests (HARNESS-03 acceptance ≥ 30 cases).
 *
 *   node --test tests/scenarios/lib/sentence-split.test.mjs
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  splitSentences,
  countSentences,
  withinSentenceCap,
} from "./sentence-split.mjs"

// ---------- zh terminators (4) ----------

test("zh: 。 terminator", () => {
  assert.deepEqual(splitSentences("今天累。下班吃啥。"), ["今天累。", "下班吃啥。"])
})

test("zh: ！ terminator", () => {
  assert.deepEqual(splitSentences("好啊！走起。"), ["好啊！", "走起。"])
})

test("zh: ？ terminator", () => {
  assert.deepEqual(splitSentences("你怎么样？我还行。"), ["你怎么样？", "我还行。"])
})

test("zh: ； terminator (semicolon-as-sentence per CSL convention)", () => {
  assert.deepEqual(splitSentences("一是累；二是烦。"), ["一是累；", "二是烦。"])
})

// ---------- en terminators (3) ----------

test("en: . + space + capitalized next", () => {
  assert.deepEqual(splitSentences("I'm tired. Long week."), ["I'm tired.", "Long week."])
})

test("en: ! + space", () => {
  assert.deepEqual(splitSentences("Nice! Coffee?"), ["Nice!", "Coffee?"])
})

test("en: ? at end-of-string", () => {
  assert.deepEqual(splitSentences("you ok?"), ["you ok?"])
})

// ---------- mixed code-switch (3) ----------

test("mixed: zh + en in one sentence, en terminator", () => {
  assert.deepEqual(splitSentences("today 真的累. tomorrow 再说."), ["today 真的累.", "tomorrow 再说."])
})

test("mixed: zh terminator after en word", () => {
  assert.deepEqual(splitSentences("the offer 来了！恭喜。"), ["the offer 来了！", "恭喜。"])
})

test("mixed: en terminator inside zh-majority text", () => {
  assert.deepEqual(splitSentences("加油! 你可以的。"), ["加油!", "你可以的。"])
})

// ---------- decimal protection (2) ----------

test("decimal: 3.14 stays one sentence", () => {
  assert.deepEqual(splitSentences("pi is 3.14 roughly."), ["pi is 3.14 roughly."])
})

test("decimal: $4.5M does not split", () => {
  assert.deepEqual(splitSentences("the round was 4.5 million."), ["the round was 4.5 million."])
})

// ---------- URL protection (2) ----------

test("url: https://example.com/path stays one sentence", () => {
  assert.deepEqual(
    splitSentences("check https://example.com/path it's down."),
    ["check https://example.com/path it's down."]
  )
})

test("url: bare domain x.com inside sentence", () => {
  assert.deepEqual(
    splitSentences("posted on twitter.com/feed earlier."),
    ["posted on twitter.com/feed earlier."]
  )
})

// ---------- abbreviation protection (2) ----------

test("abbreviation: Dr. Smith stays inside sentence", () => {
  assert.deepEqual(splitSentences("met Dr. Smith today."), ["met Dr. Smith today."])
})

test("abbreviation: U.S. inside text", () => {
  assert.deepEqual(splitSentences("the U.S. office is hiring."), ["the U.S. office is hiring."])
})

// ---------- ellipsis (3) ----------

test("ellipsis: unicode … is single boundary", () => {
  assert.deepEqual(splitSentences("唉…算了。"), ["唉…", "算了。"])
})

test("ellipsis: ... three dots is single boundary", () => {
  assert.deepEqual(splitSentences("uh... idk."), ["uh...", "idk."])
})

test("ellipsis: 。。。 zh-style triple-period", () => {
  assert.deepEqual(splitSentences("我也不知道。。。明天再说"), ["我也不知道。。。", "明天再说"])
})

// ---------- emoji handling (2) ----------

test("emoji-only sentence after terminator", () => {
  assert.deepEqual(splitSentences("好的。 🍋"), ["好的。", "🍋"])
})

test("emoji at end of sentence does not split mid-emoji", () => {
  const result = splitSentences("成了 🎉 庆祝一下。")
  assert.equal(result.length, 1)
  assert.match(result[0], /🎉/)
})

// ---------- paragraph break (2) ----------

test("paragraph: double newline = boundary even no terminator", () => {
  assert.deepEqual(splitSentences("first thought\n\nsecond thought"), ["first thought", "second thought"])
})

test("paragraph: triple newline same as double", () => {
  assert.deepEqual(splitSentences("a\n\n\nb"), ["a", "b"])
})

// ---------- single trailing punct (2) ----------

test("single trailing zh punct counts as one", () => {
  assert.equal(countSentences("怎么样?"), 1)
})

test("single trailing en period counts as one", () => {
  assert.equal(countSentences("done."), 1)
})

// ---------- empty + whitespace (3) ----------

test("empty string returns empty array", () => {
  assert.deepEqual(splitSentences(""), [])
})

test("non-string returns empty array", () => {
  assert.deepEqual(splitSentences(undefined), [])
  assert.deepEqual(splitSentences(null), [])
})

test("whitespace-only returns empty array", () => {
  assert.deepEqual(splitSentences("   \n\n  "), [])
})

// ---------- single emoji + edge (2) ----------

test("single emoji with no terminator is one sentence", () => {
  assert.deepEqual(splitSentences("🍋"), ["🍋"])
})

test("single character no punct = one sentence", () => {
  assert.deepEqual(splitSentences("ok"), ["ok"])
})

// ---------- realistic Claire reply (3) ----------

test("realistic zh reply 3-sentence cap", () => {
  const reply = "听起来真的累。今天能歇就歇一会儿。明天再扛。"
  assert.equal(countSentences(reply), 3)
  assert.equal(withinSentenceCap(reply, 3), true)
})

test("realistic en reply over cap", () => {
  const reply = "Got it. That's rough. I've been there. Try just sleeping it off."
  assert.equal(countSentences(reply), 4)
  assert.equal(withinSentenceCap(reply, 3), false)
})

test("realistic mixed reply with URL stays under cap", () => {
  const reply = "去看看 https://example.com/jobs 那边有 H1B 的岗。说不定能聊。"
  assert.equal(countSentences(reply), 2)
  assert.equal(withinSentenceCap(reply, 3), true)
})

// ---------- countSentences wrapper sanity (1) ----------

test("countSentences === splitSentences.length", () => {
  const t = "a. b. c."
  assert.equal(countSentences(t), splitSentences(t).length)
})

// ---------- withinSentenceCap default + custom (1) ----------

test("withinSentenceCap defaults to cap=3", () => {
  assert.equal(withinSentenceCap("a. b. c."), true)
  assert.equal(withinSentenceCap("a. b. c. d."), false)
  assert.equal(withinSentenceCap("a. b. c. d.", 4), true)
})
