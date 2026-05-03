/**
 * Phase 53 — Bug 2 fix unit tests: detectUserLang (zh-biased user-input
 * lang detection).
 *
 * Background (Adam iMessage 2026-05-03 00:34 repro):
 *   `detectLang` (cjk-vs-ascii majority) misclassifies bilingual user input
 *   like "swe的" or "yoe1年的" as "en" — the user is writing ZH-frame and
 *   English fragments are loanwords. langLock then locks reply to EN and
 *   the user gets an EN reply for what was a ZH conversation.
 *
 * Contract under test:
 *   - `detectUserLang`: ANY presence of CJK → "zh"; pure-ASCII or empty → "en".
 *   - `detectLang` (existing): unchanged majority semantics — kept around for
 *     REPLY lang detection (faithful "what did the model emit" check).
 */
import assert from "node:assert/strict"
import test, { describe } from "node:test"

import { detectLang, detectUserLang } from "./injector.js"

describe("detectUserLang (Phase 53 Bug 2 fix — user-input lang detection)", () => {
  test("Adam repro: 'swe的' → 'zh' (was 'en' under detectLang)", () => {
    assert.equal(detectUserLang("swe的"), "zh")
    // Sanity: detectLang would still return 'en' (loanword-shaped fragments
    // dominate by ascii count). detectUserLang differs deliberately.
    assert.equal(detectLang("swe的"), "en")
  })

  test("Adam repro: 'yoe1年的' → 'zh' (was 'en' under detectLang)", () => {
    assert.equal(detectUserLang("yoe1年的"), "zh")
    assert.equal(detectLang("yoe1年的"), "en")
  })

  test("pure-zh: '我想找工作' → 'zh' (matches detectLang)", () => {
    assert.equal(detectUserLang("我想找工作"), "zh")
    assert.equal(detectLang("我想找工作"), "zh")
  })

  test("pure-en: 'I want a job' → 'en' (matches detectLang)", () => {
    assert.equal(detectUserLang("I want a job"), "en")
    assert.equal(detectLang("I want a job"), "en")
  })

  test("ZH-frame with EN loanwords: '我用 React 写过 dashboard' → 'zh' (any-CJK rule)", () => {
    // Note: detectLang returns 'en' here (ASCII letter majority — documented
    // existing behavior in injector.test.ts:64-66). detectUserLang corrects
    // this for user-input detection.
    assert.equal(detectUserLang("我用 React 写过 dashboard"), "zh")
    assert.equal(detectLang("我用 React 写过 dashboard"), "en")
  })

  test("EN-dominant code-switch with single CJK char: '我是 senior on OPT 找 SWE' → 'zh'", () => {
    assert.equal(detectUserLang("我是 senior on OPT 找 SWE"), "zh")
  })

  test("empty string → 'en' (default)", () => {
    assert.equal(detectUserLang(""), "en")
  })

  test("non-string input → 'en' (defensive default, no throw)", () => {
    // @ts-expect-error — testing defensive default for runtime non-string input
    assert.equal(detectUserLang(undefined), "en")
    // @ts-expect-error — same
    assert.equal(detectUserLang(null), "en")
  })

  test("punctuation-only ASCII → 'en'", () => {
    assert.equal(detectUserLang("!!! ???"), "en")
  })

  test("CJK punctuation '。' (U+3002) inside U+3000-303F triggers 'zh'", () => {
    // The CJK Symbols and Punctuation block (U+3000-303F) IS counted as CJK
    // in the helper — matches detectLang's existing range.
    assert.equal(detectUserLang("hello。"), "zh")
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
})
