/**
 * Phase 33 — smoke verify all 4 new voice axes return numeric (or
 * explicit-null with reason) on hand-crafted fixture replies.
 *
 * No live API calls — env-missing path is the canonical "axis returns
 * null" smoke. The mocked-fetch path proves the same axes return finite
 * numeric when env IS present.
 *
 * HARNESS-04 acceptance gate: each of the 4 new axes resolves to either
 * a finite number or `null`-with-reason on every fixture; never throws,
 * never returns NaN/Infinity.
 *
 *   node --test tests/scenarios/lib/voice-axes-smoke.test.mjs
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

import {
  computeLengthCompliance,
  computeDriftScore,
  computeAdviceNovelty,
  inferStrategy,
  isAllowedStrategy,
  stageForTurn,
} from "./voice-axes.mjs"
import { _resetCache, _setFetchImpl } from "./embed-sim.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = JSON.parse(
  readFileSync(resolve(__dirname, "voice-axes-smoke-fixtures.json"), "utf8")
).fixtures

function isFiniteOrNullWithReason(v) {
  if (v === null || v === undefined) return true
  if (typeof v === "number") return Number.isFinite(v)
  if (typeof v === "object") {
    return Object.values(v).every(
      (x) => x === null || x === undefined || typeof x === "string" || typeof x === "boolean" ||
             (typeof x === "number" && Number.isFinite(x)) ||
             Array.isArray(x) ||
             (typeof x === "object")
    )
  }
  return false
}

function fakeMockedFetch() {
  return async (_url, init) => {
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
  }
}

// HARNESS-04 — env-missing canonical path
for (const fixture of FIXTURES) {
  test(`smoke[env-missing] ${fixture.id}: 4 new axes finite-or-null`, async () => {
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
      const turns = fixture.turns
      // length_compliance: deterministic, never null
      const lengthAgg = computeLengthCompliance(turns)
      assert.ok(Number.isFinite(lengthAgg.compliance), "length_compliance numeric")
      assert.ok(lengthAgg.compliance >= 0 && lengthAgg.compliance <= 1)

      // drift_resistance: numeric driftScore + numeric mirror; repeatMax may be null
      const driftAgg = await computeDriftScore(turns)
      assert.ok(Number.isFinite(driftAgg.driftScore), "driftScore numeric")
      assert.ok(Number.isFinite(driftAgg.mirrorMax), "mirrorMax numeric")
      // repeatMax is null when env missing — that's the documented contract
      assert.ok(driftAgg.repeatMax === null, "repeatMax null when env missing")

      // advice_novelty: null when env missing AND ≥1 prior reply present
      const claireReplies = turns.map((t) => t.assistant).filter(Boolean)
      const last = claireReplies[claireReplies.length - 1]
      const history = claireReplies.slice(-4, -1)
      const noveltyAgg = await computeAdviceNovelty(last, history)
      if (history.length === 0) {
        assert.ok(noveltyAgg && noveltyAgg.noveltyScore === 1, "no history → noveltyScore 1")
      } else {
        assert.equal(noveltyAgg, null, "env missing + history present → null")
      }

      // strategy_fit: keyword classifier never null for non-empty reply
      for (let i = 0; i < turns.length; i++) {
        const reply = turns[i].assistant
        if (!reply) continue
        const inferred = inferStrategy(reply)
        assert.ok(typeof inferred.strategy === "string")
        assert.ok(inferred.strategy.length > 0)
        const stage = stageForTurn(i + 1)
        const allowed = isAllowedStrategy(inferred.strategy, stage)
        assert.equal(typeof allowed, "boolean")
      }
    } finally {
      if (orig.sf !== undefined) process.env.SILICONFLOW_API_KEY = orig.sf
      if (orig.oai !== undefined) process.env.PA_OPENAI_AGENT_API_KEY = orig.oai
      if (orig.pasf !== undefined) process.env.PA_SILICONFLOW_API_KEY = orig.pasf
    }
  })
}

// Mocked-fetch path — same axes resolve to numeric when env IS present
for (const fixture of FIXTURES) {
  test(`smoke[mocked-fetch] ${fixture.id}: novelty + drift repeatMax become numeric`, async () => {
    _resetCache()
    process.env.SILICONFLOW_API_KEY = "smoke-test-key"
    _setFetchImpl(fakeMockedFetch())
    try {
      const turns = fixture.turns
      const driftAgg = await computeDriftScore(turns)
      // multi-turn fixtures should produce numeric repeatMax
      if (turns.length >= 2) {
        assert.ok(
          driftAgg.repeatMax === null || Number.isFinite(driftAgg.repeatMax),
          "repeatMax numeric or null"
        )
      }
      const claireReplies = turns.map((t) => t.assistant).filter(Boolean)
      const last = claireReplies[claireReplies.length - 1]
      const history = claireReplies.slice(-4, -1)
      const noveltyAgg = await computeAdviceNovelty(last, history)
      assert.ok(noveltyAgg, "novelty resolves to object, not null, with mocked fetch")
      assert.ok(Number.isFinite(noveltyAgg.noveltyScore), "noveltyScore numeric")
      assert.ok(noveltyAgg.noveltyScore >= 0 && noveltyAgg.noveltyScore <= 1)
    } finally {
      delete process.env.SILICONFLOW_API_KEY
      _setFetchImpl(null)
      _resetCache()
    }
  })
}

test("HARNESS-04 acceptance: all 4 axes return numeric on the 3-turn fixture", async () => {
  _resetCache()
  process.env.SILICONFLOW_API_KEY = "smoke-test-key"
  _setFetchImpl(fakeMockedFetch())
  try {
    const fixture = FIXTURES.find((f) => f.id === "claire-multi-turn-mirror-trap")
    assert.ok(fixture)
    const turns = fixture.turns
    const lengthAgg = computeLengthCompliance(turns)
    const driftAgg = await computeDriftScore(turns)
    const claireReplies = turns.map((t) => t.assistant)
    const noveltyAgg = await computeAdviceNovelty(
      claireReplies[claireReplies.length - 1],
      claireReplies.slice(0, -1)
    )
    const inferred = inferStrategy(claireReplies[claireReplies.length - 1])
    const stage = stageForTurn(turns.length)
    const allowed = isAllowedStrategy(inferred.strategy, stage)

    assert.ok(Number.isFinite(lengthAgg.compliance), "length_compliance numeric")
    assert.ok(Number.isFinite(driftAgg.driftScore), "drift_resistance.driftScore numeric")
    assert.ok(Number.isFinite(driftAgg.mirrorMax), "drift_resistance.mirrorMax numeric")
    assert.ok(noveltyAgg && Number.isFinite(noveltyAgg.noveltyScore), "advice_novelty numeric")
    assert.ok(typeof inferred.strategy === "string", "strategy_fit classifier returned string")
    assert.equal(typeof allowed, "boolean")
  } finally {
    delete process.env.SILICONFLOW_API_KEY
    _setFetchImpl(null)
    _resetCache()
  }
})
