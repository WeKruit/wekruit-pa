import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { computeTypingDwellMs } from "../typing-indicator.js"

describe("computeTypingDwellMs", () => {
  // ---- Band 1: ≤30 chars → 1000ms ----------------------------------------
  it("returns 1000 for 0 chars (empty reply)", () => {
    assert.equal(computeTypingDwellMs(0), 1000)
  })

  it("returns 1000 for 15 chars (mid band 1)", () => {
    assert.equal(computeTypingDwellMs(15), 1000)
  })

  it("returns 1000 for 30 chars (upper boundary, inclusive)", () => {
    assert.equal(computeTypingDwellMs(30), 1000)
  })

  // ---- Band 2: 31-100 chars → 2000ms -------------------------------------
  it("returns 2000 for 31 chars (lower boundary of band 2)", () => {
    assert.equal(computeTypingDwellMs(31), 2000)
  })

  it("returns 2000 for 75 chars (mid band 2)", () => {
    assert.equal(computeTypingDwellMs(75), 2000)
  })

  it("returns 2000 for 100 chars (upper boundary, inclusive)", () => {
    assert.equal(computeTypingDwellMs(100), 2000)
  })

  // ---- Band 3: 101-200 chars → 3000ms ------------------------------------
  it("returns 3000 for 101 chars (lower boundary of band 3)", () => {
    assert.equal(computeTypingDwellMs(101), 3000)
  })

  it("returns 3000 for 150 chars (mid band 3)", () => {
    assert.equal(computeTypingDwellMs(150), 3000)
  })

  it("returns 3000 for 200 chars (upper boundary, inclusive)", () => {
    assert.equal(computeTypingDwellMs(200), 3000)
  })

  // ---- Band 4: >200 chars → 4000ms ---------------------------------------
  it("returns 4000 for 201 chars (lower boundary of band 4)", () => {
    assert.equal(computeTypingDwellMs(201), 4000)
  })

  it("returns 4000 for 500 chars (long technical reply)", () => {
    assert.equal(computeTypingDwellMs(500), 4000)
  })

  // ---- Edge cases --------------------------------------------------------
  it("returns 1000 for -1 (negative input → minimum tier)", () => {
    assert.equal(computeTypingDwellMs(-1), 1000)
  })
})
