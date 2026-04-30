/**
 * Phase 37 T2 — transitions table tests + Phase 33 parity audit.
 *
 * Parity oracle: dynamic-import `tests/scenarios/lib/voice-axes.mjs` (NOT
 * direct TS import — cross-rootDir). Asserts:
 * - 8 strategies match (deepEqual on string array)
 * - 3 stage allowed-sets match (per-set deepEqual)
 * - stageForTurn produces identical output for 1, 3, 4, 7, 8, 100
 */
import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import path from "node:path"

import {
  ESCONV_STRATEGIES,
  STAGE_ALLOWED_STRATEGIES,
  UX_STATE_PREFERRED_STRATEGIES,
  allowedStrategies,
  isAllowedForTurn,
  nextStrategyWeights,
  preferredNextStrategy,
  stageForTurn,
  stageNameForIndex,
} from "./transitions.js"

import type { Strategy } from "./types.js"

// ---------------------------------------------------------------------------
// Phase 33 parity — dynamic import .mjs canonical source
// ---------------------------------------------------------------------------

// Path: from this test file → ../../../../../tests/scenarios/lib/voice-axes.mjs
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const VOICE_AXES_MJS = path.resolve(
  __dirname,
  "../../../../../tests/scenarios/lib/voice-axes.mjs"
)

test("Phase 33 parity — ESCONV_STRATEGIES (8 strategies match)", async () => {
  const mjs = await import(VOICE_AXES_MJS)
  assert.deepEqual([...ESCONV_STRATEGIES], [...mjs.ESCONV_STRATEGIES])
})

test("Phase 33 parity — STAGE_ALLOWED_STRATEGIES (3 stages match per-set)", async () => {
  const mjs = await import(VOICE_AXES_MJS)
  assert.equal(STAGE_ALLOWED_STRATEGIES.length, mjs.ESCONV_STAGE_ALLOWED.length)
  assert.equal(STAGE_ALLOWED_STRATEGIES.length, 3)
  for (let i = 0; i < 3; i++) {
    const tsSet = STAGE_ALLOWED_STRATEGIES[i]
    const mjsSet = mjs.ESCONV_STAGE_ALLOWED[i]
    assert.equal(tsSet.size, mjsSet.size, `stage ${i} size`)
    for (const s of tsSet) assert.ok(mjsSet.has(s), `stage ${i} missing ${s}`)
    for (const s of mjsSet) assert.ok(tsSet.has(s), `stage ${i} extra ${s}`)
  }
})

test("Phase 33 parity — stageForTurn maps identical for 1,3,4,7,8,100", async () => {
  const mjs = await import(VOICE_AXES_MJS)
  for (const t of [1, 3, 4, 7, 8, 100]) {
    assert.equal(stageForTurn(t), mjs.stageForTurn(t), `turn ${t}`)
  }
})

// ---------------------------------------------------------------------------
// stageForTurn semantics
// ---------------------------------------------------------------------------

test("stageForTurn — Exploration (1-3)", () => {
  assert.equal(stageForTurn(1), 0)
  assert.equal(stageForTurn(2), 0)
  assert.equal(stageForTurn(3), 0)
})

test("stageForTurn — Comforting (4-7)", () => {
  assert.equal(stageForTurn(4), 1)
  assert.equal(stageForTurn(7), 1)
})

test("stageForTurn — Action (8+)", () => {
  assert.equal(stageForTurn(8), 2)
  assert.equal(stageForTurn(100), 2)
})

test("stageForTurn — invalid input → 0", () => {
  assert.equal(stageForTurn(0), 0)
  assert.equal(stageForTurn(-5), 0)
  assert.equal(stageForTurn(NaN), 0)
})

test("stageNameForIndex — round-trip", () => {
  assert.equal(stageNameForIndex(0), "Exploration")
  assert.equal(stageNameForIndex(1), "Comforting")
  assert.equal(stageNameForIndex(2), "Action")
})

// ---------------------------------------------------------------------------
// allowedStrategies — D-37-2 intersection
// ---------------------------------------------------------------------------

test("allowedStrategies — Exploration × WarmCurious includes Question + Reflection", () => {
  const set = allowedStrategies(0, "WarmCurious")
  assert.ok(set.has("Question"))
  assert.ok(set.has("Reflection"))
  assert.ok(set.has("Restatement"))
  assert.ok(!set.has("Suggestion"), "Suggestion not allowed in Exploration")
})

test("allowedStrategies — Action × QuietWitness excludes Suggestion (gravity rule)", () => {
  const set = allowedStrategies(2, "QuietWitness")
  assert.ok(!set.has("Suggestion"), "QuietWitness must NEVER allow Suggestion")
  assert.ok(!set.has("Information"), "QuietWitness must NEVER allow Information")
  assert.ok(!set.has("Question"), "QuietWitness must NEVER allow Question")
  assert.ok(set.has("Affirmation"))
})

test("allowedStrategies — Action × FirmDirect green-lights Suggestion + Information", () => {
  const set = allowedStrategies(2, "FirmDirect")
  assert.ok(set.has("Suggestion"))
  assert.ok(set.has("Information"))
})

test("allowedStrategies — Exploration × FirmDirect (intersection check)", () => {
  // FirmDirect prefers {Suggestion, Information, Affirmation, Question}
  // Exploration allows {Question, Restatement, Reflection}
  // Intersection = {Question} only.
  const set = allowedStrategies(0, "FirmDirect")
  assert.ok(set.has("Question"))
  assert.equal(set.size, 1)
})

test("allowedStrategies — fallback to stage-only when intersection empty", () => {
  // Comforting allows {Reflection, Affirmation, SelfDisclosure}
  // PlayfulTease prefers {Affirmation, SelfDisclosure, Other}
  // Intersection = {Affirmation, SelfDisclosure} - non-empty.
  // Synthetic test: corrupt UX_STATE_PREFERRED... not possible (readonly).
  // Instead verify that for every (stage × uxState) pair, the result is non-empty.
  for (let stage = 0; stage <= 2; stage++) {
    for (const ux of [
      "WarmCurious",
      "PlayfulTease",
      "SoftConcerned",
      "FirmDirect",
      "QuietWitness",
    ] as const) {
      const set = allowedStrategies(stage as 0 | 1 | 2, ux)
      assert.ok(set.size > 0, `${stage} × ${ux} produced empty allowed-set`)
    }
  }
})

test("isAllowedForTurn — wrapper agrees with allowedStrategies", () => {
  assert.equal(isAllowedForTurn("Question", 0, "WarmCurious"), true)
  assert.equal(isAllowedForTurn("Suggestion", 0, "WarmCurious"), false)
  assert.equal(isAllowedForTurn("Suggestion", 2, "QuietWitness"), false)
  assert.equal(isAllowedForTurn("Suggestion", 2, "FirmDirect"), true)
})

// ---------------------------------------------------------------------------
// nextStrategyWeights — D-37-4 TransESC continuity
// ---------------------------------------------------------------------------

test("nextStrategyWeights — uniform when no prev", () => {
  const allowed = new Set<Strategy>(["Question", "Restatement", "Reflection"])
  const w = nextStrategyWeights(undefined, allowed)
  assert.equal(w.size, 3)
  for (const v of w.values()) {
    assert.ok(Math.abs(v - 1 / 3) < 1e-6, `expected ~0.333, got ${v}`)
  }
})

test("nextStrategyWeights — uniform when prev not in allowed-set", () => {
  const allowed = new Set<Strategy>(["Reflection", "Affirmation"])
  const w = nextStrategyWeights("Suggestion", allowed)
  assert.equal(w.size, 2)
  for (const v of w.values()) {
    assert.ok(Math.abs(v - 0.5) < 1e-6)
  }
})

test("nextStrategyWeights — adjacency bonus Question→Restatement", () => {
  const allowed = new Set<Strategy>(["Question", "Restatement", "Reflection"])
  const w = nextStrategyWeights("Question", allowed)
  // prev (Question) gets 0.5
  assert.ok(Math.abs((w.get("Question") ?? 0) - 0.5) < 1e-6)
  // adjacency Question→Restatement gets 0.2
  assert.ok(Math.abs((w.get("Restatement") ?? 0) - 0.2) < 1e-6)
  // remaining (Reflection) gets 0.3 / 1 = 0.3
  assert.ok(Math.abs((w.get("Reflection") ?? 0) - 0.3) < 1e-6)
  // Sum = 1.0
  let sum = 0
  for (const v of w.values()) sum += v
  assert.ok(Math.abs(sum - 1) < 1e-6, `expected sum=1, got ${sum}`)
})

test("nextStrategyWeights — empty allowed-set returns empty map", () => {
  const w = nextStrategyWeights("Question", new Set<Strategy>())
  assert.equal(w.size, 0)
})

test("preferredNextStrategy — argmax respects continuity", () => {
  const allowed = new Set<Strategy>(["Question", "Restatement", "Reflection"])
  const next = preferredNextStrategy("Question", allowed)
  // Question (prev) at 0.5 wins over Restatement (0.2) and Reflection (0.3).
  assert.equal(next, "Question")
})

test("preferredNextStrategy — uniform → first in ESCONV_STRATEGIES wins", () => {
  const allowed = new Set<Strategy>(["Affirmation", "Reflection"])
  // Uniform 0.5/0.5; argmax tie-break = ESCONV_STRATEGIES order = Reflection (idx 2) before Affirmation (idx 4)
  const next = preferredNextStrategy(undefined, allowed)
  assert.equal(next, "Reflection")
})

// ---------------------------------------------------------------------------
// Symbol checks — UX_STATE_PREFERRED_STRATEGIES sanity
// ---------------------------------------------------------------------------

test("UX_STATE_PREFERRED_STRATEGIES — QuietWitness never includes Suggestion/Information/Question", () => {
  const set = UX_STATE_PREFERRED_STRATEGIES.QuietWitness
  assert.ok(!set.has("Suggestion"))
  assert.ok(!set.has("Information"))
  assert.ok(!set.has("Question"))
})

test("UX_STATE_PREFERRED_STRATEGIES — FirmDirect includes Suggestion + Information", () => {
  const set = UX_STATE_PREFERRED_STRATEGIES.FirmDirect
  assert.ok(set.has("Suggestion"))
  assert.ok(set.has("Information"))
})

test("UX_STATE_PREFERRED_STRATEGIES — PlayfulTease allows Other (banter wildcard)", () => {
  const set = UX_STATE_PREFERRED_STRATEGIES.PlayfulTease
  assert.ok(set.has("Other"))
})
