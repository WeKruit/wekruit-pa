import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { composeNoMatchReply, noMatchReasonTag } from "./no-match-narration.js"

describe("composeNoMatchReply", () => {
  it("noUserTags: asks for any one axis without apologizing", () => {
    const reply = composeNoMatchReply({ noUserTags: true }, "en")
    assert.match(reply, /preference profile/i)
    assert.match(reply, /\?/, "must end with a question")
    assert.doesNotMatch(reply, /could not pull/i, "no generic apology")
  })

  it("needsOnboarding + missingAxes: names the missing axis in human language", () => {
    const reply = composeNoMatchReply(
      { needsOnboarding: true, missingAxes: ["targetRoleFunction", "targetLocations"] },
      "en",
    )
    assert.match(reply, /role/i)
    assert.match(reply, /(work|location)/i)
    assert.doesNotMatch(reply, /targetRoleFunction/i, "should not leak field names")
  })

  it("needsOnboarding without axes: still asks something useful", () => {
    const reply = composeNoMatchReply({ needsOnboarding: true }, "en")
    assert.match(reply, /(role|location|visa|seniority)/i)
    assert.match(reply, /\?/)
  })

  it("hard-filter wipeout: names the dominant gate and asks broaden question", () => {
    const reply = composeNoMatchReply(
      {
        total: 500,
        dropped: 500,
        hardFilter: { visa: 480, location: 20 },
      },
      "en",
    )
    assert.match(reply, /500/, "should cite total scanned")
    assert.match(reply, /(work authorization|sponsorship)/i, "should name visa as dominant gate")
    assert.match(reply, /\?/, "should ask a broaden question")
  })

  it("hard-filter wipeout: ties go to highest count, then first-seen", () => {
    const reply = composeNoMatchReply(
      {
        total: 100,
        dropped: 100,
        hardFilter: { roleFunction: 80, jobType: 80 },
      },
      "en",
    )
    assert.match(reply, /role family|role/i)
  })

  it("collabPrescreenOnly: framed as widen-to-open-market", () => {
    const reply = composeNoMatchReply({ collabPrescreenOnly: true }, "en")
    assert.match(reply, /partner/i)
    assert.match(reply, /\?/)
  })

  it("empty corpus (total === 0): no apology, deferred-promise tone", () => {
    const reply = composeNoMatchReply({ total: 0, dropped: 0 }, "en")
    assert.match(reply, /empty|next batch/i)
    assert.doesNotMatch(reply, /could not/i)
  })

  it("soft-score wipeout: total > 0 but no jobs survived ranking", () => {
    const reply = composeNoMatchReply(
      {
        total: 12,
        dropped: 0,
        hardFilter: {},
      },
      "en",
    )
    assert.match(reply, /12/)
    assert.match(reply, /loosen|broaden|preference/i)
  })

  it("lang=zh still returns English-only copy (product is English-only)", () => {
    const reply = composeNoMatchReply({ noUserTags: true }, "zh")
    assert.match(reply, /preference profile/i)
    // CJK Unified Ideographs range, built from char codes to avoid CJK literals.
    const cjk = new RegExp(`[\\u${(0x4e00).toString(16)}-\\u${(0x9fff).toString(16)}]`)
    assert.doesNotMatch(reply, cjk, "no Chinese characters")
  })

  it("always returns non-empty string", () => {
    const reply = composeNoMatchReply({}, "en")
    assert.ok(reply.length > 0)
  })
})

describe("noMatchReasonTag", () => {
  it("emits stable enum-like tags for trace metadata", () => {
    assert.equal(noMatchReasonTag({ noUserTags: true }), "no_user_tags")
    assert.equal(
      noMatchReasonTag({ needsOnboarding: true, missingAxes: ["targetRoleFunction"] }),
      "missing_axis:targetRoleFunction",
    )
    assert.equal(noMatchReasonTag({ collabPrescreenOnly: true }), "no_collab_match")
    assert.equal(
      noMatchReasonTag({ total: 100, dropped: 100, hardFilter: { visa: 100 } }),
      "hard_filter:visa",
    )
    assert.equal(noMatchReasonTag({ total: 0 }), "empty_corpus")
    assert.equal(noMatchReasonTag({ total: 10, dropped: 0 }), "soft_score_below_threshold")
  })
})
