/**
 * Stream H9 TD1 — verify TTL writes use Timestamp-typed `expiresAtTs`.
 *
 * Firestore TTL GC only fires on Timestamp fields. The previous `updatedAt`
 * ISO string anchored TTL silently never expired anything. This suite locks
 * the new `expiresAtTs` Timestamp write at every TTL-relevant write site.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Timestamp } from "firebase-admin/firestore"

import { paSendblueOutboxHandler } from "../outbox.js"
import {
  computeExpiresAtTs,
  outboundExpiresAtTs,
  inboundEventExpiresAtTs,
  triggerFireExpiresAtTs,
  TTL_DAYS,
} from "../ttl.js"

type DocData = Record<string, unknown>

function makeFakeDb(initial: Record<string, DocData> = {}) {
  const outbound = new Map<string, DocData>(Object.entries(initial))
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

  const db = {
    collection(name: string) {
      return {
        doc(id: string) { return makeDocRef(name, id) },
        add() { return Promise.resolve({ id: "x" }) },
        where() { return this },
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

const ALLOWED = "+15551234567"
const USER = { id: "u-ttl", phoneE164: ALLOWED }

describe("Stream H9 TD1 — expiresAtTs Timestamp writes", () => {
  it("computeExpiresAtTs returns a Timestamp N days in the future", () => {
    const NOW = new Date("2026-05-01T00:00:00.000Z")
    const ts = computeExpiresAtTs(30, NOW)
    assert.ok(ts instanceof Timestamp, "must be a Timestamp instance, NOT an ISO string")
    const expected = NOW.getTime() + 30 * 24 * 60 * 60 * 1000
    assert.equal(ts.toMillis(), expected)
  })

  it("per-collection helpers use the brief's retention window", () => {
    const NOW = new Date("2026-05-01T00:00:00.000Z")
    assert.equal(TTL_DAYS.outbound, 30)
    assert.equal(TTL_DAYS.inboundEvents, 60)
    assert.equal(TTL_DAYS.triggerFires, 30)
    assert.equal(outboundExpiresAtTs(NOW).toMillis(), NOW.getTime() + 30 * 24 * 60 * 60 * 1000)
    assert.equal(inboundEventExpiresAtTs(NOW).toMillis(), NOW.getTime() + 60 * 24 * 60 * 60 * 1000)
    assert.equal(triggerFireExpiresAtTs(NOW).toMillis(), NOW.getTime() + 30 * 24 * 60 * 60 * 1000)
  })

  it("outbox handler writes Timestamp-typed expiresAtTs on the SENT row", async () => {
    const baseRow: DocData = {
      status: "pending",
      userId: USER.id,
      toE164: ALLOWED,
      body: "hello",
      idempotencyKey: "out-ttl-1",
      createdAt: new Date().toISOString(),
      runtimeApproved: true,
      runtimeSource: "test_runtime",
    }
    const { db, outbound } = makeFakeDb({ "doc-ttl-1": baseRow })
    const sb = {
      sendImessage: async () => ({
        type: "message" as const,
        uuid: "uuid-ttl-1",
        message_handle: "uuid-ttl-1",
        status: "QUEUED",
        from_number: "+15557654321",
        number: ALLOWED,
        content: "hello",
        service: "iMessage" as const,
        is_outbound: true as const,
      }),
      sendTypingIndicator: async () => {},
    }

    await paSendblueOutboxHandler(
      { params: { docId: "doc-ttl-1" }, data: { data: () => baseRow, id: "doc-ttl-1" } } as never,
      {
        db: db as never,
        sendblueClient: sb,
        now: () => new Date("2026-05-01T22:00:00.000Z"),
        log: () => {},
        appendMessage: async () => {},
        getUser: async () => USER as never,
        getOrCreateSession: async () => ({ id: "s-1" } as never),
      }
    )
    const finalDoc = outbound.get("doc-ttl-1")!
    assert.equal(finalDoc.status, "sent")
    assert.ok(finalDoc.expiresAtTs, "expiresAtTs must be set on sent row")
    assert.ok(
      finalDoc.expiresAtTs instanceof Timestamp,
      "expiresAtTs MUST be a Timestamp instance — Firestore TTL only fires on Timestamp"
    )
    // Existing updatedAt ISO must STILL be present (the brief: do NOT remove it).
    assert.equal(typeof finalDoc.updatedAt, "string", "updatedAt ISO string preserved for app-level queries")
  })
})
