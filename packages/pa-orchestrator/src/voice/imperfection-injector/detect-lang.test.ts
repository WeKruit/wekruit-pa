/**
 * Phase 53 + Adam 2026-05-03 01:22 spec — detectUserLang 3-class tests.
 *
 * Background:
 *   Phase 53 introduced `detectUserLang` (any-CJK → "zh") to fix bilingual
 *   user inputs being misclassified as "en". Adam 01:22 production repro
 *   ("算了我还是想做cs", "swe行业", "你觉得我能去 Nvidia 吗?", "他们有简历
 *   要求吗? 比方说硬件的内容") proved binary classification still over-locks:
 *   the reply hard-translates to pure-zh, scrubbing the legitimate English
 *   tokens (proper nouns, role acronyms, tech terms) the user wrote.
 *
 *   New 3-class contract:
 *     "zh"    — ≥1 CJK, 0 ASCII letter words
 *     "en"    — 0 CJK, ≥1 ASCII letter word
 *     "mixed" — ≥1 CJK AND ≥1 ASCII letter word (reply mirrors naturally)
 *
 *   `detectLang` (cjk-vs-ascii majority) is unchanged — it remains the
 *   reply-side faithfulness check ("what did the model emit").
 */
import assert from "node:assert/strict"
import test, { describe } from "node:test"

import { detectLang, detectUserLang } from "./injector.js"

describe("detectUserLang — pure-zh class", () => {
  test("'我想找工作' → 'zh' (CJK only, no ASCII letters)", () => {
    assert.equal(detectUserLang("我想找工作"), "zh")
  })

  test("'今晚先睡吧。' → 'zh' (CJK + CJK punctuation, no ASCII)", () => {
    assert.equal(detectUserLang("今晚先睡吧。"), "zh")
  })

  test("'好的' → 'zh' (minimal CJK)", () => {
    assert.equal(detectUserLang("好的"), "zh")
  })

  test("CJK punctuation '。' (U+3002) alone triggers 'zh'", () => {
    assert.equal(detectUserLang("hello。"), "mixed")
    // hello adds an ASCII word, so this is mixed; but punctuation alone:
    assert.equal(detectUserLang("。"), "zh")
  })

  test("CJK + digits + spaces (no ASCII letters) → 'zh'", () => {
    assert.equal(detectUserLang("yoe 1 年的"), "mixed") // 'yoe' is ASCII letters
    assert.equal(detectUserLang("1年的"), "zh")         // digits don't count as ASCII words
  })
})

describe("detectUserLang — pure-en class", () => {
  test("'I want a job' → 'en' (multiple ASCII words, no CJK)", () => {
    assert.equal(detectUserLang("I want a job"), "en")
  })

  test("'hello' → 'en' (single ASCII word)", () => {
    assert.equal(detectUserLang("hello"), "en")
  })

  test("punctuation-only ASCII '!!! ???' → 'en' (no letters, defensive default)", () => {
    assert.equal(detectUserLang("!!! ???"), "en")
  })

  test("digits-only '123' → 'en' (no CJK, no ASCII letters → default en)", () => {
    assert.equal(detectUserLang("123"), "en")
  })
})

describe("detectUserLang — mixed class (Adam 2026-05-03 01:22 spec)", () => {
  test("Adam repro: 'swe的' → 'mixed' (1 ASCII word + 1 CJK)", () => {
    assert.equal(detectUserLang("swe的"), "mixed")
  })

  test("Adam repro: 'yoe1年的' → 'mixed' (1 ASCII word + ≥1 CJK)", () => {
    assert.equal(detectUserLang("yoe1年的"), "mixed")
  })

  test("Adam repro: 'swe行业' → 'mixed' (1 ASCII word + 2 CJK)", () => {
    assert.equal(detectUserLang("swe行业"), "mixed")
  })

  test("Adam repro: '你觉得我能去Nvidia吗?' → 'mixed' (1 proper noun + many CJK)", () => {
    assert.equal(detectUserLang("你觉得我能去Nvidia吗?"), "mixed")
  })

  test("Adam repro: '算了我还是想做cs' → 'mixed' (1 acronym + many CJK)", () => {
    assert.equal(detectUserLang("算了我还是想做cs"), "mixed")
  })

  test("'他们有简历要求吗?比方说硬件的内容' → 'zh' (no ASCII letter words)", () => {
    // ASCII chars present (?) but no letter words; not mixed.
    assert.equal(detectUserLang("他们有简历要求吗?比方说硬件的内容"), "zh")
  })

  test("'我用 React 写过 dashboard' → 'mixed' (2 ASCII words + CJK)", () => {
    assert.equal(detectUserLang("我用 React 写过 dashboard"), "mixed")
  })

  test("'我是 senior on OPT 找 SWE' → 'mixed' (4 ASCII words + CJK)", () => {
    assert.equal(detectUserLang("我是 senior on OPT 找 SWE"), "mixed")
  })

  test("ASCII word counting: 'AB CD' counts as 2 distinct words", () => {
    // Pure-en check that the word counter increments per maximal letter run.
    // Two words, no CJK → still "en" (the count just confirms run-counting).
    assert.equal(detectUserLang("AB CD"), "en")
  })
})

describe("detectUserLang — defaults / defensive", () => {
  test("empty string → 'en' (default)", () => {
    assert.equal(detectUserLang(""), "en")
  })

  test("non-string input → 'en' (defensive default, no throw)", () => {
    // @ts-expect-error — testing defensive default for runtime non-string input
    assert.equal(detectUserLang(undefined), "en")
    // @ts-expect-error — same
    assert.equal(detectUserLang(null), "en")
  })
})

describe("detectLang (existing semantics — regression guard)", () => {
  test("zh majority → 'zh' (unchanged)", () => {
    assert.equal(detectLang("今晚先睡吧。"), "zh")
  })
  test("en majority → 'en' (unchanged)", () => {
    assert.equal(detectLang("rest tonight"), "en")
  })
  test("empty → 'en' (unchanged)", () => {
    assert.equal(detectLang(""), "en")
  })
  test("'swe的' still 'en' under detectLang — confirms detectLang/detectUserLang divergence", () => {
    assert.equal(detectLang("swe的"), "en")
    // detectUserLang now returns 'mixed' (was 'zh' under Phase 53)
    assert.equal(detectUserLang("swe的"), "mixed")
  })
})
