/**
 * outbox-inbound-evidence.test.ts — 2026-06-11 incident, RULE 1.
 *
 * NEVER outbound to a handle that never sent us an inbound message. The live
 * violation: the recovery sweep replayed old raw webhooks through new
 * email-sender resolution and fired prescreen Q1s + cold openers at users'
 * profile `phoneE164`, whose owners only ever texted from Apple-ID EMAIL
 * handles → `sendblue 400: INBOUND_ONLY_PLAN` (unsolicited cold texts on a
 * richer plan).
 *
 * The gate lives at the outbox choke point (paSendblueOutboxHandler), after
 * identity resolution and before any user-visible side effect. Exactly two
 * exemptions: dev phones, and runtimeSource "pa_identity_notice".
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"

import { paSendblueOutboxHandler, _resetPriorInboundEvidenceCache } from "../outbox.js"
import { _resetPoolCache, _resetCountersCache } from "../pool.js"

type DocData = Record<string, unknown>

function nestedField(data: DocData, path: string): unknown {
  let cur: unknown = data
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** Query-capable fake: every collection is a generic store with dotted-path filters. */
function makeFakeDb(seed: Record<string, Record<string, DocData>> = {}) {
  const stores = new Map<string, Map<string, DocData>>()
  for (const [coll, docs] of Object.entries(seed)) {
    stores.set(coll, new Map(Object.entries(docs)))
  }
  function pickStore(coll: string): Map<string, DocData> {
    if (!stores.has(coll)) stores.set(coll, new Map())
    return stores.get(coll)!
  }
  function makeDocRef(coll: string, id: string) {
    const store = pickStore(coll)
    return {
      _store: store,
      _id: id,
      id,
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
  function makeQuery(coll: string) {
    const filters: Array<[string, unknown]> = []
    let max = Number.POSITIVE_INFINITY
    const q = {
      doc(id: string) { return makeDocRef(coll, id) },
      add(data: DocData) {
        const store = pickStore(coll)
        const id = `auto_${store.size + 1}`
        store.set(id, { ...data })
        return Promise.resolve({ id })
      },
      where(field: string, _op: string, value: unknown) {
        filters.push([field, value])
        return q
      },
      orderBy() { return q },
      limit(n: number) { max = n; return q },
      async get() {
        const rows = [...pickStore(coll).entries()]
          .filter(([, d]) => filters.every(([f, v]) => nestedField(d, f) === v))
          .slice(0, max)
        const docs = rows.map(([id, data]) => ({ id, data: () => data, ref: makeDocRef(coll, id) }))
        return { docs, empty: docs.length === 0, size: docs.length }
      },
    }
    return q
  }
  const db = {
    collection(name: string) { return makeQuery(name) },
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      const t = {
        async get(ref: { get(): Promise<unknown> }) { return ref.get() },
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
  return { db, stores, pickStore }
}

function makeSendblueMock() {
  const sendCalls: Array<Record<string, unknown>> = []
  return {
    sendImessage: async (input: Record<string, unknown>) => {
      sendCalls.push(input)
      return {
        type: "message" as const,
        uuid: "uuid-evidence-1",
        message_handle: "uuid-evidence-1",
        status: "QUEUED",
        from_number: "+15557654321",
        number: String(input.to ?? ""),
        content: String(input.content ?? ""),
        service: "iMessage" as const,
        is_outbound: true as const,
      }
    },
    sendTypingIndicator: async () => {},
    get sendCalls() { return sendCalls },
  }
}

function makeEvent(docId: string, data: DocData) {
  const row = { runtimeApproved: true, runtimeSource: "test_runtime", ...data }
  return { params: { docId }, data: { data: () => row, id: docId } }
}

function pendingRow(toE164: string, extra: DocData = {}): DocData {
  return {
    status: "pending",
    userId: "u-1",
    toE164,
    body: "hey — found a couple of roles that look like a real fit for you",
    idempotencyKey: `out-evidence-${toE164}`,
    createdAt: new Date().toISOString(),
    runtimeApproved: true,
    runtimeSource: "test_runtime",
    ...extra,
  }
}

const NEVER_INBOUND = "+15550009999"
const HAS_INBOUND = "+15551230001"
const DEV_PHONE = "+14243201960"

function baseDeps(db: unknown, sb: ReturnType<typeof makeSendblueMock>, log: (...a: unknown[]) => void = () => {}) {
  return {
    db: db as never,
    sendblueClient: sb,
    now: () => new Date("2026-06-11T23:07:00.000Z"),
    log,
    getUser: async () => ({ id: "u-1" }) as never,
  }
}

beforeEach(() => {
  process.env.PA_TYPING_INDICATOR = "0"
  _resetPoolCache()
  _resetCountersCache()
  _resetPriorInboundEvidenceCache()
})
afterEach(() => {
  delete process.env.PA_TYPING_INDICATOR
  _resetPoolCache()
  _resetCountersCache()
  _resetPriorInboundEvidenceCache()
})

describe("RULE 1 — outbox prior-inbound evidence gate (2026-06-11 incident)", () => {
  it("BLOCKS a never-inbound recipient: blocked_no_inbound + ops review item, no POST", async () => {
    const row = pendingRow(NEVER_INBOUND)
    const { db, pickStore } = makeFakeDb({ "pa-outbound": { "doc-b1": row } })
    const sb = makeSendblueMock()
    const events: Array<{ event: string; payload: unknown }> = []
    await paSendblueOutboxHandler(
      makeEvent("doc-b1", row) as never,
      baseDeps(db, sb, (...args: unknown[]) => events.push({ event: String(args[0] ?? ""), payload: args[1] })) as never,
    )

    assert.equal(sb.sendCalls.length, 0, "Sendblue POST must NOT happen")
    const final = pickStore("pa-outbound").get("doc-b1")!
    assert.equal(final.status, "blocked_no_inbound")
    assert.match(String(final.error), /no prior inbound/)
    assert.ok(events.some((e) => e.event === "pa.outbox.blocked_no_inbound"), "pa.outbox.blocked_no_inbound logged")

    // Idempotent ops review item in the SAME HITL collection identity conflicts use.
    const reviews = [...pickStore("pa-candidate-identity-conflicts").values()]
    assert.equal(reviews.length, 1, "exactly one review item")
    assert.equal(reviews[0].kind, "outbound_blocked_no_inbound")
    assert.equal(reviews[0].status, "open")
    assert.equal(reviews[0].primaryCandidateId, "u-1")

    // Replay of a second blocked row for the same (userId, toE164) collapses onto ONE item.
    const row2 = pendingRow(NEVER_INBOUND, { idempotencyKey: "out-evidence-2" })
    pickStore("pa-outbound").set("doc-b2", row2)
    await paSendblueOutboxHandler(makeEvent("doc-b2", row2) as never, baseDeps(db, sb) as never)
    assert.equal(sb.sendCalls.length, 0)
    assert.equal([...pickStore("pa-candidate-identity-conflicts").values()].length, 1, "deterministic doc id — still one item")
  })

  it("ALLOWS a recipient with a pa-inbound-events row (rawPayload.participant == toE164)", async () => {
    const row = pendingRow(HAS_INBOUND)
    const { db, pickStore } = makeFakeDb({
      "pa-outbound": { "doc-a1": row },
      "pa-inbound-events": {
        inb_1: {
          userId: "u-1",
          createdAt: "2026-06-11T20:00:00.000Z",
          rawPayload: { kind: "imessage", participant: HAS_INBOUND, fromNumber: HAS_INBOUND, toNumber: "+17174919939" },
        },
      },
    })
    const sb = makeSendblueMock()
    await paSendblueOutboxHandler(makeEvent("doc-a1", row) as never, baseDeps(db, sb) as never)
    assert.equal(sb.sendCalls.length, 1, "send proceeds with inbound evidence")
    assert.equal(pickStore("pa-outbound").get("doc-a1")!.status, "sent")
    assert.equal([...pickStore("pa-candidate-identity-conflicts").values()].length, 0)
  })

  it("ALLOWS a dev phone with zero inbound evidence (standing authorization)", async () => {
    const row = pendingRow(DEV_PHONE)
    const { db, pickStore } = makeFakeDb({ "pa-outbound": { "doc-dev": row } })
    const sb = makeSendblueMock()
    await paSendblueOutboxHandler(makeEvent("doc-dev", row) as never, baseDeps(db, sb) as never)
    assert.equal(sb.sendCalls.length, 1, "dev phone always sendable")
    assert.equal(pickStore("pa-outbound").get("doc-dev")!.status, "sent")
  })

  it("ALLOWS runtimeSource pa_identity_notice with zero inbound evidence (direct same-thread reply)", async () => {
    const row = pendingRow(NEVER_INBOUND, { runtimeSource: "pa_identity_notice", idempotencyKey: "notice-1" })
    const { db, pickStore } = makeFakeDb({ "pa-outbound": { "doc-n1": row } })
    const sb = makeSendblueMock()
    await paSendblueOutboxHandler(makeEvent("doc-n1", row) as never, baseDeps(db, sb) as never)
    assert.equal(sb.sendCalls.length, 1, "identity notice replies into the thread the inbound just arrived from")
    assert.equal(pickStore("pa-outbound").get("doc-n1")!.status, "sent")
  })

  it("does NOT bypass for other runtime sources (pa_operator_review still gated)", async () => {
    const row = pendingRow(NEVER_INBOUND, { runtimeSource: "pa_operator_review", idempotencyKey: "op-1" })
    const { db, pickStore } = makeFakeDb({ "pa-outbound": { "doc-op": row } })
    const sb = makeSendblueMock()
    await paSendblueOutboxHandler(makeEvent("doc-op", row) as never, baseDeps(db, sb) as never)
    assert.equal(sb.sendCalls.length, 0)
    assert.equal(pickStore("pa-outbound").get("doc-op")!.status, "blocked_no_inbound")
  })
})
