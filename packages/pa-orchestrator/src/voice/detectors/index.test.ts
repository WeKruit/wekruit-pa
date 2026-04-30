/**
 * Phase 35 T1 — orchestrator framework tests.
 *
 * Covers: parallel exec, latencyMs population, error capture, opts.detectors
 * override, result-shape contract, default detector set wiring.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_DETECTORS,
  runAllDetectors,
  type DetectorContext,
  type DetectorFn,
  type DetectorResult,
  type SuggestedAction,
} from "./index.js"

const baseCtx: DetectorContext = {
  turn: { user: "hello", assistant: "hi" },
  history: { claireReplies: [] },
}

function makeStub(
  id: DetectorResult["id"],
  triggered: boolean,
  action: SuggestedAction | null = null,
  delayMs = 0
): DetectorFn {
  const fn: DetectorFn = async () => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    return {
      id,
      triggered,
      score: triggered ? 0.9 : 0,
      reason: triggered ? "stub_triggered" : "stub_clean",
      suggested_action: triggered ? action : null,
      latencyMs: 0,
    }
  }
  // Set fn.name so the orchestrator's id-from-fn fallback works for errors.
  Object.defineProperty(fn, "name", { value: "stub_" + id })
  return fn
}

test("runAllDetectors returns one result per detector in order", async () => {
  const stubs = [
    makeStub("f1_verb_mirror", false),
    makeStub("f2_length_cap", true, "strip"),
    makeStub("f3_lang_lock", false),
  ]
  const results = await runAllDetectors(baseCtx, { detectors: stubs })
  assert.equal(results.length, 3)
  assert.equal(results[0].id, "f1_verb_mirror")
  assert.equal(results[1].id, "f2_length_cap")
  assert.equal(results[1].triggered, true)
  assert.equal(results[1].suggested_action, "strip")
  assert.equal(results[2].id, "f3_lang_lock")
})

test("runAllDetectors populates latencyMs even if detector returns 0", async () => {
  const slow = makeStub("f1_verb_mirror", false, null, 15)
  const [r] = await runAllDetectors(baseCtx, { detectors: [slow] })
  assert.ok(r.latencyMs >= 10, `expected latencyMs >= 10ms, got ${r.latencyMs}`)
})

test("runAllDetectors runs detectors in parallel (not serial)", async () => {
  const slow1 = makeStub("f1_verb_mirror", false, null, 50)
  const slow2 = makeStub("f2_length_cap", false, null, 50)
  const slow3 = makeStub("f3_lang_lock", false, null, 50)
  const start = performance.now()
  await runAllDetectors(baseCtx, { detectors: [slow1, slow2, slow3] })
  const elapsed = performance.now() - start
  // Serial would be ≥150ms. Parallel should be ≤100ms even on a slow box.
  assert.ok(elapsed < 100, `expected parallel < 100ms, got ${elapsed}ms`)
})

test("runAllDetectors captures detector errors as result objects (no throw)", async () => {
  const throwing: DetectorFn = () => {
    throw new Error("boom")
  }
  Object.defineProperty(throwing, "name", { value: "stub_VerbMirror" })
  const results = await runAllDetectors(baseCtx, { detectors: [throwing] })
  assert.equal(results.length, 1)
  assert.equal(results[0].triggered, false)
  assert.match(results[0].reason, /detector_error: .*boom/)
  assert.equal(results[0].suggested_action, null)
})

test("runAllDetectors captures async-rejected detectors (no throw)", async () => {
  const rejecting: DetectorFn = async () => {
    throw new Error("async-boom")
  }
  Object.defineProperty(rejecting, "name", { value: "stub_LengthCap" })
  const results = await runAllDetectors(baseCtx, { detectors: [rejecting] })
  assert.equal(results.length, 1)
  assert.equal(results[0].id, "f2_length_cap")
  assert.match(results[0].reason, /detector_error: .*async-boom/)
})

test("runAllDetectors with no opts uses DEFAULT_DETECTORS (4 detectors)", async () => {
  const results = await runAllDetectors(baseCtx)
  assert.equal(results.length, DEFAULT_DETECTORS.length)
  assert.equal(results.length, 4)
  // All detector IDs must be unique + match the contract enum.
  const ids = new Set(results.map((r) => r.id))
  assert.equal(ids.size, 4)
  assert.ok(ids.has("f1_verb_mirror"))
  assert.ok(ids.has("f2_length_cap"))
  assert.ok(ids.has("f3_lang_lock"))
  assert.ok(ids.has("f4_advice_repeat"))
})

test("runAllDetectors result shape contract — every field present", async () => {
  const results = await runAllDetectors(baseCtx)
  for (const r of results) {
    assert.ok(typeof r.id === "string", `id: ${r.id}`)
    assert.ok(typeof r.triggered === "boolean")
    assert.ok(r.score === null || typeof r.score === "number")
    assert.ok(typeof r.reason === "string")
    assert.ok(
      r.suggested_action === null ||
        r.suggested_action === "strip" ||
        r.suggested_action === "regenerate" ||
        r.suggested_action === "reject_resample",
      `bad action: ${r.suggested_action}`
    )
    assert.ok(typeof r.latencyMs === "number" && Number.isFinite(r.latencyMs))
  }
})
