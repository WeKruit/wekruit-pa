/**
 * v1.9 Phase 88 — pool routing integration test.
 *
 * Verifies the production 2-number pool config:
 *   +13054507716 (active, cap 10)
 *   +14243201960 (active, cap 10)
 *
 * Asserts:
 *   - hash-by-userId distributes both numbers receive traffic
 *   - same userId → same number every call (sticky / thread continuity)
 *   - paused numbers never routed to
 *   - empty pool returns null (caller falls back to env SENDBLUE_FROM_NUMBER)
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { pickFromNumber, type SendbluePoolConfig } from "./pool.js"

const PROD_POOL: SendbluePoolConfig = {
  numbers: [
    { number: "+13054507716", status: "active", capacity: 10 },
    { number: "+14243201960", status: "active", capacity: 10 },
  ],
}

describe("production pool routing (P88 integration)", () => {
  it("distributes 100 users across both numbers", () => {
    const counts = new Map<string, number>()
    for (let i = 0; i < 100; i++) {
      const n = pickFromNumber(PROD_POOL, `userid_${i}`)
      counts.set(n!, (counts.get(n!) ?? 0) + 1)
    }
    assert.equal(counts.size, 2, "both pool numbers must receive traffic")
    for (const [num, count] of counts) {
      // djb2 hash mod 2 is not perfectly 50/50; assert each gets at least 25
      // out of 100 so we catch hash bias regressions.
      assert.ok(count >= 25, `${num} received only ${count}/100 — distribution bias`)
    }
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
        { number: "+13054507716", status: "active", capacity: 10 },
        { number: "+14243201960", status: "paused", capacity: 10 },
      ],
    }
    for (let i = 0; i < 50; i++) {
      assert.equal(pickFromNumber(paused, `u${i}`), "+13054507716")
    }
  })

  it("empty pool returns null (caller env fallback)", () => {
    assert.equal(pickFromNumber({ numbers: [] }, "anyone"), null)
    assert.equal(pickFromNumber(null, "anyone"), null)
  })

  it("re-adding a paused number resumes routing to it", () => {
    const before: SendbluePoolConfig = {
      numbers: [
        { number: "+13054507716", status: "active", capacity: 10 },
        { number: "+14243201960", status: "paused", capacity: 10 },
      ],
    }
    const after: SendbluePoolConfig = {
      numbers: [
        { number: "+13054507716", status: "active", capacity: 10 },
        { number: "+14243201960", status: "active", capacity: 10 },
      ],
    }
    // pre-flip: everyone goes to 305
    for (let i = 0; i < 20; i++) {
      assert.equal(pickFromNumber(before, `u${i}`), "+13054507716")
    }
    // post-flip: ~half route to 424
    const postCounts = new Map<string, number>()
    for (let i = 0; i < 20; i++) {
      const n = pickFromNumber(after, `u${i}`)
      postCounts.set(n!, (postCounts.get(n!) ?? 0) + 1)
    }
    assert.ok((postCounts.get("+14243201960") ?? 0) >= 5, "424 receives traffic after activation")
  })
})
