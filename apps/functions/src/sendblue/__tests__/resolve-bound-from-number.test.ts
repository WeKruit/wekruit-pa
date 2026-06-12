import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  resolveBoundFromNumber,
  decideBoundFromNumber,
  isBoundNumberStillSelectable,
} from "../resolve-bound-from-number.js"
import type { SendbluePoolConfig } from "../pool.js"

// ─── Fake Firestore (pa-users only) ─────────────────────────────────────────

type DocData = Record<string, unknown>

function makeFakeDb(users: Record<string, DocData> = {}) {
  const usersMap = new Map<string, DocData>(Object.entries(users))
  const writes: Array<{ id: string; data: DocData }> = []
  const reads: string[] = []
  const db = {
    collection(name: string) {
      assert.equal(name, "pa-users")
      return {
        doc(id: string) {
          return {
            async get() {
              reads.push(id)
              const data = usersMap.get(id)
              return { exists: data !== undefined, data: () => data, id }
            },
            async set(data: DocData, opts?: { merge?: boolean }) {
              writes.push({ id, data })
              if (opts?.merge) usersMap.set(id, { ...(usersMap.get(id) ?? {}), ...data })
              else usersMap.set(id, { ...data })
            },
          }
        },
      }
    },
  }
  return { db, usersMap, writes, reads }
}

// A single-number public pool (status quo before the pool grows).
const POOL_1: SendbluePoolConfig = {
  numbers: [{ number: "+10000000001", status: "active", audience: "public" }],
}
// The SAME pool grown to 2 active public numbers (the reshuffle trigger).
const POOL_2: SendbluePoolConfig = {
  numbers: [
    { number: "+10000000001", status: "active", audience: "public" },
    { number: "+10000000002", status: "active", audience: "public" },
  ],
}

// loadPool stub factory.
const loadPoolStub = (pool: SendbluePoolConfig | null) => async () => pool

describe("resolveBoundFromNumber", () => {
  // (a) A BOUND user's send returns senderNumber even after pool grows 1→2 (NO reshuffle).
  it("(a) bound user is NEVER re-hashed when the pool grows 1→2", async () => {
    // Find a uid whose RAW hash pick FLIPS between POOL_1 and POOL_2, to prove the
    // honor-binding actually prevents a real reshuffle (not a coincidental match).
    const { pickFromNumber } = await import("../pool.js")
    let flippingUid = ""
    for (let i = 0; i < 200; i++) {
      const uid = `u-${i}`
      if (pickFromNumber(POOL_1, uid) !== pickFromNumber(POOL_2, uid)) {
        flippingUid = uid
        break
      }
    }
    assert.ok(flippingUid, "expected at least one uid that reshuffles on pool growth")
    const pinned = pickFromNumber(POOL_1, flippingUid)! // the line bound under the 1-number pool

    const { db, writes } = makeFakeDb({
      [flippingUid]: { senderNumber: pinned, senderGroupId: "g1" },
    })

    // Resolve under the GROWN 2-number pool. The raw hash would flip; the binding must not.
    const out = await resolveBoundFromNumber(db as never, flippingUid, {
      pool: POOL_2,
      user: { senderNumber: pinned, senderGroupId: "g1" },
    })
    assert.equal(out.fromNumber, pinned, "bound user must keep their pinned line after pool growth")
    assert.equal(out.source, "bound")
    assert.equal(out.persisted, false)
    assert.equal(writes.length, 0, "honoring a binding must NOT write")
    assert.notEqual(
      pickFromNumber(POOL_2, flippingUid),
      pinned,
      "sanity: the raw hash WOULD have moved this user (so the test is meaningful)"
    )
  })

  // (b) An UNBOUND user gets capacity-minted + persisted.
  it("(b) unbound user is capacity-minted and persisted with a source tag", async () => {
    const { db, writes, usersMap } = makeFakeDb({ "u-new": {} })
    const out = await resolveBoundFromNumber(db as never, "u-new", {
      pool: POOL_2,
      user: {},
      mintSource: "send_path_mint",
    })
    assert.ok(out.fromNumber, "an unbound user must get a minted line")
    assert.ok([POOL_2.numbers![0].number, POOL_2.numbers![1].number].includes(out.fromNumber!))
    assert.equal(out.source, "send_path_mint")
    assert.equal(out.persisted, true)
    assert.equal(writes.length, 1)
    assert.equal(usersMap.get("u-new")!.senderNumber, out.fromNumber)
    assert.equal(usersMap.get("u-new")!.senderAssignedSource, "send_path_mint")
    assert.ok(usersMap.get("u-new")!.senderAssignedAt)
  })

  // (c) text-only provisional-style mint: no user doc supplied → one read, then mint+persist.
  it("(c) provisional/text-only user (no doc) → one read, then mints+persists 'inbound_first'-style", async () => {
    const { db, reads, writes } = makeFakeDb({ "u-prov": {} })
    const out = await resolveBoundFromNumber(db as never, "u-prov", {
      pool: POOL_2,
      // user OMITTED → reducer does exactly ONE user read
      mintSource: "inbound_first",
    })
    assert.equal(reads.length, 1, "omitting the user doc costs exactly one read")
    assert.ok(out.fromNumber)
    assert.equal(out.source, "inbound_first")
    assert.equal(out.persisted, true)
    assert.equal(writes.length, 1)
  })

  // (d) A user bound to a now-PAUSED number gets rebound.
  it("(d) bound user whose line is now paused → rebind (capacity-mint) + persist 'rebind_paused'", async () => {
    const PAUSED_POOL: SendbluePoolConfig = {
      numbers: [
        { number: "+19999999999", status: "paused", audience: "public" }, // the bound line, now paused
        { number: "+10000000002", status: "active", audience: "public" }, // the only live line
      ],
    }
    const { db, writes, usersMap } = makeFakeDb({
      "u-paused": { senderNumber: "+19999999999", senderGroupId: "gold" },
    })
    const out = await resolveBoundFromNumber(db as never, "u-paused", {
      pool: PAUSED_POOL,
      user: { senderNumber: "+19999999999", senderGroupId: "gold" },
    })
    assert.equal(out.fromNumber, "+10000000002", "must rebind to the live line, not return the paused one")
    assert.equal(out.source, "rebind_paused")
    assert.equal(out.persisted, true)
    assert.equal(writes.length, 1)
    assert.equal(usersMap.get("u-paused")!.senderNumber, "+10000000002")
    assert.equal(usersMap.get("u-paused")!.senderAssignedSource, "rebind_paused")
  })

  it("bound user with the doc supplied → ZERO Firestore reads (hot-path contract)", async () => {
    const { db, reads, writes } = makeFakeDb({
      "u-hot": { senderNumber: "+10000000001", senderGroupId: "g1" },
    })
    const out = await resolveBoundFromNumber(db as never, "u-hot", {
      pool: POOL_1,
      user: { senderNumber: "+10000000001", senderGroupId: "g1" },
    })
    assert.equal(out.fromNumber, "+10000000001")
    assert.equal(reads.length, 0, "supplying the loaded user doc must cost ZERO extra reads")
    assert.equal(writes.length, 0)
  })

  it("no eligible line (empty/admin-only pool) → unresolved, no write, keeps existing binding", async () => {
    const ADMIN_ONLY: SendbluePoolConfig = {
      numbers: [{ number: "+1adminadmin", status: "active", audience: "admin", adminOnly: true }],
    }
    const { db, writes } = makeFakeDb({ "u-x": {} })
    const out = await resolveBoundFromNumber(db as never, "u-x", { pool: ADMIN_ONLY, user: {} })
    assert.equal(out.fromNumber, undefined)
    assert.equal(out.source, "unresolved")
    assert.equal(out.persisted, false)
    assert.equal(writes.length, 0)
  })

  it("pool unknown (null) → keep an existing binding rather than reshuffle", async () => {
    const { db, writes } = makeFakeDb({ "u-y": { senderNumber: "+15550001111" } })
    const out = await resolveBoundFromNumber(db as never, "u-y", {
      pool: null,
      user: { senderNumber: "+15550001111" },
    })
    assert.equal(out.fromNumber, "+15550001111")
    assert.equal(out.source, "bound")
    assert.equal(writes.length, 0)
  })

  it("persist failure → still returns the resolved line (send proceeds), persisted=false", async () => {
    // db whose set() throws — mimics a transient write failure.
    const db = {
      collection() {
        return {
          doc() {
            return {
              async get() {
                return { exists: true, data: () => ({}), id: "z" }
              },
              async set() {
                throw new Error("write blew up")
              },
            }
          },
        }
      },
    }
    const logs: string[] = []
    const out = await resolveBoundFromNumber(db as never, "u-z", {
      pool: POOL_2,
      user: {},
      log: (e) => logs.push(e),
    })
    assert.ok(out.fromNumber, "a write failure must NOT block resolution")
    assert.equal(out.persisted, false)
    assert.ok(logs.includes("sendblue.bind.persist_failed"))
  })
})

describe("isBoundNumberStillSelectable", () => {
  it("active public line is selectable; paused/dead/removed/admin are not", () => {
    const pool: SendbluePoolConfig = {
      numbers: [
        { number: "+1active", status: "active", audience: "public" },
        { number: "+1warmup", status: "warmup", audience: "public" },
        { number: "+1paused", status: "paused", audience: "public" },
        { number: "+1degraded", status: "degraded", audience: "public" },
        { number: "+1admin", status: "active", audience: "admin", adminOnly: true },
      ],
    }
    assert.equal(isBoundNumberStillSelectable(pool, "+1active"), true)
    assert.equal(isBoundNumberStillSelectable(pool, "+1warmup"), true, "warmup keeps existing thread continuity")
    assert.equal(isBoundNumberStillSelectable(pool, "+1paused"), false)
    assert.equal(isBoundNumberStillSelectable(pool, "+1degraded"), false)
    assert.equal(isBoundNumberStillSelectable(pool, "+1admin"), false)
    assert.equal(isBoundNumberStillSelectable(pool, "+1removed"), false, "a line no longer in the pool")
    assert.equal(isBoundNumberStillSelectable(null, "+1anything"), true, "unknown pool → keep binding")
  })
})

describe("decideBoundFromNumber (pure core)", () => {
  it("honoring a binding needs no persist; mint/rebind needs persist", () => {
    const honored = decideBoundFromNumber(POOL_1, "u", { senderNumber: "+10000000001" })
    assert.equal(honored.needsPersist, false)
    assert.equal(honored.source, "bound")

    const minted = decideBoundFromNumber(POOL_1, "u", {})
    assert.equal(minted.needsPersist, true)
    assert.equal(minted.source, "send_path_mint")
  })
})

// ─── RULE 3 (2026-06-11 incident) — mint binds from the inbound thread ──────
// Live violation: user texted IN on 717 (identity notices replied from 717),
// then a cold opener MINTED a fresh capacity-pick binding → went out from 614.
// One human, two numbers. The MINT arm must bind to the line the user's
// latest inbound arrived on; capacity pick is only the no-inbound fallback.

function makeFakeDbWithInbound(
  users: Record<string, DocData>,
  inboundEvents: Record<string, DocData>,
) {
  const usersMap = new Map<string, DocData>(Object.entries(users))
  const inboundMap = new Map<string, DocData>(Object.entries(inboundEvents))
  const writes: Array<{ id: string; data: DocData }> = []
  const db = {
    collection(name: string) {
      if (name === "pa-inbound-events") {
        const filters: Array<[string, unknown]> = []
        const q = {
          where(field: string, _op: string, value: unknown) {
            filters.push([field, value])
            return q
          },
          limit() { return q },
          async get() {
            const docs = [...inboundMap.entries()]
              .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
              .map(([id, d]) => ({ id, data: () => d }))
            return { empty: docs.length === 0, docs }
          },
        }
        return q
      }
      assert.equal(name, "pa-users")
      return {
        doc(id: string) {
          return {
            async get() {
              const data = usersMap.get(id)
              return { exists: data !== undefined, data: () => data, id }
            },
            async set(data: DocData, opts?: { merge?: boolean }) {
              writes.push({ id, data })
              if (opts?.merge) usersMap.set(id, { ...(usersMap.get(id) ?? {}), ...data })
              else usersMap.set(id, { ...data })
            },
          }
        },
      }
    },
  }
  return { db, usersMap, writes }
}

describe("RULE 3 — mint binds from the inbound thread (2026-06-11)", () => {
  it("MINT prefers the user's latest inbound-thread line over the capacity pick", async () => {
    // Find a uid whose CAPACITY pick under POOL_2 is +...0002 so preferring
    // +...0001 (the inbound thread) is observably NOT the capacity pick.
    const { pickFromNumber } = await import("../pool.js")
    let uid = ""
    for (let i = 0; i < 200; i++) {
      if (pickFromNumber(POOL_2, `u-${i}`) === POOL_2.numbers![1].number) { uid = `u-${i}`; break }
    }
    assert.ok(uid, "expected a uid whose capacity pick is the second line")

    const threadLine = POOL_2.numbers![0].number // the line their inbound arrived ON
    const { db, usersMap, writes } = makeFakeDbWithInbound(
      { [uid]: {} },
      {
        inb_old: { userId: uid, createdAt: "2026-06-10T01:00:00.000Z", rawPayload: { toNumber: POOL_2.numbers![1].number } },
        inb_new: { userId: uid, createdAt: "2026-06-11T09:00:00.000Z", rawPayload: { toNumber: threadLine } },
      },
    )
    const logged: string[] = []
    const out = await resolveBoundFromNumber(db as never, uid, {
      pool: POOL_2,
      user: {},
      mintSource: "send_path_mint",
      log: (event) => logged.push(event),
    })
    assert.equal(out.fromNumber, threadLine, "binds to the LATEST inbound thread line, not the capacity pick")
    assert.equal(out.persisted, true)
    assert.equal(usersMap.get(uid)!.senderNumber, threadLine)
    assert.equal(writes.length, 1)
    assert.ok(logged.includes("sendblue.bind.mint_from_inbound_thread"), "mint arm logged")
    assert.ok(!logged.includes("sendblue.bind.mint_by_capacity"))
  })

  it("falls back to the capacity pick when the user has NO inbound evidence", async () => {
    const { db, usersMap } = makeFakeDbWithInbound({ "u-cold": {} }, {})
    const logged: string[] = []
    const out = await resolveBoundFromNumber(db as never, "u-cold", {
      pool: POOL_2,
      user: {},
      mintSource: "send_path_mint",
      log: (event) => logged.push(event),
    })
    assert.ok(out.fromNumber, "capacity mint still works")
    assert.ok([POOL_2.numbers![0].number, POOL_2.numbers![1].number].includes(out.fromNumber!))
    assert.equal(out.persisted, true)
    assert.equal(usersMap.get("u-cold")!.senderNumber, out.fromNumber)
    assert.ok(logged.includes("sendblue.bind.mint_by_capacity"), "capacity arm logged")
    assert.ok(!logged.includes("sendblue.bind.mint_from_inbound_thread"))
  })

  it("ignores an inbound-thread line that is NOT an eligible pool line (paused/foreign)", async () => {
    const { db } = makeFakeDbWithInbound(
      { "u-x": {} },
      { inb_1: { userId: "u-x", createdAt: "2026-06-11T09:00:00.000Z", rawPayload: { toNumber: "+19999999999" } } },
    )
    const logged: string[] = []
    const out = await resolveBoundFromNumber(db as never, "u-x", {
      pool: POOL_2,
      user: {},
      log: (event) => logged.push(event),
    })
    assert.ok(out.fromNumber, "still mints")
    assert.notEqual(out.fromNumber, "+19999999999", "a non-pool line is never minted")
    assert.ok(logged.includes("sendblue.bind.mint_by_capacity"))
  })

  it("BOUND user never triggers the inbound-thread lookup (hot path unchanged)", async () => {
    // The fake throws an assertion if pa-inbound-events is queried when we
    // don't expect it — reuse the strict pa-users-only fake.
    const { db, writes } = makeFakeDb({ "u-bound": { senderNumber: POOL_2.numbers![0].number } })
    const out = await resolveBoundFromNumber(db as never, "u-bound", {
      pool: POOL_2,
      user: { senderNumber: POOL_2.numbers![0].number },
    })
    assert.equal(out.source, "bound")
    assert.equal(out.fromNumber, POOL_2.numbers![0].number)
    assert.equal(writes.length, 0)
  })
})
