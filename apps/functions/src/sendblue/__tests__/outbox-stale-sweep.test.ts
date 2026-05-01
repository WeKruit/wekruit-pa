/**
 * Stream H4 D2 — paSendblueOutbox auto-sweep tests.
 *
 * Verifies sweepStaleOutbound() (called at top of every paSendblueOutbox
 * tick) correctly:
 *   - resets stuck "sending" rows (>10min) → "pending"
 *   - leaves fresh "sending" rows untouched
 *   - moves "pending" rows with attemptCount >= 5 → "dead_letter"
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { sweepStaleOutbound } from "../outbox.js"

type DocData = Record<string, unknown>

function makeFakeDb(initial: Record<string, DocData> = {}) {
  const outbound = new Map<string, DocData>(Object.entries(initial))

  function makeDocRef(id: string) {
    return {
      _store: outbound,
      _id: id,
      async get() {
        const data = outbound.get(id)
        return { exists: data !== undefined, data: () => data, id }
      },
      async update(data: DocData) {
        outbound.set(id, { ...(outbound.get(id) ?? {}), ...data })
      },
    }
  }

  function makeQuery(filter: (d: DocData) => boolean) {
    return {
      where(_field: string, _op: string, _val: unknown) {
        // chain — outer where already applied via filter argument; allow stacking
        return this
      },
      limit(_n: number) {
        return this
      },
      async get() {
        const docs = [...outbound.entries()]
          .filter(([, d]) => filter(d))
          .map(([id, d]) => {
            const ref = makeDocRef(id)
            return { id, data: () => d, ref }
          })
        return { docs, empty: docs.length === 0, size: docs.length }
      },
    }
  }

  const db = {
    collection(name: string) {
      if (name !== "pa-outbound") throw new Error(`unexpected collection ${name}`)
      let activeFilter: (d: DocData) => boolean = () => true
      return {
        doc: makeDocRef,
        where(field: string, op: string, val: unknown) {
          activeFilter = (d: DocData) => {
            if (field === "status" && op === "==") return d.status === val
            return true
          }
          return makeQuery(activeFilter)
        },
      }
    },
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      const tx = {
        async get(ref: { get(): Promise<{ exists: boolean; data: () => DocData | undefined; id: string }> }) {
          return ref.get()
        },
        update(ref: { _store?: Map<string, DocData>; _id?: string }, data: DocData) {
          if (ref._store && ref._id) {
            ref._store.set(ref._id, { ...(ref._store.get(ref._id) ?? {}), ...data })
          }
        },
      }
      return fn(tx)
    },
  }
  return { db, outbound }
}

function captureLog() {
  const events: Array<{ event: string; payload: unknown }> = []
  const log: (...args: unknown[]) => void = (...args: unknown[]) => {
    const event = String(args[0] ?? "")
    const payload = args[1]
    events.push({ event, payload })
  }
  return { events, log }
}

describe("sweepStaleOutbound (Stream H4 D2)", () => {
  it("test 1: stuck sending >10min → swept to pending + log emitted", async () => {
    const NOW = new Date("2026-05-01T22:00:00.000Z")
    const stuckUpdatedAt = new Date(NOW.getTime() - 20 * 60 * 1000).toISOString() // 20min ago
    const { db, outbound } = makeFakeDb({
      "stuck-1": {
        status: "sending",
        updatedAt: stuckUpdatedAt,
        userId: "u1",
        body: "old reply",
      },
    })
    const { events, log } = captureLog()

    const res = await sweepStaleOutbound(db as never, () => NOW, log)

    assert.equal(res.swept, 1, "1 sending row swept")
    assert.equal(res.deadLettered, 0)
    const after = outbound.get("stuck-1")
    assert.equal(after?.status, "pending", "status flipped to pending")
    assert.ok(after?.staleSweptAt, "staleSweptAt timestamp stamped")
    assert.ok(events.some((e) => e.event === "outbound_sending_stale_swept"))
  })

  it("test 2: fresh sending <10min → untouched (idempotency under fast retries)", async () => {
    const NOW = new Date("2026-05-01T22:00:00.000Z")
    const freshUpdatedAt = new Date(NOW.getTime() - 2 * 60 * 1000).toISOString() // 2min ago
    const { db, outbound } = makeFakeDb({
      "fresh-1": {
        status: "sending",
        updatedAt: freshUpdatedAt,
        userId: "u1",
        body: "in-flight",
      },
    })
    const { events, log } = captureLog()

    const res = await sweepStaleOutbound(db as never, () => NOW, log)

    assert.equal(res.swept, 0, "no fresh row swept")
    assert.equal(res.deadLettered, 0)
    const after = outbound.get("fresh-1")
    assert.equal(after?.status, "sending", "status unchanged")
    assert.equal(after?.updatedAt, freshUpdatedAt, "updatedAt unchanged")
    assert.ok(!events.some((e) => e.event === "outbound_sending_stale_swept"))
  })

  it("test 3: pending attempts>=5 → moved to dead_letter + log emitted", async () => {
    const NOW = new Date("2026-05-01T22:00:00.000Z")
    const { db, outbound } = makeFakeDb({
      "exhausted-1": {
        status: "pending",
        attemptCount: 5,
        userId: "u1",
        body: "poison-pill",
        createdAt: "2026-04-30T00:00:00.000Z",
      },
      // Sanity: one sibling with attempts<5 should NOT be dead-lettered
      "young-retry-1": {
        status: "pending",
        attemptCount: 2,
        userId: "u2",
        body: "still trying",
        createdAt: "2026-04-30T00:00:00.000Z",
      },
    })
    const { events, log } = captureLog()

    const res = await sweepStaleOutbound(db as never, () => NOW, log)

    assert.equal(res.deadLettered, 1, "1 row dead-lettered")
    assert.equal(res.swept, 0)
    const exhausted = outbound.get("exhausted-1")
    assert.equal(exhausted?.status, "dead_letter")
    assert.ok(exhausted?.deadLetteredAt)
    const youngRetry = outbound.get("young-retry-1")
    assert.equal(youngRetry?.status, "pending", "young retry untouched")
    assert.ok(events.some((e) => e.event === "outbound_dead_lettered"))
  })
})
