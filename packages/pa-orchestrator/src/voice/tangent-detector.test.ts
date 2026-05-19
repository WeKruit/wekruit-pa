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

describe("detectOnboardingTangent — zh", () => {
  it("flags 你能...吗? style", () => {
    assert.equal(
      detectOnboardingTangent({ body: "你能帮我看看简历吗？", lang: "zh" }).isTangent,
      true,
    )
  })

  it("flags 为什么...? style", () => {
    assert.equal(
      detectOnboardingTangent({ body: "为什么我没有收到 job 推荐？", lang: "zh" }).isTangent,
      true,
    )
  })

  it("does NOT flag zh declarative answer", () => {
    assert.equal(
      detectOnboardingTangent({ body: "成长最重要，其次是薪资。", lang: "zh" }).isTangent,
      false,
    )
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

  it("zh directive mentions 简短 + 题外话 + 带回", () => {
    const d = buildTangentSurfaceDirective("zh")
    assert.match(d, /题外话/)
    assert.match(d, /简短/)
    assert.match(d, /带回/)
  })
})
