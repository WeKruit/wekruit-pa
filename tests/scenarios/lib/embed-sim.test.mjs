/**
 * Phase 33 — embed-sim unit tests.
 *
 * Network-mocked except the explicit live-key test (auto-skipped when env
 * is missing).
 *
 *   node --test tests/scenarios/lib/embed-sim.test.mjs
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  embed,
  embedBatch,
  cosineSim,
  similarity,
  maxSimilarityVsHistory,
  _resetCache,
  _setFetchImpl,
} from "./embed-sim.mjs"

function fakeEmbedding(text) {
  // Deterministic 1024-d vector based on text length + char codes.
  const out = new Float32Array(1024)
  for (let i = 0; i < text.length && i < 1024; i++) {
    out[i] = (text.charCodeAt(i) % 17) / 17
  }
  return out
}

function makeMockFetch({ status = 200, fail = false } = {}) {
  return async (_url, init) => {
    if (fail) throw new Error("network failure")
    const body = JSON.parse(init.body)
    const inputs = Array.isArray(body.input) ? body.input : [body.input]
    const data = inputs.map((t, i) => ({
      index: i,
      embedding: Array.from(fakeEmbedding(String(t))),
    }))
    return {
      ok: status === 200,
      status,
      statusText: status === 200 ? "OK" : "Err",
      async text() { return "" },
      async json() { return { data } },
    }
  }
}

// -- cosineSim math --

test("cosineSim: identical vectors → 1", () => {
  const v = Float32Array.from([1, 2, 3, 4])
  assert.equal(Math.abs(cosineSim(v, v) - 1) < 1e-9, true)
})

test("cosineSim: orthogonal → 0", () => {
  const a = Float32Array.from([1, 0])
  const b = Float32Array.from([0, 1])
  assert.equal(cosineSim(a, b), 0)
})

test("cosineSim: zero vector → 0 (no NaN)", () => {
  const a = Float32Array.from([0, 0, 0])
  const b = Float32Array.from([1, 2, 3])
  assert.equal(cosineSim(a, b), 0)
  assert.equal(Number.isNaN(cosineSim(a, b)), false)
})

test("cosineSim: handles different lengths (truncate to min)", () => {
  const a = Float32Array.from([1, 2])
  const b = Float32Array.from([1, 2, 3, 4])
  assert.ok(Math.abs(cosineSim(a, b) - 1) < 1e-9)
})

test("cosineSim: null/undefined → 0", () => {
  assert.equal(cosineSim(null, Float32Array.from([1])), 0)
  assert.equal(cosineSim(Float32Array.from([1]), undefined), 0)
})

// -- env-missing graceful degrade --

test("embed: returns null when no API key", async () => {
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
    const r = await embed("hello")
    assert.equal(r, null)
  } finally {
    if (orig.sf !== undefined) process.env.SILICONFLOW_API_KEY = orig.sf
    if (orig.oai !== undefined) process.env.PA_OPENAI_AGENT_API_KEY = orig.oai
    if (orig.pasf !== undefined) process.env.PA_SILICONFLOW_API_KEY = orig.pasf
  }
})

test("embedBatch: returns null when no API key (and no cache hits)", async () => {
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
    const r = await embedBatch(["a", "b"])
    assert.equal(r, null)
  } finally {
    if (orig.sf !== undefined) process.env.SILICONFLOW_API_KEY = orig.sf
    if (orig.oai !== undefined) process.env.PA_OPENAI_AGENT_API_KEY = orig.oai
    if (orig.pasf !== undefined) process.env.PA_SILICONFLOW_API_KEY = orig.pasf
  }
})

// -- mocked-fetch happy path --

test("embed: caches + reuses result on second call (mocked)", async () => {
  _resetCache()
  process.env.SILICONFLOW_API_KEY = "test-key"
  let calls = 0
  _setFetchImpl(async (url, init) => {
    calls += 1
    return makeMockFetch()(url, init)
  })
  try {
    const a = await embed("hello world")
    const b = await embed("hello world")
    assert.ok(a instanceof Float32Array)
    assert.equal(a.length, 1024)
    assert.equal(calls, 1, "second call hits cache")
    assert.equal(cosineSim(a, b), 1)
  } finally {
    delete process.env.SILICONFLOW_API_KEY
    _setFetchImpl(null)
    _resetCache()
  }
})

test("embedBatch: dedup-by-cache + single network call (mocked)", async () => {
  _resetCache()
  process.env.SILICONFLOW_API_KEY = "test-key"
  let calls = 0
  _setFetchImpl(async (url, init) => {
    calls += 1
    return makeMockFetch()(url, init)
  })
  try {
    await embed("foo")
    const out = await embedBatch(["foo", "bar", "baz"])
    assert.equal(calls, 2, "first embed + one batch call (foo cached on second)")
    assert.equal(out.length, 3)
    out.forEach((v) => assert.ok(v instanceof Float32Array))
  } finally {
    delete process.env.SILICONFLOW_API_KEY
    _setFetchImpl(null)
    _resetCache()
  }
})

test("similarity: returns null when env missing", async () => {
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
    const r = await similarity("a", "b")
    assert.equal(r, null)
  } finally {
    if (orig.sf !== undefined) process.env.SILICONFLOW_API_KEY = orig.sf
    if (orig.oai !== undefined) process.env.PA_OPENAI_AGENT_API_KEY = orig.oai
    if (orig.pasf !== undefined) process.env.PA_SILICONFLOW_API_KEY = orig.pasf
  }
})

test("similarity: identical text → 1.0 (mocked)", async () => {
  _resetCache()
  process.env.SILICONFLOW_API_KEY = "test-key"
  _setFetchImpl(makeMockFetch())
  try {
    const s = await similarity("hello", "hello")
    assert.ok(Math.abs(s - 1) < 1e-9)
  } finally {
    delete process.env.SILICONFLOW_API_KEY
    _setFetchImpl(null)
    _resetCache()
  }
})

test("maxSimilarityVsHistory: empty history → maxSim 0", async () => {
  _resetCache()
  process.env.SILICONFLOW_API_KEY = "test-key"
  _setFetchImpl(makeMockFetch())
  try {
    const r = await maxSimilarityVsHistory("hello", [])
    assert.deepEqual(r, { maxSim: 0, mostSimilarIdx: -1, sims: [] })
  } finally {
    delete process.env.SILICONFLOW_API_KEY
    _setFetchImpl(null)
    _resetCache()
  }
})

test("maxSimilarityVsHistory: identical match in history → maxSim ~1", async () => {
  _resetCache()
  process.env.SILICONFLOW_API_KEY = "test-key"
  _setFetchImpl(makeMockFetch())
  try {
    const r = await maxSimilarityVsHistory("hello", ["world", "hello", "foo"])
    assert.ok(r)
    assert.equal(r.mostSimilarIdx, 1)
    assert.ok(Math.abs(r.maxSim - 1) < 1e-9)
  } finally {
    delete process.env.SILICONFLOW_API_KEY
    _setFetchImpl(null)
    _resetCache()
  }
})

test("embed: surfaces non-200 SiliconFlow errors", async () => {
  _resetCache()
  process.env.SILICONFLOW_API_KEY = "test-key"
  _setFetchImpl(makeMockFetch({ status: 500 }))
  try {
    await assert.rejects(() => embed("boom"), /500/)
  } finally {
    delete process.env.SILICONFLOW_API_KEY
    _setFetchImpl(null)
    _resetCache()
  }
})

test("embed: empty string returns zero-vector (no network)", async () => {
  _resetCache()
  let calls = 0
  _setFetchImpl(async () => { calls += 1; throw new Error("should not be called") })
  try {
    const r = await embed("")
    assert.ok(r instanceof Float32Array)
    assert.equal(r.length, 1024)
    assert.equal(calls, 0)
  } finally {
    _setFetchImpl(null)
    _resetCache()
  }
})
