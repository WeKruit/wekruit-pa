/**
 * prescreen-drift-detector — decideDriftAlert gate (pure).
 * The drift-rate computation is LLM-driven (not unit-testable without a live
 * judge), but the alert decision is pure and locks the 5%/15% thresholds.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { decideDriftAlert } from "../prescreen-drift-detector.js"

describe("decideDriftAlert", () => {
  it("no alert at/under 5%", () => {
    assert.deepEqual(decideDriftAlert(0), { shouldAlert: false, level: "warn" })
    assert.deepEqual(decideDriftAlert(0.05), { shouldAlert: false, level: "warn" })
  })
  it("warn above 5%", () => {
    const d = decideDriftAlert(0.08)
    assert.equal(d.shouldAlert, true)
    assert.equal(d.level, "warn")
  })
  it("escalates to error above 15%", () => {
    const d = decideDriftAlert(0.2)
    assert.equal(d.shouldAlert, true)
    assert.equal(d.level, "error")
  })
})
