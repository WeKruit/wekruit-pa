import assert from "node:assert/strict"
import test, { describe, it, beforeEach } from "node:test"
import type { Firestore } from "firebase-admin/firestore"

import { checkAndIncrementRateLimit, RATE_LIMIT_COLLECTION } from "./rate-limit.js"

// In-memory Firestore double for the rate-limit transactional path.
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

describe("checkAndIncrementRateLimit", () => {
  it("allows up to limit then blocks the (limit+1)-th request", async () => {
    const { db } = makeFakeDb()
    const fixedNow = () => 1_000_000_000_000 // pin to one bucket
    const userId = "user-A"
    const results = []
    for (let i = 0; i < 20; i++) {
      results.push(await checkAndIncrementRateLimit(db, userId, { limit: 20, windowSec: 60, now: fixedNow }))
    }
    assert.equal(results.every((r) => r.allowed), true, "first 20 must be allowed")
    assert.equal(results[19]!.remaining, 0)
    const blocked = await checkAndIncrementRateLimit(db, userId, { limit: 20, windowSec: 60, now: fixedNow })
    assert.equal(blocked.allowed, false)
    assert.equal(blocked.remaining, 0)
  })

  it("isolates buckets per user", async () => {
    const { db } = makeFakeDb()
    const fixedNow = () => 1_000_000_000_000
    for (let i = 0; i < 20; i++) {
      const r = await checkAndIncrementRateLimit(db, "user-A", { limit: 20, windowSec: 60, now: fixedNow })
      assert.equal(r.allowed, true)
    }
    // user-B gets a fresh budget at the same minute
    const rb = await checkAndIncrementRateLimit(db, "user-B", { limit: 20, windowSec: 60, now: fixedNow })
    assert.equal(rb.allowed, true)
    assert.equal(rb.remaining, 19)
  })

  it("expired bucket (next window) resets the count", async () => {
    const { db } = makeFakeDb()
    let now = 1_000_000_000_000
    const userId = "user-C"
    for (let i = 0; i < 20; i++) {
      const r = await checkAndIncrementRateLimit(db, userId, { limit: 20, windowSec: 60, now: () => now })
      assert.equal(r.allowed, true)
    }
    const blocked = await checkAndIncrementRateLimit(db, userId, { limit: 20, windowSec: 60, now: () => now })
    assert.equal(blocked.allowed, false)
    // Advance into the next minute bucket — user should be allowed again.
    now += 60_001
    const allowedAgain = await checkAndIncrementRateLimit(db, userId, { limit: 20, windowSec: 60, now: () => now })
    assert.equal(allowedAgain.allowed, true)
    assert.equal(allowedAgain.remaining, 19)
  })

  it("writes expiresAt for Firestore TTL eligibility", async () => {
    const { db, docs } = makeFakeDb()
    const fixedNow = () => 1_700_000_000_000
    await checkAndIncrementRateLimit(db, "user-D", { limit: 5, windowSec: 60, now: fixedNow })
    const entries = [...docs.entries()].filter(([k]) => k.startsWith(`${RATE_LIMIT_COLLECTION}/`))
    assert.equal(entries.length, 1)
    const [, doc] = entries[0]!
    assert.equal(typeof doc.expiresAt, "string")
    assert.equal(doc.userId, "user-D")
  })
})
