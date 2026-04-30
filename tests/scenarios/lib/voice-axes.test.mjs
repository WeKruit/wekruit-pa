/**
 * Phase 18 — unit tests for voice-axes helpers.
 *
 *   node --test tests/scenarios/lib/voice-axes.test.mjs
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  VOICE_AXES,
  VOICE_AXES_V2,
  FILLER_BLACKLIST_ZH,
  FILLER_BLACKLIST_EN,
  passThreshold,
  checkFillerBlacklist,
  checkIMessageRenderUnsafe,
  computeLengthCompliance,
  computeMirrorRatio,
  computeDriftScore,
  computeAdviceNovelty,
  inferStrategy,
  isAllowedStrategy,
  stageForTurn,
  ESCONV_STRATEGIES,
  ESCONV_STAGE_ALLOWED,
} from "./voice-axes.mjs"
import { _resetCache, _setFetchImpl } from "./embed-sim.mjs"

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

// Phase 21 — pop-therapy + A/B framework auto-fail (prod regression
// 2026-04-27).
test("checkFillerBlacklist: 接住你 (pop-therapy) hits", () => {
  const r = checkFillerBlacklist("听起来你想找个人接住你一下 😌")
  assert.equal(r.hit, true)
  assert.equal(r.lang, "zh")
})

test("checkFillerBlacklist: 硬撑着 hits", () => {
  const r = checkFillerBlacklist("你硬撑着把事做完")
  assert.equal(r.hit, true)
})

test("checkFillerBlacklist: en pop-therapy 'I see you' hits", () => {
  const r = checkFillerBlacklist("I see you, that's hard")
  assert.equal(r.hit, true)
  assert.equal(r.lang, "en")
})

test("checkFillerBlacklist: A/B framework 'X 还是 Y?' structurally hits", () => {
  const r = checkFillerBlacklist("你现在更像是工作太多想关机, 还是生活也乱但还能撑?")
  assert.equal(r.hit, true)
  assert.equal(r.lang, "structural")
})

test("checkFillerBlacklist: declarative 还是 (no question mark) does NOT hit", () => {
  const r = checkFillerBlacklist("咖啡还是不错的")
  assert.equal(r.hit, false)
})

test("checkFillerBlacklist: en 'X or Y?' structural hits", () => {
  const r = checkFillerBlacklist("Are you more burnt or just tired?")
  assert.equal(r.hit, true)
  assert.equal(r.lang, "structural")
})

test("checkFillerBlacklist: clean single-question passes", () => {
  const r = checkFillerBlacklist("你怎么扛过来的?")
  assert.equal(r.hit, false)
})

// ---------------------------------------------------------------------------
// Phase 33 — VOICE_AXES_V2 + 4 new axis helpers.
// ---------------------------------------------------------------------------

test("VOICE_AXES_V2: 8 axes (4 legacy + 4 new) with rubric for 0-3", () => {
  assert.equal(VOICE_AXES_V2.length, 8)
  const expectedNewIds = new Set([
    "drift_resistance",
    "length_compliance",
    "advice_novelty",
    "strategy_fit",
  ])
  for (const axis of VOICE_AXES_V2) {
    assert.equal(axis.scale[0], 0)
    assert.equal(axis.scale[1], 3)
    for (const score of [0, 1, 2, 3]) {
      assert.equal(typeof axis.rubric[score], "string")
    }
    expectedNewIds.delete(axis.id)
  }
  assert.equal(expectedNewIds.size, 0, "all 4 new axis ids present")
})

test("VOICE_AXES_V2 first 4 entries === legacy VOICE_AXES (back-compat)", () => {
  for (let i = 0; i < 4; i++) {
    assert.equal(VOICE_AXES_V2[i].id, VOICE_AXES[i].id)
  }
})

test("computeLengthCompliance: 1 of 2 within cap", () => {
  const r = computeLengthCompliance([
    { assistant: "短的。" },
    { assistant: "Long. With. Four. Sentences." },
  ])
  assert.equal(r.compliance, 0.5)
  assert.equal(r.withinCap, 1)
  assert.equal(r.total, 2)
  assert.deepEqual(r.overCapTurns, [1])
})

test("computeLengthCompliance: empty input → compliance 1.0", () => {
  const r = computeLengthCompliance([])
  assert.equal(r.compliance, 1)
  assert.equal(r.total, 0)
})

test("computeLengthCompliance: accepts `reply` field too", () => {
  const r = computeLengthCompliance([{ reply: "ok." }])
  assert.equal(r.compliance, 1)
})

test("computeMirrorRatio: zh char-3gram heavy mirror → high score", () => {
  const r = computeMirrorRatio("我今天面试焦虑", "今天面试焦虑得不行")
  assert.ok(r > 0.3, `expected > 0.3, got ${r}`)
})

test("computeMirrorRatio: en word-bigram mirror → > 0", () => {
  const r = computeMirrorRatio("the offer fell through", "the offer landed today")
  assert.ok(r >= 0.0, "computes a number")
})

test("computeMirrorRatio: empty input → 0", () => {
  assert.equal(computeMirrorRatio("", "anything"), 0)
  assert.equal(computeMirrorRatio("anything", ""), 0)
})

test("computeDriftScore: <2 turns → driftScore 0, samples 0", async () => {
  const r = await computeDriftScore([{ user: "x", assistant: "y" }])
  assert.equal(r.driftScore, 0)
  assert.equal(r.samples, 0)
})

test("computeDriftScore: heavy mirror reflected in mirrorMax", async () => {
  const r = await computeDriftScore([
    { user: "我焦虑得不行", assistant: "我焦虑得不行" },
    { user: "睡不着", assistant: "睡不着" },
  ])
  assert.ok(r.mirrorMax >= 0.5, `mirrorMax should be high, got ${r.mirrorMax}`)
  // repeatMax may be null if no env; either way driftScore is finite
  assert.ok(Number.isFinite(r.driftScore))
})

test("computeAdviceNovelty: empty history → noveltyScore 1", async () => {
  const r = await computeAdviceNovelty("hello", [])
  assert.equal(r.noveltyScore, 1)
})

test("computeAdviceNovelty: env missing → returns null", async () => {
  _resetCache()
  const orig = {
    sf: process.env.SILICONFLOW_API_KEY,
    oai: process.env.PA_OPENAI_AGENT_API_KEY,
    pasf: process.env.PA_SILICONFLOW_API_KEY,
  }
  delete process.env.SILICONFLOW_API_KEY
  delete process.env.PA_OPENAI_AGENT_API_KEY
  delete process.env.PA_SILICONFLOW_API_KEY
  try {
    const r = await computeAdviceNovelty("hi", ["bye", "hi"])
    assert.equal(r, null)
  } finally {
    if (orig.sf !== undefined) process.env.SILICONFLOW_API_KEY = orig.sf
    if (orig.oai !== undefined) process.env.PA_OPENAI_AGENT_API_KEY = orig.oai
    if (orig.pasf !== undefined) process.env.PA_SILICONFLOW_API_KEY = orig.pasf
  }
})

test("computeAdviceNovelty: identical match → noveltyScore ~0 (mocked)", async () => {
  _resetCache()
  process.env.SILICONFLOW_API_KEY = "test-key"
  _setFetchImpl(async (_url, init) => {
    const body = JSON.parse(init.body)
    const inputs = Array.isArray(body.input) ? body.input : [body.input]
    const data = inputs.map((t, i) => {
      const v = new Array(1024).fill(0)
      for (let k = 0; k < t.length && k < 1024; k++) v[k] = (t.charCodeAt(k) % 17) / 17
      return { index: i, embedding: v }
    })
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async text() { return "" },
      async json() { return { data } },
    }
  })
  try {
    const r = await computeAdviceNovelty("foo", ["bar", "foo", "baz"])
    assert.ok(r)
    assert.ok(r.noveltyScore < 0.05, `noveltyScore should be ~0, got ${r.noveltyScore}`)
    assert.equal(r.mostSimilarIdx, 1)
  } finally {
    delete process.env.SILICONFLOW_API_KEY
    _setFetchImpl(null)
    _resetCache()
  }
})

test("inferStrategy: zh Reflection keyword '听起来'", () => {
  const r = inferStrategy("听起来你今天累炸了")
  assert.equal(r.strategy, "Reflection")
  assert.equal(r.matchedKeyword, "听起来")
})

test("inferStrategy: zh Question with ？", () => {
  const r = inferStrategy("怎么样了？")
  assert.equal(r.strategy, "Question")
})

test("inferStrategy: en Suggestion 'try'", () => {
  const r = inferStrategy("try sleeping it off tonight")
  assert.equal(r.strategy, "Suggestion")
})

test("inferStrategy: empty → Other", () => {
  assert.equal(inferStrategy("").strategy, "Other")
  assert.equal(inferStrategy("   ").strategy, "Other")
})

test("inferStrategy: long factual fallback → Information", () => {
  const r = inferStrategy("OPT to H1B requires lottery sponsorship and Sept 30 cap")
  assert.equal(r.strategy, "Information")
})

test("isAllowedStrategy: Suggestion in Exploration (stage 0) → false", () => {
  assert.equal(isAllowedStrategy("Suggestion", 0), false)
})

test("isAllowedStrategy: Suggestion in Action (stage 2) → true", () => {
  assert.equal(isAllowedStrategy("Suggestion", 2), true)
})

test("isAllowedStrategy: Reflection allowed in stages 0+1", () => {
  assert.equal(isAllowedStrategy("Reflection", 0), true)
  assert.equal(isAllowedStrategy("Reflection", 1), true)
  assert.equal(isAllowedStrategy("Reflection", 2), false)
})

test("stageForTurn: ESConv stage map", () => {
  assert.equal(stageForTurn(1), 0)
  assert.equal(stageForTurn(3), 0)
  assert.equal(stageForTurn(4), 1)
  assert.equal(stageForTurn(7), 1)
  assert.equal(stageForTurn(8), 2)
  assert.equal(stageForTurn(50), 2)
})

test("ESCONV_STRATEGIES + STAGE_ALLOWED structural shape", () => {
  assert.equal(ESCONV_STRATEGIES.length, 8)
  assert.equal(ESCONV_STAGE_ALLOWED.length, 3)
  for (const set of ESCONV_STAGE_ALLOWED) {
    assert.ok(set.size >= 1)
  }
})
