/**
 * location-salary-gate.test.ts — the one conditional pre-match ask (canonical Step 4).
 * Ask ONLY when BOTH location and salary are missing AND never asked. Run:
 *   node --import tsx --test apps/functions/src/claire-agent/reducers/location-salary-gate.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { needsLocationSalaryAsk, LOCATION_SALARY_ASKED_AT } from "./location-salary-gate.js"

test("asks when BOTH location and salary missing + never asked", () => {
  assert.equal(needsLocationSalaryAsk({ tags: {} }), true)
  assert.equal(needsLocationSalaryAsk({ tags: { skills: ["ts"] } }), true)
  assert.equal(needsLocationSalaryAsk({}), true)
})

test("SKIPS when location present (never re-ask known facts)", () => {
  assert.equal(needsLocationSalaryAsk({ tags: { targetLocations: ["new_york"] } }), false)
})

test("SKIPS when salary present", () => {
  assert.equal(needsLocationSalaryAsk({ tags: { minSalary: 140000 } }), false)
})

test("SKIPS when either present (only-if-BOTH-missing)", () => {
  assert.equal(needsLocationSalaryAsk({ tags: { targetLocations: ["remote"], minSalary: 0 } }), false)
})

test("SKIPS once already asked (once-only stamp)", () => {
  assert.equal(needsLocationSalaryAsk({ tags: {}, [LOCATION_SALARY_ASKED_AT]: "2026-06-03T00:00:00Z" }), false)
})

test("empty/whitespace location does NOT count as present", () => {
  assert.equal(needsLocationSalaryAsk({ tags: { targetLocations: ["", "  "] } }), true)
})

test("salary of 0 or negative does NOT count as present", () => {
  assert.equal(needsLocationSalaryAsk({ tags: { minSalary: 0 } }), true)
  assert.equal(needsLocationSalaryAsk({ tags: { minSalary: -1 } }), true)
})
