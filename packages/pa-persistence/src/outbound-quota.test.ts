import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Firestore } from "firebase-admin/firestore"

import {
  formatDailyBucket,
  getDailyOutboundCount,
  isDailyContactKnown,
  incrementDailyOutbound,
  OUTBOUND_QUOTA_COLLECTION,
} from "./outbound-quota.js"

function makeFakeDb() {
  const docs = new Map<string, Record<string, unknown>>()

  function makeDocRef(coll: string, id: string) {
    const key = `${coll}/${id}`
    return {
      _key: key,
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

describe("outbound-quota", () => {
  it("formatDailyBucket returns YYYYMMDD UTC", () => {
    assert.equal(formatDailyBucket(new Date("2026-04-28T00:00:00Z")), "20260428")
    assert.equal(formatDailyBucket(new Date("2026-01-01T00:00:00Z")), "20260101")
  })

  it("incrementDailyOutbound without phone monotonically grows (legacy compat)", async () => {
    const { db } = makeFakeDb()
    const day = new Date("2026-04-28T12:00:00Z")
    const a = await incrementDailyOutbound(db, day)
    const b = await incrementDailyOutbound(db, day)
    const c = await incrementDailyOutbound(db, day)
    assert.equal(a, 1)
    assert.equal(b, 2)
    assert.equal(c, 3)
  })

  it("incrementDailyOutbound with phone deduplicates same contact", async () => {
    const { db } = makeFakeDb()
    const day = new Date("2026-04-28T12:00:00Z")
    const a = await incrementDailyOutbound(db, day, "+15551234567")
    const b = await incrementDailyOutbound(db, day, "+15551234567")
    const c = await incrementDailyOutbound(db, day, "+15551234567")
    assert.equal(a, 1)
    assert.equal(b, 1, "same phone should not increment")
    assert.equal(c, 1, "same phone should not increment")
    assert.equal(await getDailyOutboundCount(db, day), 1)
  })

  it("incrementDailyOutbound counts distinct phones", async () => {
    const { db } = makeFakeDb()
    const day = new Date("2026-04-28T12:00:00Z")
    await incrementDailyOutbound(db, day, "+15551111111")
    await incrementDailyOutbound(db, day, "+15552222222")
    await incrementDailyOutbound(db, day, "+15551111111")
    await incrementDailyOutbound(db, day, "+15553333333")
    assert.equal(await getDailyOutboundCount(db, day), 3)
  })

  it("isDailyContactKnown returns false for unknown and true for known", async () => {
    const { db } = makeFakeDb()
    const day = new Date("2026-04-28T12:00:00Z")
    assert.equal(await isDailyContactKnown(db, "+15551234567", day), false)
    await incrementDailyOutbound(db, day, "+15551234567")
    assert.equal(await isDailyContactKnown(db, "+15551234567", day), true)
    assert.equal(await isDailyContactKnown(db, "+15559999999", day), false)
  })

  it("getDailyOutboundCount returns 0 for absent bucket and the increment value otherwise", async () => {
    const { db } = makeFakeDb()
    const day = new Date("2026-04-28T12:00:00Z")
    assert.equal(await getDailyOutboundCount(db, day), 0)
    await incrementDailyOutbound(db, day, "+15551111111")
    await incrementDailyOutbound(db, day, "+15552222222")
    assert.equal(await getDailyOutboundCount(db, day), 2)
  })

  it("isolates counters across days", async () => {
    const { db } = makeFakeDb()
    const d1 = new Date("2026-04-28T12:00:00Z")
    const d2 = new Date("2026-04-29T12:00:00Z")
    await incrementDailyOutbound(db, d1, "+15551111111")
    await incrementDailyOutbound(db, d1, "+15552222222")
    await incrementDailyOutbound(db, d2, "+15551111111")
    assert.equal(await getDailyOutboundCount(db, d1), 2)
    assert.equal(await getDailyOutboundCount(db, d2), 1)
  })

  it("writes expiresAt, bucket, and contacts fields", async () => {
    const { db, docs } = makeFakeDb()
    const day = new Date("2026-04-28T12:00:00Z")
    await incrementDailyOutbound(db, day, "+15551234567")
    const entries = [...docs.entries()].filter(([k]) => k.startsWith(`${OUTBOUND_QUOTA_COLLECTION}/`))
    assert.equal(entries.length, 1)
    const [, doc] = entries[0]!
    assert.equal(doc.bucket, "20260428")
    assert.equal(typeof doc.expiresAt, "string")
    assert.equal(typeof doc.lastUpdatedAt, "string")
    assert.deepEqual(doc.contacts, ["+15551234567"])
  })
})
