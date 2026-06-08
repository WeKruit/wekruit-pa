import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"

import {
  planUserPin,
  buildPinPlan,
  runBackfill,
} from "../backfill-sendblue-binding-pin.mjs"
import { pickFromNumber, _resetPoolCache, _resetCountersCache } from "../../src/sendblue/pool.js"

// loadSendbluePool memoizes for 60s — reset between tests so a POOL loaded in
// one runBackfill case can't leak into the "no pool configured" case.
beforeEach(() => {
  _resetPoolCache()
  _resetCountersCache()
})
afterEach(() => {
  _resetPoolCache()
  _resetCountersCache()
})

// Two-number active public pool — the EXACT shape pickFromNumber hashes over.
const POOL = {
  numbers: [
    { number: "+10000000001", status: "active", audience: "public" },
    { number: "+10000000002", status: "active", audience: "public" },
  ],
}

// ─── Fake Firestore for runBackfill ─────────────────────────────────────────
function makeFakeDb(users) {
  const usersMap = new Map(Object.entries(users))
  const writes = []
  return {
    db: {
      collection(name) {
        if (name === "pa-config") {
          return {
            doc(id) {
              return {
                async get() {
                  if (id === "sendblue-pool") return { exists: true, data: () => POOL }
                  return { exists: false, data: () => undefined }
                },
              }
            },
          }
        }
        // pa-users
        return {
          doc(id) {
            return {
              async set(data, opts) {
                writes.push({ id, data })
                if (opts?.merge) usersMap.set(id, { ...(usersMap.get(id) ?? {}), ...data })
                else usersMap.set(id, { ...data })
              },
            }
          },
          limit() {
            return {
              async get() {
                return {
                  docs: [...usersMap.entries()].map(([id, data]) => ({ id, data: () => data })),
                }
              },
            }
          },
        }
      },
    },
    usersMap,
    writes,
  }
}

describe("backfill-sendblue-binding-pin: planUserPin (pure)", () => {
  it("(e) pins the EXACT current live hash result — pickFromNumber(pool, uid) with NO options", () => {
    for (const uid of ["a", "b", "c", "user-xyz", "0", "zzzzz"]) {
      const decision = planUserPin(POOL, uid, {})
      assert.equal(decision.action, "pin")
      // The pin MUST equal the live send-path pick (no options) byte-for-byte.
      assert.equal(decision.senderNumber, pickFromNumber(POOL, uid))
      assert.ok(decision.senderGroupId)
    }
  })

  it("is idempotent — a user already bound is skipped (never re-pinned)", () => {
    const decision = planUserPin(POOL, "a", { senderNumber: "+19998887777" })
    assert.equal(decision.action, "skip_already_bound")
    assert.equal(decision.senderNumber, "+19998887777")
  })

  it("unroutable user (no eligible line today) is left unpinned", () => {
    const ADMIN_ONLY = { numbers: [{ number: "+1admin", status: "active", audience: "admin", adminOnly: true }] }
    const decision = planUserPin(ADMIN_ONLY, "a", {})
    assert.equal(decision.action, "skip_unroutable")
  })
})

describe("backfill-sendblue-binding-pin: buildPinPlan", () => {
  it("partitions users into pin / already-bound / unroutable", () => {
    const plan = buildPinPlan(POOL, [
      { uid: "a" },
      { uid: "b", senderNumber: "+15550001111" },
      { uid: "c" },
    ])
    assert.equal(plan.pin.length, 2)
    assert.equal(plan.skipAlreadyBound.length, 1)
    assert.equal(plan.skipAlreadyBound[0].uid, "b")
    assert.equal(plan.skipUnroutable.length, 0)
  })
})

describe("backfill-sendblue-binding-pin: runBackfill", () => {
  it("DRY-RUN (default) writes NOTHING but reports the plan", async () => {
    const { db, writes } = makeFakeDb({ a: {}, b: { senderNumber: "+15550001111" }, c: {} })
    const report = await runBackfill(db, { apply: false })
    assert.equal(report.apply, false)
    assert.equal(report.poolConfigured, true)
    assert.equal(report.scanned, 3)
    assert.equal(report.plan.pin.length, 2)
    assert.equal(report.wrote, 0)
    assert.equal(writes.length, 0, "DRY-RUN must not write")
  })

  it("--apply writes the pins and is idempotent on re-run", async () => {
    const fake = makeFakeDb({ a: {}, b: { senderNumber: "+15550001111" }, c: {} })
    const report1 = await runBackfill(fake.db, { apply: true, nowIso: "2026-06-02T00:00:00Z" })
    assert.equal(report1.wrote, 2)
    // a + c now pinned to their live hash line; b untouched.
    assert.equal(fake.usersMap.get("a").senderNumber, pickFromNumber(POOL, "a"))
    assert.equal(fake.usersMap.get("a").senderAssignedSource, "backfill_pin_2026_06")
    assert.equal(fake.usersMap.get("c").senderNumber, pickFromNumber(POOL, "c"))
    assert.equal(fake.usersMap.get("b").senderNumber, "+15550001111", "already-bound user is untouched")

    // Re-run → nothing left to pin (idempotent).
    const report2 = await runBackfill(fake.db, { apply: true, nowIso: "2026-06-02T01:00:00Z" })
    assert.equal(report2.plan.pin.length, 0)
    assert.equal(report2.wrote, 0)
  })

  it("no pool configured → reports poolConfigured:false and writes nothing", async () => {
    const db = {
      collection(name) {
        if (name === "pa-config") {
          return { doc() { return { async get() { return { exists: false, data: () => undefined } } } } }
        }
        return { limit() { return { async get() { return { docs: [] } } } } }
      },
    }
    const report = await runBackfill(db, { apply: true })
    assert.equal(report.poolConfigured, false)
    assert.equal(report.wrote, 0)
  })
})
