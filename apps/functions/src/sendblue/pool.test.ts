/**
 * v1.9 Phase 88 — pool selector tests.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { hashStringToUint, pickFromNumber } from "./pool.js"

describe("hashStringToUint", () => {
  it("is deterministic", () => {
    assert.equal(hashStringToUint("abc"), hashStringToUint("abc"))
  })
  it("differs for different inputs", () => {
    assert.notEqual(hashStringToUint("abc"), hashStringToUint("def"))
  })
  it("returns uint32", () => {
    const h = hashStringToUint("x")
    assert.ok(h >= 0)
    assert.ok(h <= 0xffffffff)
  })
})

describe("pickFromNumber", () => {
  it("returns null when pool null", () => {
    assert.equal(pickFromNumber(null, "u1"), null)
  })
  it("returns null when pool empty", () => {
    assert.equal(pickFromNumber({ numbers: [] }, "u1"), null)
  })
  it("returns null when all paused", () => {
    assert.equal(
      pickFromNumber({ numbers: [{ number: "+1", status: "paused" }] }, "u1"),
      null
    )
  })
  it("single active number always returns that number", () => {
    assert.equal(
      pickFromNumber({ numbers: [{ number: "+1", status: "active" }] }, "u1"),
      "+1"
    )
    assert.equal(
      pickFromNumber({ numbers: [{ number: "+1", status: "active" }] }, "u2"),
      "+1"
    )
  })
  it("same userId → same number across calls", () => {
    const pool = {
      numbers: [
        { number: "+1", status: "active" as const },
        { number: "+2", status: "active" as const },
        { number: "+3", status: "active" as const },
      ],
    }
    const first = pickFromNumber(pool, "alice")
    const second = pickFromNumber(pool, "alice")
    assert.equal(first, second)
  })
  it("paused numbers filtered out", () => {
    const pool = {
      numbers: [
        { number: "+1", status: "paused" as const },
        { number: "+2", status: "active" as const },
      ],
    }
    assert.equal(pickFromNumber(pool, "anyuser"), "+2")
  })
  it("distributes across multiple users", () => {
    const pool = {
      numbers: [
        { number: "+1", status: "active" as const },
        { number: "+2", status: "active" as const },
      ],
    }
    const picks = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const v = pickFromNumber(pool, `user_${i}`)
      if (v) picks.add(v)
    }
    assert.equal(picks.size, 2)
  })
})
