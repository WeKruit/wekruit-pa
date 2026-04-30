/**
 * Phase 36 T4 — A/B harness unit tests for stat-sig helpers.
 *
 * Verifies:
 *   1. bootstrap95CI returns sensible bounds on known data
 *   2. bootstrap95CI degenerate inputs (empty, single sample)
 *   3. pickWinner — clean win, clean loss, tie
 */
import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { bootstrap95CI, pickWinner } from "./ab-injector-harness.mjs"

describe("Phase 36 T4 — bootstrap95CI", () => {
  test("constant samples → CI lo == hi == mean", () => {
    const ci = bootstrap95CI([0.5, 0.5, 0.5, 0.5, 0.5], 1000)
    assert.equal(ci.mean, 0.5)
    assert.equal(ci.lo, 0.5)
    assert.equal(ci.hi, 0.5)
    assert.equal(ci.n, 5)
  })

  test("varied samples → mean ~= average; lo < mean < hi", () => {
    const samples = [0, 0, 0, 1, 1] // mean 0.4
    const ci = bootstrap95CI(samples, 2000)
    assert.ok(Math.abs(ci.mean - 0.4) < 1e-9)
    assert.ok(ci.lo < ci.mean)
    assert.ok(ci.hi > ci.mean)
    assert.ok(ci.lo >= 0)
    assert.ok(ci.hi <= 1)
  })

  test("empty samples → all zeros", () => {
    const ci = bootstrap95CI([], 100)
    assert.equal(ci.lo, 0)
    assert.equal(ci.mean, 0)
    assert.equal(ci.hi, 0)
    assert.equal(ci.n, 0)
  })

  test("single sample → CI collapses to that value", () => {
    const ci = bootstrap95CI([0.7], 500)
    assert.equal(ci.mean, 0.7)
    assert.equal(ci.lo, 0.7)
    assert.equal(ci.hi, 0.7)
  })

  test("widely spread samples → wider CI", () => {
    const tight = bootstrap95CI([0.5, 0.5, 0.5, 0.5, 0.5], 1000)
    const wide = bootstrap95CI([0, 0.25, 0.5, 0.75, 1.0], 1000)
    assert.equal(tight.hi - tight.lo, 0)
    assert.ok(wide.hi - wide.lo > 0.1, "wide samples should give wider CI")
  })
})

describe("Phase 36 T4 — pickWinner", () => {
  test("clean win for low: low.lo > off.hi", () => {
    const arms = {
      off: { lo: 0.0, mean: 0.05, hi: 0.1, n: 10 },
      low: { lo: 0.2, mean: 0.3, hi: 0.4, n: 10 },
      high: { lo: 0.05, mean: 0.1, hi: 0.15, n: 10 },
    }
    assert.equal(pickWinner(arms), "low")
  })

  test("clean win for high: only high.lo > off.hi", () => {
    const arms = {
      off: { lo: 0.0, mean: 0.05, hi: 0.1, n: 10 },
      low: { lo: 0.05, mean: 0.08, hi: 0.12, n: 10 },
      high: { lo: 0.15, mean: 0.25, hi: 0.35, n: 10 },
    }
    assert.equal(pickWinner(arms), "high")
  })

  test("both beat control → higher mean wins", () => {
    const arms = {
      off: { lo: 0.0, mean: 0.05, hi: 0.1, n: 10 },
      low: { lo: 0.15, mean: 0.2, hi: 0.25, n: 10 },
      high: { lo: 0.15, mean: 0.4, hi: 0.45, n: 10 },
    }
    assert.equal(pickWinner(arms), "high")
  })

  test("control beats both treatments → off wins", () => {
    const arms = {
      off: { lo: 0.5, mean: 0.6, hi: 0.7, n: 10 },
      low: { lo: 0.0, mean: 0.1, hi: 0.2, n: 10 },
      high: { lo: 0.0, mean: 0.15, hi: 0.3, n: 10 },
    }
    assert.equal(pickWinner(arms), "off")
  })

  test("overlapping CIs → tie", () => {
    const arms = {
      off: { lo: 0.0, mean: 0.1, hi: 0.2, n: 10 },
      low: { lo: 0.05, mean: 0.15, hi: 0.25, n: 10 },
      high: { lo: 0.05, mean: 0.2, hi: 0.3, n: 10 },
    }
    assert.equal(pickWinner(arms), "tie")
  })
})
