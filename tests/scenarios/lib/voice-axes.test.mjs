/**
 * Phase 18 — unit tests for voice-axes helpers.
 *
 *   node --test tests/scenarios/lib/voice-axes.test.mjs
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  VOICE_AXES,
  FILLER_BLACKLIST_ZH,
  FILLER_BLACKLIST_EN,
  passThreshold,
  checkFillerBlacklist,
  checkIMessageRenderUnsafe,
} from "./voice-axes.mjs"

test("VOICE_AXES: 4 axes, each scored 0-3 with rubric for every score", () => {
  assert.equal(VOICE_AXES.length, 4)
  const expectedIds = new Set([
    "warmth_no_sycophancy",
    "in_character_voice",
    "no_robot_filler",
    "length_appropriateness",
  ])
  for (const axis of VOICE_AXES) {
    assert.equal(axis.scale[0], 0)
    assert.equal(axis.scale[1], 3)
    for (const score of [0, 1, 2, 3]) {
      assert.equal(typeof axis.rubric[score], "string")
    }
    expectedIds.delete(axis.id)
  }
  assert.equal(expectedIds.size, 0, "all 4 axis ids present")
})

test("passThreshold = 2.4 (matches ROADMAP §Phase 18 success criteria #5)", () => {
  assert.equal(passThreshold, 2.4)
})

test("checkFillerBlacklist: zh canonical hit", () => {
  const r = checkFillerBlacklist("好的，我记住了，下次注意。")
  assert.equal(r.hit, true)
  assert.equal(r.lang, "zh")
  assert.equal(r.phrase, "好的，我记住了")
})

test("checkFillerBlacklist: zh case w/ ASCII comma variant", () => {
  const r = checkFillerBlacklist("好的, 我记住了 next time")
  assert.equal(r.hit, true)
  assert.equal(r.lang, "zh")
})

test("checkFillerBlacklist: en case-insensitive hit", () => {
  const r = checkFillerBlacklist("It's important to keep in mind your audience.")
  assert.equal(r.hit, true)
  assert.equal(r.lang, "en")
})

test("checkFillerBlacklist: clean Claire-voice line passes", () => {
  const r = checkFillerBlacklist("柠檬茶女孩 🍋 行, 下次催简历的时候配你一杯.")
  assert.equal(r.hit, false)
})

test("checkFillerBlacklist: 'as an AI' hits en list", () => {
  const r = checkFillerBlacklist("As an AI, I cannot do that.")
  assert.equal(r.hit, true)
  assert.equal(r.lang, "en")
})

test("FILLER_BLACKLIST_ZH covers Bible NO list (16 entries)", () => {
  assert.ok(FILLER_BLACKLIST_ZH.length >= 15)
  for (const phrase of ["收到", "已记录", "作为 AI", "我是 AI"]) {
    assert.ok(FILLER_BLACKLIST_ZH.includes(phrase), `${phrase} in zh blacklist`)
  }
})

test("FILLER_BLACKLIST_EN covers Bible NO list (16 entries)", () => {
  assert.ok(FILLER_BLACKLIST_EN.length >= 15)
  for (const phrase of ["As an AI", "Got it", "Of course", "Remember,"]) {
    assert.ok(FILLER_BLACKLIST_EN.includes(phrase), `${phrase} in en blacklist`)
  }
})

test("checkIMessageRenderUnsafe: bold markdown hits", () => {
  const r = checkIMessageRenderUnsafe("Step **one**: do this")
  assert.equal(r.hit, true)
  assert.equal(r.reason, "markdown_bold")
})

test("checkIMessageRenderUnsafe: bullet list hits", () => {
  const r = checkIMessageRenderUnsafe("- first\n- second")
  assert.equal(r.hit, true)
  assert.equal(r.reason, "markdown_list")
})

test("checkIMessageRenderUnsafe: clean prose passes", () => {
  const r = checkIMessageRenderUnsafe("听着就累. 是 deadline 堆着, 还是别人卡你?")
  assert.equal(r.hit, false)
})
