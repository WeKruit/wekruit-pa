/**
 * Phase 37 T3 — accuracy gate test for the 50 labeled fixtures.
 *
 * Two gates per CONTEXT D-37-6:
 * 1. ux_state classifier accuracy ≥ 70% (35/50 minimum)
 * 2. validateStrategyFit allowed-set 100% on synthetic-aligned (50/50)
 *
 * Gate (1) measures rule-based classifier quality on hand-labeled data.
 * Gate (2) measures validator correctness — each `claire_reply` is hand-
 * crafted so its inferred strategy MUST be in the (uxState ∩ stage)
 * allowed-set; if not, the validator (or the hand label) is wrong.
 *
 * Plus per-state accuracy breakdown logged for diagnostic visibility.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { readFileSync } from "node:fs"

import { classifyUxState } from "./ux-state-classifier.js"
import { allowedStrategies, stageForTurn } from "./transitions.js"
import { validateStrategyFit } from "./validators.js"

import type { Stage, Strategy, UxState } from "./types.js"

interface Fixture {
  id: string
  lang: "zh" | "en" | "mixed"
  user_text: string
  expected_ux_state: UxState
  turn_number: number
  claire_reply: string
  expected_strategy: Strategy
  expected_stage: Stage
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FIXTURES_PATH = path.join(__dirname, "__fixtures__/labeled-fixtures.json")

const FIXTURES: Fixture[] = JSON.parse(readFileSync(FIXTURES_PATH, "utf8"))

// ---------------------------------------------------------------------------
// Sanity — fixture file shape
// ---------------------------------------------------------------------------

test("fixtures — total count = 50", () => {
  assert.equal(FIXTURES.length, 50)
})

test("fixtures — bilingual breakdown ≥ 25 zh / 20 en / 5 mixed", () => {
  const byLang: Record<string, number> = {}
  for (const f of FIXTURES) byLang[f.lang] = (byLang[f.lang] ?? 0) + 1
  assert.ok(byLang.zh >= 25, `zh count: ${byLang.zh}`)
  assert.ok(byLang.en >= 20, `en count: ${byLang.en}`)
  assert.ok(byLang.mixed >= 5, `mixed count: ${byLang.mixed}`)
})

test("fixtures — ≥ 8 per UX state coverage", () => {
  const byUx: Record<string, number> = {}
  for (const f of FIXTURES) byUx[f.expected_ux_state] = (byUx[f.expected_ux_state] ?? 0) + 1
  for (const ux of [
    "WarmCurious",
    "PlayfulTease",
    "SoftConcerned",
    "FirmDirect",
    "QuietWitness",
  ]) {
    assert.ok((byUx[ux] ?? 0) >= 8, `${ux} count: ${byUx[ux]}`)
  }
})

test("fixtures — every entry has all required fields", () => {
  for (const f of FIXTURES) {
    assert.ok(typeof f.id === "string" && f.id.length > 0)
    assert.ok(["zh", "en", "mixed"].includes(f.lang))
    assert.ok(typeof f.user_text === "string" && f.user_text.length > 0)
    assert.ok(
      [
        "WarmCurious",
        "PlayfulTease",
        "SoftConcerned",
        "FirmDirect",
        "QuietWitness",
      ].includes(f.expected_ux_state)
    )
    assert.ok(typeof f.turn_number === "number" && f.turn_number > 0)
    assert.ok(typeof f.claire_reply === "string" && f.claire_reply.length > 0)
    assert.ok(typeof f.expected_strategy === "string")
    assert.ok(["Exploration", "Comforting", "Action"].includes(f.expected_stage))
  }
})

// ---------------------------------------------------------------------------
// Gate 1 — ux_state classifier accuracy ≥ 70% (35/50)
// ---------------------------------------------------------------------------

test("GATE 1 — ux_state classifier accuracy ≥ 70% on 50 labeled fixtures", () => {
  let hits = 0
  const misses: { id: string; expected: UxState; got: UxState }[] = []
  const perState: Record<string, { hit: number; total: number }> = {}

  for (const f of FIXTURES) {
    const r = classifyUxState({ user: f.user_text })
    perState[f.expected_ux_state] ??= { hit: 0, total: 0 }
    perState[f.expected_ux_state].total += 1
    if (r.uxState === f.expected_ux_state) {
      hits += 1
      perState[f.expected_ux_state].hit += 1
    } else {
      misses.push({ id: f.id, expected: f.expected_ux_state, got: r.uxState })
    }
  }

  const accuracy = hits / FIXTURES.length
  console.log(
    `[GATE 1] ux_state accuracy: ${(accuracy * 100).toFixed(1)}% (${hits}/${FIXTURES.length})`
  )
  console.log(`[GATE 1] per-state breakdown:`, perState)
  if (misses.length > 0) {
    console.log(`[GATE 1] misses (first 10):`, misses.slice(0, 10))
  }

  assert.ok(
    accuracy >= 0.7,
    `ux_state accuracy ${(accuracy * 100).toFixed(1)}% < 70% gate`
  )
})

// ---------------------------------------------------------------------------
// Gate 2 — validateStrategyFit allowed-set 100% on synthetic-aligned
// ---------------------------------------------------------------------------

test("GATE 2 — validateStrategyFit allowed-set 100% on synthetic-aligned (50/50)", () => {
  let pass = 0
  const fails: {
    id: string
    expected_strategy: Strategy
    inferred_strategy: Strategy
    allowed_set: Strategy[]
  }[] = []

  for (const f of FIXTURES) {
    const stageIdx = stageForTurn(f.turn_number)
    const allowed = allowedStrategies(stageIdx, f.expected_ux_state)
    const fit = validateStrategyFit(f.claire_reply, allowed)
    if (fit.allowed) {
      pass += 1
    } else {
      fails.push({
        id: f.id,
        expected_strategy: f.expected_strategy,
        inferred_strategy: fit.strategy,
        allowed_set: Array.from(allowed),
      })
    }
  }

  console.log(
    `[GATE 2] validateStrategyFit allowed-set: ${pass}/${FIXTURES.length} = ${
      (pass / FIXTURES.length) * 100
    }%`
  )
  if (fails.length > 0) {
    console.log(`[GATE 2] fails:`, fails)
  }

  assert.equal(
    pass,
    FIXTURES.length,
    `validator allowed-set hit rate ${pass}/${FIXTURES.length} != 100%`
  )
})

// ---------------------------------------------------------------------------
// Gate 2b — inferred strategy matches expected strategy on synthetic-aligned
// (Stronger sanity check — every claire_reply was hand-crafted to inferStrategy
// to match expected_strategy. Drift here = labeling bug or keyword drift.)
// ---------------------------------------------------------------------------

test("GATE 2b — inferStrategy returns expected_strategy on synthetic-aligned", () => {
  let pass = 0
  const fails: { id: string; expected: Strategy; got: Strategy; reply: string }[] = []
  for (const f of FIXTURES) {
    const stageIdx = stageForTurn(f.turn_number)
    const allowed = allowedStrategies(stageIdx, f.expected_ux_state)
    const fit = validateStrategyFit(f.claire_reply, allowed)
    if (fit.strategy === f.expected_strategy) {
      pass += 1
    } else {
      fails.push({
        id: f.id,
        expected: f.expected_strategy,
        got: fit.strategy,
        reply: f.claire_reply,
      })
    }
  }
  console.log(
    `[GATE 2b] inferStrategy match expected: ${pass}/${FIXTURES.length} = ${
      ((pass / FIXTURES.length) * 100).toFixed(1)
    }%`
  )
  if (fails.length > 0) {
    console.log(`[GATE 2b] strategy mismatches:`, fails)
  }
  // 90% — Phase 33 keyword classifier has known fallbacks (Information / Other)
  // that may swallow specific tokens. Hard 100% would require zero overlap;
  // 90% gives slack for legitimate Affirmation→Reflection close-calls.
  const matchRate = pass / FIXTURES.length
  assert.ok(
    matchRate >= 0.9,
    `expected ≥ 90% match rate, got ${(matchRate * 100).toFixed(1)}%`
  )
})
