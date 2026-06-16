import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { rollup, type OpsMetricsDayBucket } from "../../lib/operations-overview-rollup.js"

function day(date: string, n: number): OpsMetricsDayBucket {
  return {
    date,
    newUsersTotal: n,
    newUsersAuthenticated: n,
    newUsersRecruiterSubmitted: 0,
    newUsersDirect: 0,
    interviewsConducted: n,
    movedToClient: 0,
  }
}

// 14 consecutive days, value = 1 each.
const DAYS: OpsMetricsDayBucket[] = Array.from({ length: 14 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10)
  return day(d, 1)
})

describe("rollup", () => {
  it("daily passes through one bucket per day", () => {
    const out = rollup(DAYS, "daily")
    assert.equal(out.length, 14)
    assert.equal(out[0]!.newUsersTotal, 1)
  })

  it("weekly groups into 7-day windows summing values", () => {
    const out = rollup(DAYS, "weekly")
    assert.equal(out.length, 2)
    assert.equal(out[0]!.newUsersTotal, 7)
    assert.equal(out[0]!.interviewsConducted, 7)
    assert.match(out[0]!.label, /–/) // ranged label
  })

  it("biweekly groups into 14-day windows", () => {
    const out = rollup(DAYS, "biweekly")
    assert.equal(out.length, 1)
    assert.equal(out[0]!.newUsersTotal, 14)
  })

  it("monthly groups by calendar month", () => {
    const out = rollup(DAYS, "monthly")
    assert.equal(out.length, 1) // all June
    assert.equal(out[0]!.newUsersTotal, 14)
    assert.match(out[0]!.label, /Jun 2026/)
  })

  it("returns empty for empty input", () => {
    assert.deepEqual(rollup([], "weekly"), [])
  })

  it("preserves total across granularities (sum invariant)", () => {
    const sum = (xs: { newUsersTotal: number }[]) => xs.reduce((a, b) => a + b.newUsersTotal, 0)
    const base = sum(rollup(DAYS, "daily"))
    for (const g of ["weekly", "biweekly", "monthly"] as const) {
      assert.equal(sum(rollup(DAYS, g)), base)
    }
  })
})
