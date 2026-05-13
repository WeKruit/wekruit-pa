import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Firestore } from "firebase-admin/firestore"

import {
  createOutreachCapacityDocId,
  getOutreachCapacitySnapshot,
  OUTREACH_CAPACITY_COLLECTION,
  reserveOutreachCapacity,
} from "./outreach-capacity.js"

function makeFakeDb() {
  const docs = new Map<string, Record<string, unknown>>()

  function makeDocRef(coll: string, id: string) {
    const key = `${coll}/${id}`
    return {
      _key: key,
      id,
      async get() {
        const data = docs.get(key)
        return { exists: data !== undefined, data: () => data, id }
      },
    }
  }

  const db = {
    collection(name: string) {
      return {
        doc(id: string) {
          return makeDocRef(name, id)
        },
      }
    },
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      const t = {
        async get(ref: { get(): Promise<{ exists: boolean; data: () => unknown; id: string }> }) {
          return ref.get()
        },
        update(ref: { _key: string }, data: Record<string, unknown>) {
          docs.set(ref._key, { ...(docs.get(ref._key) ?? {}), ...data })
        },
        set(ref: { _key: string }, data: Record<string, unknown>) {
          docs.set(ref._key, { ...data })
        },
      }
      return fn(t)
    },
  } as unknown as Firestore

  return { db, docs }
}

describe("outreach-capacity", () => {
  it("uses hashed group ids in daily counter doc ids", () => {
    const id = createOutreachCapacityDocId("+13054507716", new Date("2026-05-13T12:00:00Z"))
    assert.match(id, /^20260513_[a-f0-9]{32}$/)
    assert.equal(id.includes("+13054507716"), false)
  })

  it("dry-run snapshot does not increment usage", async () => {
    const { db, docs } = makeFakeDb()
    const date = new Date("2026-05-13T12:00:00Z")
    const result = await reserveOutreachCapacity(db, {
      groupId: "primary",
      status: "active",
      dailyCap: 2,
      date,
      dryRun: true,
    })
    assert.equal(result.ok, true)
    assert.equal(result.reserved, false)
    assert.equal(result.snapshot.usedToday, 0)
    assert.equal(docs.size, 0)
  })

  it("reservation increments usage once", async () => {
    const { db, docs } = makeFakeDb()
    const date = new Date("2026-05-13T12:00:00Z")
    const result = await reserveOutreachCapacity(db, {
      groupId: "primary",
      status: "active",
      dailyCap: 2,
      fromNumber: "+1",
      date,
    })
    assert.equal(result.ok, true)
    assert.equal(result.reserved, true)
    assert.equal(result.snapshot.usedToday, 1)
    assert.equal(result.snapshot.remainingToday, 1)
    assert.equal(docs.size, 1)
    const doc = [...docs.values()][0]!
    assert.equal(doc.count, 1)
    assert.equal(doc.bucket, "20260513")
    assert.equal(typeof doc.expiresAt, "string")
  })

  it("same reservation key is idempotent and does not double count", async () => {
    const { db, docs } = makeFakeDb()
    const date = new Date("2026-05-13T12:00:00Z")
    const first = await reserveOutreachCapacity(db, {
      groupId: "primary",
      status: "active",
      dailyCap: 2,
      date,
      reservationKey: "outinvite-cand-job",
    })
    const second = await reserveOutreachCapacity(db, {
      groupId: "primary",
      status: "active",
      dailyCap: 2,
      date,
      reservationKey: "outinvite-cand-job",
    })

    assert.equal(first.reserved, true)
    assert.equal(second.ok, true)
    assert.equal(second.reserved, false)
    assert.equal(second.snapshot.usedToday, 1)
    const [doc] = [...docs.values()]
    assert.equal(doc!.count, 1)
    assert.equal(JSON.stringify(doc).includes("outinvite-cand-job"), false)
  })

  it("enforces the cap transactionally", async () => {
    const { db } = makeFakeDb()
    const date = new Date("2026-05-13T12:00:00Z")
    await reserveOutreachCapacity(db, { groupId: "primary", status: "active", dailyCap: 1, date })
    const blocked = await reserveOutreachCapacity(db, {
      groupId: "primary",
      status: "active",
      dailyCap: 1,
      date,
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.reserved, false)
    assert.equal(blocked.reason, "capacity_full")
    assert.equal(blocked.snapshot.usedToday, 1)
    assert.equal(blocked.snapshot.remainingToday, 0)
  })

  it("blocks warmup groups without incrementing", async () => {
    const { db, docs } = makeFakeDb()
    const date = new Date("2026-05-13T12:00:00Z")
    const blocked = await reserveOutreachCapacity(db, {
      groupId: "warm",
      status: "warmup",
      dailyCap: 10,
      date,
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.reserved, false)
    assert.equal(blocked.reason, "warmup_requires_hitl")
    assert.equal(docs.size, 0)
  })

  it("snapshot reads current daily usage without incrementing", async () => {
    const { db, docs } = makeFakeDb()
    const date = new Date("2026-05-13T12:00:00Z")
    await reserveOutreachCapacity(db, { groupId: "primary", status: "active", dailyCap: 3, date })
    const before = docs.size
    const snapshot = await getOutreachCapacitySnapshot(db, {
      groupId: "primary",
      status: "active",
      dailyCap: 3,
      date,
    })
    assert.equal(snapshot.usedToday, 1)
    assert.equal(snapshot.remainingToday, 2)
    assert.equal(docs.size, before)
    assert.equal([...docs.keys()][0]!.startsWith(`${OUTREACH_CAPACITY_COLLECTION}/20260513_`), true)
  })
})
