/**
 * Stream H9 TD2 — paSendblueOutboxRetrySweepHandler tests.
 *
 * Verifies:
 *  1. 3 orphans (createdAt > 60s old) + 2 fresh rows → only 3 reprocessed
 *  2. Concurrency cap honored (no more than N parallel in-flight)
 *  3. Idempotent — second sweep on the same orphans (now sent) does not
 *     re-send (handler claim tx blocks status!=pending).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { paSendblueOutboxRetrySweepHandler } from "../outbox-retry-sweep.js"

type DocData = Record<string, unknown>

const ALLOWED = "+15551234567"
const USER = { id: "u-sweep", phoneE164: ALLOWED }

function makeFakeDb(initialOutbound: Record<string, DocData> = {}) {
  const outbound = new Map<string, DocData>(Object.entries(initialOutbound))
  const flags = new Map<string, DocData>()
  const outboundDaily = new Map<string, DocData>()

  function makeDocRef(coll: string, id: string) {
    const store =
      coll === "pa-outbound" ? outbound :
      coll === "pa-feature-flags" ? flags :
      coll === "pa-outbound-daily" ? outboundDaily :
      new Map<string, DocData>()
    return {
      _store: store,
      _id: id,
      async get() {
        const data = store.get(id)
        return { exists: data !== undefined, data: () => data, id }
      },
      async set(data: DocData, opts?: { merge?: boolean }) {
        if (opts?.merge) store.set(id, { ...(store.get(id) ?? {}), ...data })
        else store.set(id, { ...data })
      },
      async update(data: DocData) {
        store.set(id, { ...(store.get(id) ?? {}), ...data })
      },
    }
  }

  function makeQuery(coll: string, filter: (d: DocData) => boolean) {
    return {
      where(_field: string, _op: string, _val: unknown) { return this },
      limit(_n: number) { return this },
      async get() {
        const map = coll === "pa-outbound" ? outbound : new Map<string, DocData>()
        const docs = [...map.entries()]
          .filter(([, d]) => filter(d))
          .map(([id, d]) => ({ id, data: () => d, ref: makeDocRef(coll, id) }))
        return { docs, empty: docs.length === 0, size: docs.length }
      },
    }
  }

  const db = {
    collection(name: string) {
      return {
        doc(id: string) { return makeDocRef(name, id) },
        add(_d: DocData) { return Promise.resolve({ id: "x" }) },
        where(field: string, op: string, val: unknown) {
          const filter = (d: DocData) => {
            if (field === "status" && op === "==") return d.status === val
            return true
          }
          return makeQuery(name, filter)
        },
        limit() { return this },
        async get() { return { empty: true, docs: [] } },
      }
    },
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      const t = {
        async get(ref: { get(): Promise<{ exists: boolean; data: () => DocData | undefined; id: string }> }) {
          return ref.get()
        },
        update(ref: { _store?: Map<string, DocData>; _id?: string }, data: DocData) {
          if (ref._store && ref._id) ref._store.set(ref._id, { ...(ref._store.get(ref._id) ?? {}), ...data })
        },
        set(ref: { _store?: Map<string, DocData>; _id?: string }, data: DocData) {
          if (ref._store && ref._id) ref._store.set(ref._id, { ...data })
        },
      }
      return fn(t)
    },
  }
  return { db, outbound }
}

function makeSendblueMock() {
  let calls = 0
  let inflight = 0
  let maxInflight = 0
  const sendImessage = async () => {
    calls++
    inflight++
    maxInflight = Math.max(maxInflight, inflight)
    await new Promise((r) => setTimeout(r, 10))
    inflight--
    return {
      type: "message" as const,
      uuid: `uuid-${calls}`,
      message_handle: `uuid-${calls}`,
      status: "QUEUED",
      from_number: "+15557654321",
      number: ALLOWED,
      content: "x",
      service: "iMessage" as const,
      is_outbound: true as const,
    }
  }
  const sendTypingIndicator = async () => {}
  return {
    sendImessage,
    sendTypingIndicator,
    get calls() { return calls },
    get maxInflight() { return maxInflight },
  }
}

describe("paSendblueOutboxRetrySweepHandler (Stream H9 TD2)", () => {
  it("test 1: 3 orphans (>60s old) + 2 fresh (<60s) → 3 reprocessed", async () => {
    process.env.IMESSAGE_DM_ALLOWLIST = "1"
    process.env.IMESSAGE_PEERS = ALLOWED

    const NOW = new Date("2026-05-01T22:00:00.000Z")
    const oldTs = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString() // 5min ago
    const freshTs = new Date(NOW.getTime() - 10 * 1000).toISOString()    // 10s ago
    const baseRow = (id: string, createdAt: string): DocData => ({
      status: "pending",
      userId: USER.id,
      toE164: ALLOWED,
      body: `msg ${id}`,
      idempotencyKey: `out-${id}`,
      createdAt,
      runtimeApproved: true,
      runtimeSource: "test_runtime",
    })
    const { db, outbound } = makeFakeDb({
      "orph-1": baseRow("orph-1", oldTs),
      "orph-2": baseRow("orph-2", oldTs),
      "orph-3": baseRow("orph-3", oldTs),
      "fresh-1": baseRow("fresh-1", freshTs),
      "fresh-2": baseRow("fresh-2", freshTs),
    })
    const sb = makeSendblueMock()

    const res = await paSendblueOutboxRetrySweepHandler({
      db: db as never,
      sendblueClient: sb,
      now: () => NOW,
      log: () => {},
      appendMessage: async () => {},
      getUser: async () => USER as never,
      getOrCreateSession: async () => ({ id: "s-1" } as never),
    })

    assert.equal(res.scanned, 5, "all 5 candidates scanned")
    assert.equal(res.reprocessed, 3, "3 orphans reprocessed")
    assert.equal(sb.calls, 3, "Sendblue POSTed 3x")

    // Assert orphans are now sent, fresh are still pending
    assert.equal(outbound.get("orph-1")!.status, "sent")
    assert.equal(outbound.get("orph-2")!.status, "sent")
    assert.equal(outbound.get("orph-3")!.status, "sent")
    assert.equal(outbound.get("fresh-1")!.status, "pending")
    assert.equal(outbound.get("fresh-2")!.status, "pending")

    delete process.env.IMESSAGE_DM_ALLOWLIST
    delete process.env.IMESSAGE_PEERS
  })

  it("test 2: concurrency cap = 2 → never more than 2 sendImessage in flight", async () => {
    process.env.IMESSAGE_DM_ALLOWLIST = "1"
    process.env.IMESSAGE_PEERS = ALLOWED

    const NOW = new Date("2026-05-01T22:00:00.000Z")
    const oldTs = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString()
    const rows: Record<string, DocData> = {}
    for (let i = 0; i < 8; i++) {
      rows[`o-${i}`] = {
        status: "pending",
        userId: USER.id,
        toE164: ALLOWED,
        body: `m${i}`,
        idempotencyKey: `out-o-${i}`,
        createdAt: oldTs,
        runtimeApproved: true,
        runtimeSource: "test_runtime",
      }
    }
    const { db } = makeFakeDb(rows)
    const sb = makeSendblueMock()

    await paSendblueOutboxRetrySweepHandler({
      db: db as never,
      sendblueClient: sb,
      now: () => NOW,
      log: () => {},
      appendMessage: async () => {},
      getUser: async () => USER as never,
      getOrCreateSession: async () => ({ id: "s-1" } as never),
      concurrency: 2,
    })

    assert.equal(sb.calls, 8, "all 8 orphans processed")
    assert.ok(sb.maxInflight <= 2, `concurrency cap violated: maxInflight=${sb.maxInflight}`)

    delete process.env.IMESSAGE_DM_ALLOWLIST
    delete process.env.IMESSAGE_PEERS
  })

  it("test 3: second sweep on already-sent rows → idempotent (no re-send)", async () => {
    process.env.IMESSAGE_DM_ALLOWLIST = "1"
    process.env.IMESSAGE_PEERS = ALLOWED

    const NOW = new Date("2026-05-01T22:00:00.000Z")
    const oldTs = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString()
    const { db } = makeFakeDb({
      "o-1": {
        status: "pending",
        userId: USER.id,
        toE164: ALLOWED,
        body: "once",
        idempotencyKey: "out-once",
        createdAt: oldTs,
        runtimeApproved: true,
        runtimeSource: "test_runtime",
      },
    })
    const sb = makeSendblueMock()
    const deps = {
      db: db as never,
      sendblueClient: sb,
      now: () => NOW,
      log: () => {},
      appendMessage: async () => {},
      getUser: async () => USER as never,
      getOrCreateSession: async () => ({ id: "s-1" } as never),
    }

    // First sweep — sends.
    const r1 = await paSendblueOutboxRetrySweepHandler(deps)
    assert.equal(r1.reprocessed, 1)
    assert.equal(sb.calls, 1)

    // Second sweep — row is now status=sent, so the candidate query
    // (status==pending) returns empty.
    const r2 = await paSendblueOutboxRetrySweepHandler(deps)
    assert.equal(r2.scanned, 0, "no pending candidates after first sweep")
    assert.equal(r2.reprocessed, 0, "no reprocessing on idempotent re-run")
    assert.equal(sb.calls, 1, "Sendblue NOT called again")

    delete process.env.IMESSAGE_DM_ALLOWLIST
    delete process.env.IMESSAGE_PEERS
  })
})
