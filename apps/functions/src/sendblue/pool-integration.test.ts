/**
 * v1.9 Phase 88 — pool routing integration test.
 *
 * Verifies the DB-driven pool contract:
 *   - admin/internal numbers stay configured but hidden from candidates
 *   - public rollout numbers receive user-facing traffic
 *
 * Asserts:
 *   - public users route only to candidate-accessible numbers
 *   - same userId → same number every call (sticky / thread continuity)
 *   - paused numbers never routed to
 *   - empty pool returns null
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { pickFromNumber, type SendbluePoolConfig } from "./pool.js"

const PROD_POOL: SendbluePoolConfig = {
  numbers: [
    { number: "+13054507715", status: "active", capacity: 10, audience: "admin", adminOnly: true },
    { number: "+17174919939", status: "active", capacity: 200, audience: "public", newUserCap: 200, assignedNewUsers: 0 },
  ],
}

describe("production pool routing (P88 integration)", () => {
  it("routes user-facing traffic only to the public number", () => {
    const counts = new Map<string, number>()
    for (let i = 0; i < 100; i++) {
      const n = pickFromNumber(PROD_POOL, `userid_${i}`)
      counts.set(n!, (counts.get(n!) ?? 0) + 1)
    }
    assert.deepEqual([...counts.entries()], [["+17174919939", 100]])
  })

  it("same userId → same number across 1000 calls (sticky routing)", () => {
    const first = pickFromNumber(PROD_POOL, "alice_e2e")
    for (let i = 0; i < 1000; i++) {
      assert.equal(pickFromNumber(PROD_POOL, "alice_e2e"), first)
    }
  })

  it("paused number filtered out", () => {
    const paused: SendbluePoolConfig = {
      numbers: [
        { number: "+13054507715", status: "active", capacity: 10, audience: "admin", adminOnly: true },
        { number: "+17174919939", status: "paused", capacity: 200, audience: "public" },
      ],
    }
    for (let i = 0; i < 50; i++) {
      assert.equal(pickFromNumber(paused, `u${i}`), null)
    }
  })

  it("empty pool returns null (caller env fallback)", () => {
    assert.equal(pickFromNumber({ numbers: [] }, "anyone"), null)
    assert.equal(pickFromNumber(null, "anyone"), null)
  })

  it("re-adding a paused number resumes routing to it", () => {
    const before: SendbluePoolConfig = {
      numbers: [
        { number: "+13054507715", status: "active", capacity: 10, audience: "admin", adminOnly: true },
        { number: "+17174919939", status: "paused", capacity: 200, audience: "public" },
      ],
    }
    const after: SendbluePoolConfig = {
      numbers: [
        { number: "+13054507715", status: "active", capacity: 10, audience: "admin", adminOnly: true },
        { number: "+17174919939", status: "active", capacity: 200, audience: "public" },
      ],
    }
    // pre-flip: no candidate-visible number
    for (let i = 0; i < 20; i++) {
      assert.equal(pickFromNumber(before, `u${i}`), null)
    }
    // post-flip: users route to the public rollout number
    for (let i = 0; i < 20; i++) {
      assert.equal(pickFromNumber(after, `u${i}`), "+17174919939")
    }
  })
})
