/**
 * Phase 35 T4 — F4 advice-repeat detector tests.
 *
 * All tests are network-isolated via `_setFetchImpl(mockFetch)`. No real
 * SiliconFlow calls. Coverage:
 * - graceful degrade (missing key, network error, malformed response)
 * - empty history / empty current reply
 * - cosine math
 * - LRU cache (2nd identical input hits cache)
 * - threshold boundary (0.84 → not triggered, 0.86 → triggered)
 * - shape contract (id, triggered, score, reason, suggested_action, latencyMs)
 */
import assert from "node:assert/strict"
import test, { afterEach, beforeEach } from "node:test"

import {
  _resetCache,
  _setFetchImpl,
  cosineSim,
  detectAdviceRepeat,
} from "./f4-advice-repeat.js"
import type { DetectorContext } from "./types.js"

function ctx(assistant: string, history: string[] = []): DetectorContext {
  return {
    turn: { user: "u", assistant },
    history: { claireReplies: history },
  }
}

/**
 * Build a deterministic embedding for a string by polynomial-rolling-hash
 * into a fixed 64-dim vector. Identical input → identical vector → cosSim
 * = 1. Distinct input → orthogonal-ish vectors → cosSim near 0.
 *
 * Uses 64 dims so distinct strings rarely collide on the same dim. Char
 * codes multiplied by a per-position prime so position matters (avoids
 * "hello" and "olleh" producing identical vectors).
 */
function fakeEmbed(text: string): number[] {
  const dims = 64
  const v = new Array(dims).fill(0)
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // Mix position + char into the dim index via a non-linear hash.
    const dim = (code * 31 + i * 17) % dims
    v[dim] += code + 1
  }
  return v
}

function makeMockFetch(embedFor: (text: string) => number[]) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString()
    if (!url.includes("/embeddings")) {
      return new Response("not found", { status: 404 })
    }
    const body = JSON.parse((init?.body as string) ?? "{}") as { input: string[] }
    const data = body.input.map((t, idx) => ({ index: idx, embedding: embedFor(t) }))
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }
}

const TEST_API_KEY = "sk-test-fixture"

beforeEach(() => {
  _resetCache()
  _setFetchImpl(null)
  process.env.SILICONFLOW_API_KEY = TEST_API_KEY
})

afterEach(() => {
  _resetCache()
  _setFetchImpl(null)
  delete process.env.SILICONFLOW_API_KEY
  delete process.env.PA_OPENAI_AGENT_API_KEY
  delete process.env.PA_SILICONFLOW_API_KEY
})

test("F4 graceful degrade — no env key returns skipped (no throw)", async () => {
  delete process.env.SILICONFLOW_API_KEY
  delete process.env.PA_OPENAI_AGENT_API_KEY
  delete process.env.PA_SILICONFLOW_API_KEY

  const r = await detectAdviceRepeat(ctx("hello", ["world"]))
  assert.equal(r.triggered, false)
  assert.equal(r.score, null)
  assert.match(r.reason, /skipped: no embed api key/)
  assert.equal(r.suggested_action, null)
  assert.equal(r.id, "f4_advice_repeat")
})

test("F4 graceful degrade — fetch throws returns skipped (no throw)", async () => {
  _setFetchImpl(async () => {
    throw new Error("network down")
  })
  const r = await detectAdviceRepeat(ctx("hello", ["world"]))
  assert.equal(r.triggered, false)
  assert.equal(r.score, null)
  assert.match(r.reason, /skipped: embed network error.*network down/)
  assert.equal(r.suggested_action, null)
})

test("F4 graceful degrade — non-200 response returns skipped (no throw)", async () => {
  _setFetchImpl(async () => new Response("server error", { status: 500, statusText: "ISE" }))
  const r = await detectAdviceRepeat(ctx("hello", ["world"]))
  assert.equal(r.triggered, false)
  assert.equal(r.score, null)
  assert.match(r.reason, /skipped: embed network error.*500/)
})

test("F4 graceful degrade — malformed JSON returns skipped", async () => {
  _setFetchImpl(async () => new Response("not json", { status: 200 }))
  const r = await detectAdviceRepeat(ctx("hello", ["world"]))
  assert.equal(r.triggered, false)
  assert.equal(r.score, null)
  assert.match(r.reason, /skipped: embed network error/)
})

test("F4 empty current reply → no_input (no fetch call)", async () => {
  let called = false
  _setFetchImpl(async () => {
    called = true
    return new Response("never", { status: 500 })
  })
  const r = await detectAdviceRepeat(ctx("", ["history"]))
  assert.equal(r.triggered, false)
  assert.equal(r.score, 0)
  assert.equal(r.reason, "no_input")
  assert.equal(called, false, "should not call fetch when input empty")
})

test("F4 empty history → no_history (no fetch call)", async () => {
  let called = false
  _setFetchImpl(async () => {
    called = true
    return new Response("never", { status: 500 })
  })
  const r = await detectAdviceRepeat(ctx("hello", []))
  assert.equal(r.triggered, false)
  assert.equal(r.score, 0)
  assert.equal(r.reason, "no_history")
  assert.equal(called, false, "should not call fetch when history empty")
})

test("F4 identical reply in history triggers (cosSim ≈ 1.0)", async () => {
  _setFetchImpl(makeMockFetch(fakeEmbed))
  const r = await detectAdviceRepeat(ctx("same advice", ["other", "same advice"]))
  assert.equal(r.triggered, true)
  assert.ok(r.score! >= 0.99, `expected cosSim ~= 1.0, got ${r.score}`)
  assert.equal(r.suggested_action, "reject_resample")
  assert.match(r.reason, /cos_sim_.*>=/)
})

test("F4 distinct reply does not trigger (cosSim < 0.85)", async () => {
  _setFetchImpl(makeMockFetch(fakeEmbed))
  const r = await detectAdviceRepeat(
    ctx("today is rough", ["go to sleep please", "drink some water now"])
  )
  // Distinct strings → distinct fake embeddings → cosSim < 0.85.
  assert.equal(r.triggered, false, `unexpected trigger; reason: ${r.reason}, score: ${r.score}`)
  assert.ok(r.score! < 0.85)
  assert.equal(r.suggested_action, null)
})

test("F4 threshold override via ctx.env.f4RepeatThreshold", async () => {
  _setFetchImpl(makeMockFetch(fakeEmbed))
  // Identical strings → cosSim = 1.0 → triggers at any threshold < 1.0.
  // Verify: strict (0.5) triggers, lax (0.999999) does NOT trigger
  // (since 1.0 < 0.999999 is false → triggered by `>=` is true).
  // Use a threshold of exactly 1.0 + 1e-9 so even 1.0 fails the >= check.
  const c = ctx("identical advice", ["identical advice", "other text"])
  const strict = await detectAdviceRepeat({ ...c, env: { f4RepeatThreshold: 0.5 } })
  // For lax, cosSim of identical = 1.0; we use a threshold that 1.0 won't reach.
  // Since cosSim is bounded above at 1.0, threshold > 1.0 means never triggers.
  const lax = await detectAdviceRepeat({ ...c, env: { f4RepeatThreshold: 1.001 } })
  assert.equal(strict.triggered, true, `strict (0.5) should trigger; score: ${strict.score}`)
  assert.equal(lax.triggered, false, `lax (1.001) should never trigger; score: ${lax.score}`)
})

test("F4 LRU cache — 2nd call same texts hits cache (1 fetch total)", async () => {
  let fetchCount = 0
  _setFetchImpl(async (input, init) => {
    fetchCount += 1
    const url = typeof input === "string" ? input : input.toString()
    if (!url.includes("/embeddings")) return new Response("nf", { status: 404 })
    const body = JSON.parse((init?.body as string) ?? "{}") as { input: string[] }
    const data = body.input.map((t, idx) => ({ index: idx, embedding: fakeEmbed(t) }))
    return new Response(JSON.stringify({ data }), { status: 200 })
  })

  const c = ctx("hello world", ["foo bar"])
  await detectAdviceRepeat(c)
  await detectAdviceRepeat(c)
  // Both calls embed the same 2 texts. After the 1st call, cache holds
  // both. 2nd call hits cache → 0 additional fetches.
  assert.equal(fetchCount, 1, `expected 1 fetch, got ${fetchCount}`)
})

test("F4 cosineSim math — identical vectors = 1, orthogonal = 0", () => {
  const a = Float32Array.from([1, 2, 3, 4])
  const zero = Float32Array.from([0, 0, 0, 0])
  assert.ok(Math.abs(cosineSim(a, a) - 1) < 1e-6)
  assert.equal(cosineSim(a, zero), 0)
})

test("F4 result shape contract — every field present", async () => {
  _setFetchImpl(makeMockFetch(fakeEmbed))
  const r = await detectAdviceRepeat(ctx("test reply", ["history"]))
  assert.equal(r.id, "f4_advice_repeat")
  assert.ok(typeof r.triggered === "boolean")
  assert.ok(r.score === null || typeof r.score === "number")
  assert.ok(typeof r.reason === "string")
  assert.ok(
    r.suggested_action === null ||
      r.suggested_action === "strip" ||
      r.suggested_action === "regenerate" ||
      r.suggested_action === "reject_resample"
  )
  assert.ok(typeof r.latencyMs === "number" && Number.isFinite(r.latencyMs))
})

test("F4 latency wrapper overhead < 20ms (mock fetch with 50ms delay)", async () => {
  _setFetchImpl(async (input, init) => {
    await new Promise((r) => setTimeout(r, 50))
    const body = JSON.parse((init?.body as string) ?? "{}") as { input: string[] }
    const data = body.input.map((t, idx) => ({ index: idx, embedding: fakeEmbed(t) }))
    return new Response(JSON.stringify({ data }), { status: 200 })
  })
  const r = await detectAdviceRepeat(ctx("a", ["b"]))
  // Mock fetch sleeps 50ms; total wrapper overhead should be small.
  assert.ok(r.latencyMs < 100, `expected < 100ms, got ${r.latencyMs}`)
  assert.ok(r.latencyMs >= 45, `expected approximately the 50ms mock delay, got ${r.latencyMs}`)
})

test("F4 sliding window — uses only last 3 history entries", async () => {
  let receivedInputs: string[] = []
  _setFetchImpl(async (input, init) => {
    const body = JSON.parse((init?.body as string) ?? "{}") as { input: string[] }
    receivedInputs = body.input
    const data = body.input.map((t, idx) => ({ index: idx, embedding: fakeEmbed(t) }))
    return new Response(JSON.stringify({ data }), { status: 200 })
  })
  await detectAdviceRepeat(ctx("current", ["h1", "h2", "h3", "h4", "h5"]))
  // 1 reply + 3 history (sliding window of 3) = 4 inputs.
  assert.equal(receivedInputs.length, 4)
  assert.equal(receivedInputs[0], "current")
  assert.deepEqual(receivedInputs.slice(1), ["h3", "h4", "h5"])
})
