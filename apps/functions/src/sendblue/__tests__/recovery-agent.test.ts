import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { inboundEventDocId } from "@pa/pa-broker"

import { paConversationRecoverySweepHandler } from "../recovery-agent.js"

type DocData = Record<string, unknown>

const WEKRUIT = "+17174919939"

function rawDoc(input: {
  id: string
  from: string
  to: string
  content: string
  handle: string
  dateSent: string
  outbound?: boolean
}): [string, DocData] {
  return [
    input.id,
    {
      receivedAt: input.dateSent,
      bodyText: JSON.stringify({
        content: input.content,
        is_outbound: input.outbound === true,
        status: input.outbound ? "DELIVERED" : "RECEIVED",
        message_handle: input.handle,
        date_sent: input.dateSent,
        from_number: input.from,
        number: input.outbound ? input.to : input.from,
        to_number: input.to,
        sendblue_number: input.outbound ? null : WEKRUIT,
        service: "iMessage",
      }),
    },
  ]
}

function makeFakeDb(initial: Record<string, Record<string, DocData>> = {}) {
  const stores = new Map<string, Map<string, DocData>>()
  for (const [name, rows] of Object.entries(initial)) {
    stores.set(name, new Map(Object.entries(rows)))
  }
  const writes: Array<{ collection: string; id: string; data: DocData }> = []

  function storeFor(name: string): Map<string, DocData> {
    let store = stores.get(name)
    if (!store) {
      store = new Map()
      stores.set(name, store)
    }
    return store
  }

  function docRef(collection: string, id: string) {
    const store = storeFor(collection)
    return {
      id,
      async get() {
        const data = store.get(id)
        return { id, exists: data !== undefined, data: () => data }
      },
      async set(data: DocData, options?: { merge?: boolean }) {
        const next = options?.merge ? { ...(store.get(id) ?? {}), ...data } : { ...data }
        store.set(id, next)
        writes.push({ collection, id, data: next })
      },
      async create(data: DocData) {
        if (store.has(id)) {
          const err = new Error("already exists") as Error & { code?: number }
          err.code = 6
          throw err
        }
        store.set(id, { ...data })
        writes.push({ collection, id, data: { ...data } })
      },
      async update(data: DocData) {
        const next = { ...(store.get(id) ?? {}), ...data }
        store.set(id, next)
        writes.push({ collection, id, data: next })
      },
    }
  }

  function query(collection: string, filters: Array<[string, string, unknown]> = []) {
    let orderField: string | null = null
    let orderDir: "asc" | "desc" = "asc"
    let max = Number.POSITIVE_INFINITY
    return {
      where(field: string, op: string, value: unknown) {
        filters.push([field, op, value])
        return this
      },
      orderBy(field: string, dir: "asc" | "desc" = "asc") {
        orderField = field
        orderDir = dir
        return this
      },
      limit(n: number) {
        max = n
        return this
      },
      async get() {
        let rows = [...storeFor(collection).entries()]
        for (const [field, op, value] of filters) {
          rows = rows.filter(([, data]) => {
            if (op === "==") return data[field] === value
            if (op === ">=") return String(data[field] ?? "") >= String(value)
            return true
          })
        }
        if (orderField) {
          rows.sort(([, a], [, b]) => {
            const av = String(a[orderField!] ?? "")
            const bv = String(b[orderField!] ?? "")
            return orderDir === "desc" ? bv.localeCompare(av) : av.localeCompare(bv)
          })
        }
        rows = rows.slice(0, max)
        const docs = rows.map(([id, data]) => ({
          id,
          ref: docRef(collection, id),
          data: () => data,
        }))
        return { docs, empty: docs.length === 0, size: docs.length }
      },
    }
  }

  const db = {
    collection(name: string) {
      return {
        doc(id: string) { return docRef(name, id) },
        where(field: string, op: string, value: unknown) { return query(name, [[field, op, value]]) },
        orderBy(field: string, dir: "asc" | "desc" = "asc") { return query(name).orderBy(field, dir) },
        limit(n: number) { return query(name).limit(n) },
        async get() { return query(name).get() },
      }
    },
  }

  return { db, stores, writes }
}

describe("paConversationRecoverySweepHandler", () => {
  it("replays an existing pending inbound event for true silent ordinary inbound", async () => {
    const phone = "+15550001001"
    const handle = "h-ordinary-1"
    const eventId = inboundEventDocId(`sendblue-${handle}`)
    const { db, stores } = makeFakeDb({
      "pa-sendblue-webhook-raw": Object.fromEntries([
        rawDoc({
          id: "raw-out",
          from: WEKRUIT,
          to: phone,
          content: "How did those roles feel?",
          handle: "h-out",
          dateSent: "2026-05-24T02:07:15.000Z",
          outbound: true,
        }),
        rawDoc({
          id: "raw-in",
          from: phone,
          to: WEKRUIT,
          content: "Product engineer",
          handle,
          dateSent: "2026-05-24T02:08:00.000Z",
        }),
      ]),
      "pa-inbound-events": {
        [eventId]: {
          id: eventId,
          status: "pending",
          idempotencyKey: `sendblue-${handle}`,
          createdAt: "2026-05-24T02:08:00.000Z",
        },
      },
    })
    const replayed: string[] = []

    const result = await paConversationRecoverySweepHandler({
      db: db as never,
      now: () => new Date("2026-05-27T00:00:00.000Z"),
      processInboundEventById: async (id) => { replayed.push(id) },
      log: () => {},
    })

    assert.equal(result.recovered, 1)
    assert.deepEqual(replayed, [eventId])
    const cases = stores.get("pa-recovery-cases")!
    assert.equal(cases.size, 1)
    const recovery = [...cases.values()][0]!
    assert.equal(recovery.className, "true_silent_inbound")
    assert.equal(recovery.action, "replay_inbound_event")
    assert.equal(recovery.status, "verification_pending")
  })

  it("reconstructs a missing inbound event from raw Sendblue before replaying it", async () => {
    const phone = "+15550001002"
    const handle = "h-missing-event"
    const eventId = inboundEventDocId(`sendblue-${handle}`)
    const { db, stores } = makeFakeDb({
      "pa-sendblue-webhook-raw": Object.fromEntries([
        rawDoc({
          id: "raw-missing-event",
          from: phone,
          to: WEKRUIT,
          content: "I need roles which require 1-2 years.",
          handle,
          dateSent: "2026-05-24T02:08:00.000Z",
        }),
      ]),
    })
    const replayed: string[] = []

    const result = await paConversationRecoverySweepHandler({
      db: db as never,
      now: () => new Date("2026-05-27T00:00:00.000Z"),
      processInboundEventById: async (id) => { replayed.push(id) },
      log: () => {},
    })

    assert.equal(result.recovered, 1)
    assert.deepEqual(replayed, [eventId])
    const event = stores.get("pa-inbound-events")!.get(eventId)!
    assert.equal(event.status, "pending")
    assert.equal(event.coalescing, false)
    assert.equal(event.recoveryCreatedFromRaw, true)
    assert.equal((event.rawPayload as DocData).text, "I need roles which require 1-2 years.")
    const recovery = [...stores.get("pa-recovery-cases")!.values()][0]!
    assert.equal(recovery.className, "true_silent_inbound")
    assert.equal(recovery.action, "create_and_replay_inbound_event")
    assert.equal(recovery.status, "verification_pending")
  })

  it("sends an identity notice for a prescreen token tied to another profile phone", async () => {
    const { db, stores } = makeFakeDb({
      "pa-sendblue-webhook-raw": Object.fromEntries([
        rawDoc({
          id: "raw-id-mismatch",
          from: "+15550002002",
          to: WEKRUIT,
          content: "WeKruit_hs-abc_user123_Job",
          handle: "h-identity",
          dateSent: "2026-05-24T02:08:00.000Z",
        }),
      ]),
      "pa-users": {
        user123: {
          phoneE164: "+15559999999",
        },
      },
    })

    const result = await paConversationRecoverySweepHandler({
      db: db as never,
      now: () => new Date("2026-05-27T00:00:00.000Z"),
      log: () => {},
    })

    assert.equal(result.recovered, 1)
    const outbounds = [...stores.get("pa-outbound")!.values()]
    assert.equal(outbounds.length, 1)
    assert.equal(outbounds[0]!.toE164, "+15550002002")
    assert.equal(outbounds[0]!.runtimeSource, "pa_identity_notice")
    assert.match(String(outbounds[0]!.body), /different WeKruit profile number/)
  })

  it("starts a valid prescreen trigger when idempotency exists but no session or outbound exists", async () => {
    const phone = "+15550003003"
    const { db, stores } = makeFakeDb({
      "pa-sendblue-webhook-raw": Object.fromEntries([
        rawDoc({
          id: "raw-prescreen",
          from: phone,
          to: WEKRUIT,
          content: "WeKruit_hs-abc_user456_Job",
          handle: "h-prescreen",
          dateSent: "2026-05-24T02:08:00.000Z",
        }),
      ]),
      "pa-users": {
        user456: {
          phoneE164: phone,
        },
      },
      "pa-prescreen-trigger-idempotency": {
        "hs-abc_user456_h-prescreen": {
          jobId: "hs-abc",
          userId: "user456",
        },
      },
    })
    const started: Array<{ jobId: string; userId: string; toE164: string }> = []

    const result = await paConversationRecoverySweepHandler({
      db: db as never,
      now: () => new Date("2026-05-27T00:00:00.000Z"),
      startPrescreen: async (input) => {
        started.push(input)
        return { ok: true, sessionId: "ps-1" }
      },
      log: () => {},
    })

    assert.equal(result.recovered, 1)
    assert.deepEqual(started, [{ jobId: "hs-abc", userId: "user456", toE164: phone }])
    const recovery = [...stores.get("pa-recovery-cases")!.values()][0]!
    assert.equal(recovery.className, "prescreen_idempotent_no_session_or_outbound")
    assert.equal(recovery.action, "start_prescreen")
    assert.equal(recovery.prescreenSessionId, "ps-1")
  })

  it("verifies a prior outbound recovery case once Sendblue delivery is recorded", async () => {
    const { db, stores } = makeFakeDb({
      "pa-recovery-cases": {
        "case-1": {
          status: "verification_pending",
          outboundId: "out-1",
          createdAt: "2026-05-26T00:00:00.000Z",
        },
      },
      "pa-outbound": {
        "out-1": {
          status: "sent",
          sendblueStatus: "DELIVERED",
          sendblueDeliveredAt: "2026-05-27T00:00:00.000Z",
        },
      },
    })

    const result = await paConversationRecoverySweepHandler({
      db: db as never,
      now: () => new Date("2026-05-27T00:05:00.000Z"),
      log: () => {},
    })

    assert.equal(result.verified, 1)
    assert.equal(stores.get("pa-recovery-cases")!.get("case-1")!.status, "verified")
    assert.equal(stores.get("pa-recovery-cases")!.get("case-1")!.verifiedAt, "2026-05-27T00:05:00.000Z")
  })

  it("verifies a replay recovery case from later Sendblue outbound raw delivery", async () => {
    const phone = "+15550005005"
    const { db, stores } = makeFakeDb({
      "pa-recovery-cases": {
        "case-raw-outbound": {
          status: "verification_pending",
          action: "replay_inbound_event",
          phone,
          latestInboundAt: "2026-05-24T02:08:00.000Z",
        },
      },
      "pa-sendblue-webhook-raw": Object.fromEntries([
        rawDoc({
          id: "raw-in",
          from: phone,
          to: WEKRUIT,
          content: "Product engineer",
          handle: "h-in",
          dateSent: "2026-05-24T02:08:00.000Z",
        }),
        rawDoc({
          id: "raw-out",
          from: WEKRUIT,
          to: phone,
          content: "Got it. I will look for product engineering roles.",
          handle: "h-out",
          dateSent: "2026-05-24T02:09:00.000Z",
          outbound: true,
        }),
      ]),
    })

    const result = await paConversationRecoverySweepHandler({
      db: db as never,
      now: () => new Date("2026-05-27T00:05:00.000Z"),
      log: () => {},
    })

    assert.equal(result.verified, 1)
    const recovery = stores.get("pa-recovery-cases")!.get("case-raw-outbound")!
    assert.equal(recovery.status, "verified")
    assert.equal(recovery.sendblueStatus, "DELIVERED")
    assert.equal(recovery.messageHandle, "h-out")
  })

  it("does not rerun action for an already recovered case", async () => {
    const phone = "+15550004004"
    const handle = "h-dedupe"
    const caseId = "sendblue_raw-in"
    const { db } = makeFakeDb({
      "pa-sendblue-webhook-raw": Object.fromEntries([
        rawDoc({
          id: "raw-in",
          from: phone,
          to: WEKRUIT,
          content: "Hello?",
          handle,
          dateSent: "2026-05-24T02:08:00.000Z",
        }),
      ]),
      "pa-recovery-cases": {
        [caseId]: {
          status: "recovered",
          className: "true_silent_inbound",
        },
      },
    })
    let replayed = 0

    const result = await paConversationRecoverySweepHandler({
      db: db as never,
      now: () => new Date("2026-05-27T00:00:00.000Z"),
      processInboundEventById: async () => { replayed++ },
      log: () => {},
    })

    assert.equal(result.skippedExisting, 1)
    assert.equal(replayed, 0)
  })
})
