/**
 * v1.9 Phase 88 — pool selector tests.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  computeSendblueCapacitySnapshot,
  hashStringToUint,
  normalizeSendbluePoolGroups,
  pickFromNumber,
  selectCapacityAwareFromNumber,
  selectLeastLoadedAssignmentNumber,
} from "./pool.js"

describe("selectLeastLoadedAssignmentNumber", () => {
  const stat = (number: string, totalAttached: number) => ({ number, totalAttached })

  it("routes a new candidate to the least-loaded number (drains skew)", () => {
    assert.equal(selectLeastLoadedAssignmentNumber([stat("+A", 545), stat("+B", 33)]), "+B")
  })

  it("keeps routing to the under-loaded number until it catches up", () => {
    // +B was just added; everything flows to it until it reaches +A's count.
    assert.equal(selectLeastLoadedAssignmentNumber([stat("+A", 545), stat("+B", 544)]), "+B")
    assert.equal(selectLeastLoadedAssignmentNumber([stat("+A", 545), stat("+B", 545)]), "+A") // tie → stable by number
  })

  it("tiebreaks equal total stably by number", () => {
    assert.equal(selectLeastLoadedAssignmentNumber([stat("+B", 100), stat("+A", 100)]), "+A")
  })

  it("empty pool → null", () => {
    assert.equal(selectLeastLoadedAssignmentNumber([]), null)
  })
})

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
  it("excludes admin and internal numbers from user-facing routing by default", () => {
    const pool = {
      numbers: [
        { number: "+13054507715", status: "active" as const, audience: "admin" as const, adminOnly: true },
        { number: "+15550001111", status: "active" as const, audience: "internal" as const },
        { number: "+17174919939", status: "active" as const, audience: "public" as const },
      ],
    }
    for (let i = 0; i < 20; i++) {
      assert.equal(pickFromNumber(pool, `user_${i}`), "+17174919939")
    }
  })
  it("can include internal numbers only when explicitly requested", () => {
    const pool = {
      numbers: [
        { number: "+13054507715", status: "active" as const, audience: "admin" as const, adminOnly: true },
      ],
    }
    assert.equal(pickFromNumber(pool, "admin-user"), null)
    assert.equal(pickFromNumber(pool, "admin-user", { includeInternal: true }), "+13054507715")
  })
  it("honors new-user caps when requested", () => {
    const pool = {
      numbers: [
        {
          number: "+17174919939",
          status: "active" as const,
          audience: "public" as const,
          newUserCap: 200,
          assignedNewUsers: 200,
        },
        {
          number: "+15550002222",
          status: "active" as const,
          audience: "public" as const,
          newUserCap: 200,
          assignedNewUsers: 199,
        },
      ],
    }
    assert.equal(pickFromNumber(pool, "new-user", { requireNewUserCapacity: true }), "+15550002222")
  })
  it("selects from grouped public pool config", () => {
    const pool = {
      groups: [
        {
          groupId: "public-a",
          status: "active" as const,
          audience: "public" as const,
          numbers: ["+17174919939"],
        },
      ],
    }
    assert.equal(pickFromNumber(pool, "new-user", { requireNewUserCapacity: true }), "+17174919939")
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

describe("normalizeSendbluePoolGroups", () => {
  it("normalizes legacy number configs into one group per number", () => {
    const groups = normalizeSendbluePoolGroups({
      numbers: [{ number: "+13054507716", status: "active", capacity: 10 }],
    })
    assert.deepEqual(groups, [
      {
        groupId: "+13054507716",
        status: "active",
        dailySendCap: 10,
        numbers: ["+13054507716"],
      },
    ])
  })

  it("normalizes grouped configs with dailySendCap", () => {
    const groups = normalizeSendbluePoolGroups({
      groups: [
        {
          groupId: "primary",
          status: "active",
          dailySendCap: 25,
          numbers: ["+1", { number: "+2", status: "active" }],
        },
      ],
    })
    assert.deepEqual(groups, [
      {
        groupId: "primary",
        status: "active",
        dailySendCap: 25,
        numbers: ["+1", "+2"],
      },
    ])
  })
})

describe("computeSendblueCapacitySnapshot", () => {
  it("computes remaining daily capacity", () => {
    const snapshot = computeSendblueCapacitySnapshot({
      group: {
        groupId: "primary",
        status: "active",
        dailySendCap: 3,
        numbers: ["+1"],
      },
      usedToday: 2,
      fromNumber: "+1",
      checkedAt: new Date("2026-05-13T12:00:00Z"),
    })
    assert.deepEqual(snapshot, {
      groupId: "primary",
      fromNumber: "+1",
      status: "active",
      dailyCap: 3,
      usedToday: 2,
      remainingToday: 1,
      checkedAt: "2026-05-13T12:00:00.000Z",
    })
  })
})

describe("selectCapacityAwareFromNumber", () => {
  it("selects from legacy active pool when capacity remains", () => {
    const result = selectCapacityAwareFromNumber(
      { numbers: [{ number: "+1", status: "active", capacity: 10 }] },
      "u1",
      { checkedAt: new Date("2026-05-13T12:00:00Z") }
    )
    assert.equal(result.ok, true)
    assert.equal(result.groupId, "+1")
    assert.equal(result.fromNumber, "+1")
    assert.equal(result.capacitySnapshot.remainingToday, 10)
  })

  it("preserves sticky group and does not reroute when that group is full", () => {
    const result = selectCapacityAwareFromNumber(
      {
        groups: [
          { groupId: "sticky", status: "active", dailySendCap: 1, numbers: ["+1"] },
          { groupId: "open", status: "active", dailySendCap: 10, numbers: ["+2"] },
        ],
      },
      "u1",
      {
        stickyGroupId: "sticky",
        usedTodayByGroupId: { sticky: 1, open: 0 },
        checkedAt: new Date("2026-05-13T12:00:00Z"),
      }
    )
    assert.equal(result.ok, false)
    assert.equal(result.groupId, "sticky")
    assert.equal(result.fromNumber, "+1")
    assert.equal(result.reason, "sticky_group_capacity")
    assert.equal(result.capacitySnapshot.remainingToday, 0)
  })

  it("blocks warmup groups from automatic routing", () => {
    const result = selectCapacityAwareFromNumber(
      {
        groups: [
          { groupId: "warm", status: "warmup", dailySendCap: 10, numbers: ["+1"] },
        ],
      },
      "u1",
      { checkedAt: new Date("2026-05-13T12:00:00Z") }
    )
    assert.equal(result.ok, false)
    assert.equal(result.groupId, "warm")
    assert.equal(result.reason, "warmup_requires_hitl")
    assert.equal(result.capacitySnapshot.status, "warmup")
  })

  it("blocks groups with missing capacity", () => {
    const result = selectCapacityAwareFromNumber(
      {
        groups: [{ groupId: "missing-cap", status: "active", numbers: ["+1"] }],
      },
      "u1",
      { checkedAt: new Date("2026-05-13T12:00:00Z") }
    )
    assert.equal(result.ok, false)
    assert.equal(result.reason, "missing_capacity")
  })
})
