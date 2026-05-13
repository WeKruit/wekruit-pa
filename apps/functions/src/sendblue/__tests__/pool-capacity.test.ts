import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  selectSendblueCapacityGroup,
  type SendbluePoolConfig,
} from "../pool.js"

const checkedAt = "2026-05-13T12:00:00.000Z"

function select(
  pool: SendbluePoolConfig,
  over: Partial<Parameters<typeof selectSendblueCapacityGroup>[1]> = {}
) {
  return selectSendblueCapacityGroup(pool, {
    candidateId: "cand-1",
    checkedAt,
    utilization: {},
    ...over,
  })
}

describe("selectSendblueCapacityGroup", () => {
  it("selects an active group below daily cap", () => {
    const result = select({
      numbers: [{ groupId: "g1", number: "+15555550100", status: "active", capacity: 10 }],
    })

    assert.equal(result.ok, true)
    assert.equal(result.groupId, "g1")
    assert.equal(result.fromNumber, "+15555550100")
    assert.equal(result.capacitySnapshot.remainingToday, 10)
  })

  it("does not select full groups for new candidates", () => {
    const result = select(
      {
        numbers: [{ groupId: "g1", number: "+15555550100", status: "active", capacity: 2 }],
      },
      { utilization: { g1: { usedToday: 2 } } }
    )

    assert.equal(result.ok, false)
    assert.equal(result.reason, "channel_capacity")
    assert.equal(result.capacitySnapshot.remainingToday, 0)
  })

  it("filters paused throttled and degraded groups", () => {
    const result = select({
      numbers: [
        { groupId: "paused", number: "+1", status: "paused", capacity: 10 },
        { groupId: "throttled", number: "+2", status: "throttled", capacity: 10 },
        { groupId: "degraded", number: "+3", status: "degraded", capacity: 10 },
      ],
    })

    assert.equal(result.ok, false)
    assert.equal(result.reason, "no_routable_group")
  })

  it("requires explicit warmup allowance", () => {
    const blocked = select({
      numbers: [{ groupId: "warm", number: "+1", status: "warmup", capacity: 10 }],
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.reason, "warmup_requires_hitl")

    const allowed = select(
      { numbers: [{ groupId: "warm", number: "+1", status: "warmup", capacity: 10 }] },
      { allowWarmup: true }
    )
    assert.equal(allowed.ok, true)
    assert.equal(allowed.groupId, "warm")
  })

  it("preserves sticky assignment when routable and below cap", () => {
    const result = select(
      {
        numbers: [
          { groupId: "g1", number: "+1", status: "active", capacity: 10 },
          { groupId: "g2", number: "+2", status: "active", capacity: 10 },
        ],
      },
      { stickyAccountGroupId: "g2", utilization: { g2: { usedToday: 9 } } }
    )

    assert.equal(result.ok, true)
    assert.equal(result.groupId, "g2")
    assert.equal(result.capacitySnapshot.remainingToday, 1)
  })

  it("blocks sticky assignment when full instead of silently reassigning", () => {
    const result = select(
      {
        numbers: [
          { groupId: "g1", number: "+1", status: "active", capacity: 10 },
          { groupId: "g2", number: "+2", status: "active", capacity: 1 },
        ],
      },
      { stickyAccountGroupId: "g2", utilization: { g2: { usedToday: 1 } } }
    )

    assert.equal(result.ok, false)
    assert.equal(result.reason, "sticky_group_capacity")
    assert.equal(result.groupId, "g2")
  })

  it("blocks missing capacity rather than treating it as unlimited", () => {
    const result = select({
      numbers: [{ groupId: "g1", number: "+15555550100", status: "active" }],
    })

    assert.equal(result.ok, false)
    assert.equal(result.reason, "missing_capacity")
    assert.equal(result.capacitySnapshot.dailyCap, 0)
  })
})
