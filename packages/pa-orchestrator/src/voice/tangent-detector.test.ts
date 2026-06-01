/**
 * Adam 2026-05-19 voice polish §6 — tangent detector unit tests.
 *
 * Locks down:
 *   - en/zh interrogative + question-mark heuristics flag tangents
 *   - long messages never flag (even with "?") — protects long-form answers
 *   - empty / non-alpha bodies never flag
 *   - the surface directive copy contains the language-correct guidance
 */
import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  buildTangentSurfaceDirective,
  detectOnboardingTangent,
} from "./tangent-detector.js"

describe("detectOnboardingTangent — en", () => {
  it("flags wh-question with ?", () => {
    assert.equal(
      detectOnboardingTangent({ body: "What's the weather like today?", lang: "en" }).isTangent,
      true,
    )
  })

  it("flags modal yes/no question with ?", () => {
    assert.equal(
      detectOnboardingTangent({ body: "Can you also help me write my cover letter?", lang: "en" }).isTangent,
      true,
    )
  })

  it("does NOT flag declarative even with trailing rhetorical ?", () => {
    assert.equal(
      detectOnboardingTangent({ body: "Growth, mostly. Comp matters too, makes sense?", lang: "en" }).isTangent,
      false,
    )
  })

  it("does NOT flag long monologue containing a ? mid-sentence", () => {
    const body = "I'm looking for a senior role at a series B or later, " +
      "ideally fintech or AI. I left my last gig because culture was rough — " +
      "do you know if WeKruit has fintech roles? anyway, mostly comp + growth."
    assert.equal(
      detectOnboardingTangent({ body, lang: "en" }).isTangent,
      false,
      "long monologues should never flag — they're answers with rhetorical ?s",
    )
  })

  it("does NOT flag empty body", () => {
    assert.equal(detectOnboardingTangent({ body: "", lang: "en" }).isTangent, false)
    assert.equal(detectOnboardingTangent({ body: "   ", lang: "en" }).isTangent, false)
  })

  it("does NOT flag non-alpha body", () => {
    assert.equal(detectOnboardingTangent({ body: "???", lang: "en" }).isTangent, false)
    assert.equal(detectOnboardingTangent({ body: "👍🙏", lang: "en" }).isTangent, false)
  })

  it("does NOT flag short answer with no ? or interrogative", () => {
    assert.equal(detectOnboardingTangent({ body: "Growth", lang: "en" }).isTangent, false)
    assert.equal(detectOnboardingTangent({ body: "comp + mission", lang: "en" }).isTangent, false)
  })
})

describe("detectOnboardingTangent — legacy zh detection (codepoint inputs)", () => {
  // Build CJK inputs from codepoints so this file contains no literal CJK.
  const c = (...cps: number[]) => String.fromCharCode(...cps)
  const fwQ = String.fromCharCode(0xff1f) // full-width question mark

  it("flags interrogative-opener + yes/no-particle style", () => {
    // "你能帮我看看简历吗" + full-width "?"
    const body =
      c(0x4f60, 0x80fd, 0x5e2e, 0x6211, 0x770b, 0x770b, 0x7b80, 0x5386, 0x5417) + fwQ
    assert.equal(detectOnboardingTangent({ body, lang: "zh" }).isTangent, true)
  })

  it("flags 'why ...?' style", () => {
    // "为什么我没有收到推荐" + full-width "?"
    const body =
      c(0x4e3a, 0x4ec0, 0x4e48, 0x6211, 0x6ca1, 0x6709, 0x6536, 0x5230, 0x63a8, 0x8350) + fwQ
    assert.equal(detectOnboardingTangent({ body, lang: "zh" }).isTangent, true)
  })

  it("does NOT flag zh declarative answer", () => {
    // "成长最重要，其次是薪资。"
    const body = c(
      0x6210, 0x957f, 0x6700, 0x91cd, 0x8981, 0xff0c, 0x5176, 0x6b21, 0x662f,
      0x85aa, 0x8d44, 0x3002
    )
    assert.equal(detectOnboardingTangent({ body, lang: "zh" }).isTangent, false)
  })

  it("does NOT flag zh body with only en chars (lang mismatch defensive)", () => {
    // The router supplies lang from detectLang; defensive check.
    assert.equal(
      detectOnboardingTangent({ body: "growth + comp", lang: "zh" }).isTangent,
      false,
    )
  })
})

describe("buildTangentSurfaceDirective", () => {
  it("en directive mentions one short sentence + bring back", () => {
    const d = buildTangentSurfaceDirective("en")
    assert.match(d, /ONE short sentence|one short sentence/i)
    assert.match(d, /bring|gently/i)
  })

  it("directive is English even when legacy zh lang passed", () => {
    const d = buildTangentSurfaceDirective("zh")
    assert.ok(!/[一-鿿]/.test(d), `expected English-only directive, got: ${d}`)
    assert.match(d, /ONE short sentence|one short sentence/i)
  })
})
