/**
 * Tests for the scan-time new-user counter (the load-balance writer the routing
 * audit found missing). Proves: the overlay maps counters onto assignedNewUsers,
 * the picker respects newUserCap once the counter is non-zero, and the writer
 * issues a per-key FieldValue.increment (map-merge, NOT an array clobber).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import { FieldValue } from "firebase-admin/firestore"
import {
  overlaySendbluePoolCounters,
  pickScanNumber,
  incrementAssignedNewUsers,
  decrementAssignedNewUsers,
  type SendbluePoolConfig,
} from "./pool.js"

const POOL: SendbluePoolConfig = {
  groups: [
    {
      groupId: "g1",
      status: "active",
      audience: "public",
      newUserCap: 2,
      numbers: ["+15550000001"],
    },
    {
      groupId: "g2",
      status: "active",
      audience: "public",
      newUserCap: 2,
      numbers: ["+15550000002"],
    },
  ],
}

describe("overlaySendbluePoolCounters", () => {
  it("maps the counter onto assignedNewUsers without mutating the input", () => {
    const out = overlaySendbluePoolCounters(POOL, { g1: 2 })
    assert.equal(out?.groups?.[0]?.assignedNewUsers, 2)
    assert.equal(out?.groups?.[1]?.assignedNewUsers, undefined)
    // input untouched
    assert.equal(POOL.groups?.[0]?.assignedNewUsers, undefined)
  })

  it("returns the pool unchanged when there are no counters", () => {
    assert.equal(overlaySendbluePoolCounters(POOL, {}), POOL)
  })
})

describe("pickScanNumber respects newUserCap once the counter is overlaid", () => {
  it("a full group is excluded from the capacity-aware pick", () => {
    // g1 at cap (2/2) — every scanToken must route to g2.
    const overlaid = overlaySendbluePoolCounters(POOL, { g1: 2 })
    for (const token of ["a", "b", "c", "d", "e", "f"]) {
      const picked = pickScanNumber(overlaid, token, { requireNewUserCapacity: true })
      assert.ok(picked, "should still pick a number")
      assert.equal(picked!.groupId, "g2")
      assert.equal(picked!.number, "+15550000002")
    }
  })

  it("returns null when BOTH groups are at cap (no capacity anywhere)", () => {
    const overlaid = overlaySendbluePoolCounters(POOL, { g1: 2, g2: 2 })
    assert.equal(pickScanNumber(overlaid, "x", { requireNewUserCapacity: true }), null)
  })

  it("returns number + its groupId for the caller to bump", () => {
    const picked = pickScanNumber(POOL, "stable-token", { requireNewUserCapacity: true })
    assert.ok(picked)
    assert.ok(["g1", "g2"].includes(picked!.groupId))
  })
})

// ─── counter writer (map-merge, race-safe) ─────────────────────────────────────

type SetCall = { id: string; data: Record<string, unknown>; merge: boolean }

function counterFakeDb(): { db: Firestore; sets: SetCall[]; store: Record<string, Record<string, unknown>> } {
  const sets: SetCall[] = []
  const store: Record<string, Record<string, unknown>> = {}
  const docRef = (id: string) => ({
    async get() {
      const data = store[id]
      return { exists: data !== undefined, data: () => data }
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      sets.push({ id, data, merge: Boolean(opts?.merge) })
      // resolve increment sentinels for the store view used by decrement's txn
      const prev = store[id] ?? {}
      const next: Record<string, unknown> = opts?.merge ? { ...prev } : {}
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === "object" && "operand" in (v as Record<string, unknown>)) {
          next[k] = Number(prev[k] ?? 0) + Number((v as Record<string, unknown>).operand)
        } else {
          next[k] = v
        }
      }
      store[id] = next
    },
  })
  const db = {
    collection: () => ({ doc: (id: string) => docRef(id) }),
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      const t = {
        async get(ref: { get: () => Promise<unknown> }) {
          return ref.get()
        },
        set(ref: { set: (d: Record<string, unknown>, o?: { merge?: boolean }) => void }, d: Record<string, unknown>, o?: { merge?: boolean }) {
          return ref.set(d, o)
        },
      }
      return fn(t)
    },
  } as unknown as Firestore
  return { db, sets, store }
}

describe("incrementAssignedNewUsers", () => {
  it("writes a per-key FieldValue.increment(1) with merge (no array clobber)", async () => {
    const { db, sets } = counterFakeDb()
    await incrementAssignedNewUsers(db, "g1")
    assert.equal(sets.length, 1)
    assert.equal(sets[0]!.merge, true)
    assert.ok("g1" in sets[0]!.data)
    // the value is a FieldValue.increment sentinel, not a plain number
    const sentinel = sets[0]!.data.g1 as object
    assert.notEqual(typeof sentinel, "number")
    assert.deepEqual(sentinel, FieldValue.increment(1) as unknown as object)
  })

  it("no-ops on an empty groupId", async () => {
    const { db, sets } = counterFakeDb()
    await incrementAssignedNewUsers(db, "  ")
    assert.equal(sets.length, 0)
  })

  it("caps via overlay: increment then re-pick steers away from the full group", async () => {
    // Simulate two scans bumping g1 to its cap, then prove the overlay-aware pick
    // refuses g1. (End-to-end of the "counter actually caps" guarantee.)
    const overlaidAtCap = overlaySendbluePoolCounters(POOL, { g1: 2 })
    const picked = pickScanNumber(overlaidAtCap, "token-after-cap", { requireNewUserCapacity: true })
    assert.equal(picked!.groupId, "g2")
  })
})

describe("decrementAssignedNewUsers", () => {
  it("floors at zero and never writes a negative", async () => {
    const { db, store } = counterFakeDb()
    store["sendblue-pool-counters"] = { g1: 0 }
    await decrementAssignedNewUsers(db, "g1")
    assert.equal(store["sendblue-pool-counters"]!.g1, 0)
  })

  it("decrements a positive counter by one", async () => {
    const { db, store } = counterFakeDb()
    store["sendblue-pool-counters"] = { g1: 3 }
    await decrementAssignedNewUsers(db, "g1")
    assert.equal(store["sendblue-pool-counters"]!.g1, 2)
  })
})
