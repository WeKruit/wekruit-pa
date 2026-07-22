/**
 * Stream H9 TD3 — Sendblue delivery-confirmation webhook tests.
 *
 * Background: Sendblue posts inbound webhooks with `is_outbound: true`
 * to mirror outbound state transitions (SENT → DELIVERED, or → FAILED).
 * The previous handler logged an audit row but never persisted the new
 * sendblueStatus on the originating pa-outbound row, so dashboards had no
 * way to tell "Claire's reply was delivered" from "queued, vanished".
 *
 * Verifies:
 *  1. SENT → DELIVERED on the same handle → both update the SAME pa-outbound
 *     row (idempotent merge), latest status wins.
 *  2. FAILED → sendblueFailedAt timestamp recorded.
 *  3. Webhook with handle that maps to NO pa-outbound row → handler still
 *     returns 200 + audit row (no throw, no infinite retry).
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"

import { handleSendblueWebhook } from "../webhook.js"
import { _clearFeatureFlagCache } from "@pa/pa-persistence"

const SECRET = "test-webhook-secret"
type DocData = Record<string, unknown>

function makeFakeDb(initialOutbound: Record<string, DocData> = {}) {
  const inbound = new Map<string, DocData>()
  const audit: DocData[] = []
  const flags = new Map<string, DocData>()
  const rateLimit = new Map<string, DocData>()
  const tapbacks: DocData[] = []
  const outbound = new Map<string, DocData>(Object.entries(initialOutbound))
  const rawWebhook: DocData[] = []

  function genericDocRef(store: Map<string, DocData>, id: string) {
    return {
      _key: id,
      async get() {
        const data = store.get(id)
        return { exists: data !== undefined, data: () => data, id }
      },
      async set(data: DocData, options?: { merge?: boolean }) {
        if (options?.merge) store.set(id, { ...(store.get(id) ?? {}), ...data })
        else store.set(id, { ...data })
      },
      async update(data: DocData) {
        store.set(id, { ...(store.get(id) ?? {}), ...data })
      },
    }
  }

  function makeOutboundRef(id: string) {
    return {
      _key: id,
      async get() {
        const data = outbound.get(id)
        return { exists: data !== undefined, data: () => data, id }
      },
      async set(data: DocData, options?: { merge?: boolean }) {
        if (options?.merge) outbound.set(id, { ...(outbound.get(id) ?? {}), ...data })
        else outbound.set(id, { ...data })
      },
      // sms-fallback re-enqueue path (enqueueOutbound) uses ref.create().
      async create(data: DocData) {
        if (outbound.has(id)) {
          const err: Error & { code?: number } = new Error("ALREADY_EXISTS")
          err.code = 6
          throw err
        }
        outbound.set(id, { ...data })
      },
    }
  }

  const inboundCollection = {
    doc(id: string) {
      return {
        async create(data: DocData) {
          if (inbound.has(id)) {
            const err: Error & { code?: number } = new Error("ALREADY_EXISTS")
            err.code = 6
            throw err
          }
          inbound.set(id, { ...data })
        },
        async get() {
          const data = inbound.get(id)
          return { exists: data !== undefined, data: () => data, id }
        },
        async set(data: DocData, opts?: { merge?: boolean }) {
          if (opts?.merge) inbound.set(id, { ...(inbound.get(id) ?? {}), ...data })
          else inbound.set(id, { ...data })
        },
      }
    },
  }
  const auditCollection = {
    add(data: DocData) {
      audit.push({ ...data })
      return Promise.resolve({ id: `audit_${audit.length}` })
    },
    doc(id: string) { return genericDocRef(new Map(), id) },
  }
  const flagsCollection = { doc(id: string) { return genericDocRef(flags, id) } }
  const rateLimitCollection = { doc(id: string) { return genericDocRef(rateLimit, id) } }
  const rawWebhookCollection = {
    add(d: DocData) { rawWebhook.push(d); return Promise.resolve({ id: "raw_1" }) },
  }
  const tapbackCollection = {
    add(d: DocData) { tapbacks.push(d); return Promise.resolve({ id: `tap_${tapbacks.length}` }) },
  }
  const outboundCollection = {
    doc(id: string) { return makeOutboundRef(id) },
    where(field: string, op: string, val: unknown) {
      return {
        limit(_n: number) { return this },
        async get() {
          const matches = [...outbound.entries()]
            .filter(([, d]) => {
              if (field === "messageHandle" && op === "==") return d.messageHandle === val
              return false
            })
            .map(([id, d]) => ({ id, data: () => d, ref: makeOutboundRef(id) }))
          return { docs: matches, empty: matches.length === 0, size: matches.length }
        },
      }
    },
  }
  const collections: Record<string, unknown> = {
    "pa-inbound-events": inboundCollection,
    "pa-audit-events": auditCollection,
    "pa-feature-flags": flagsCollection,
    "pa-rate-limits": rateLimitCollection,
    "pa-rate-limit": rateLimitCollection,
    "pa-sendblue-webhook-raw": rawWebhookCollection,
    "pa-tapback-events": tapbackCollection,
    "pa-outbound": outboundCollection,
  }
  const db = {
    collection(name: string) {
      const c = collections[name]
      if (!c) throw new Error(`unexpected collection: ${name}`)
      return c
    },
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      const t = {
        async get(ref: { get(): Promise<unknown> }) { return ref.get() },
        update() {},
        set() {},
      }
      return fn(t)
    },
  } as unknown as Parameters<typeof handleSendblueWebhook>[2]["db"]

  return { db, inbound, audit, outbound }
}

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex")
}
function makeReq(body: string, signature: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "sendblue-signature": signature,
  }
  return {
    rawBody: Buffer.from(body, "utf8"),
    body,
    headers,
    method: "POST",
    header(name: string) { return headers[name.toLowerCase()] ?? headers[name] },
  } as unknown as Parameters<typeof handleSendblueWebhook>[0]
}
function makeRes() {
  let statusCode = 200
  let bodyOut: unknown = null
  return {
    status(code: number) { statusCode = code; return this },
    json(body: unknown) { bodyOut = body; return this },
    send(body: unknown) { bodyOut = body; return this },
    set() { return this },
    get statusCode() { return statusCode },
    get bodyOut() { return bodyOut },
  } as Parameters<typeof handleSendblueWebhook>[1] & { statusCode: number; bodyOut: unknown }
}

describe("Stream H9 TD3 — webhook updates pa-outbound on delivery confirmation", () => {
  beforeEach(() => { _clearFeatureFlagCache() })
  afterEach(() => { _clearFeatureFlagCache() })

  it("test 1: SENT → DELIVERED on same handle → SAME row updated, monotonic state", async () => {
    const HANDLE = "msg-h9-d3-1"
    const { db, outbound, audit } = makeFakeDb({
      "out-doc-1": {
        status: "sent",
        userId: "u-1",
        toE164: "+15551234567",
        body: "hi",
        messageHandle: HANDLE,
        sendblueStatus: "QUEUED",
      },
    })

    // Step 1: SENT webhook
    const sentBody = JSON.stringify({
      is_outbound: true,
      message_handle: HANDLE,
      status: "SENT",
      from_number: "+15557654321",
      number: "+15551234567",
    })
    const reqA = makeReq(sentBody, sign(sentBody))
    const resA = makeRes()
    await handleSendblueWebhook(reqA, resA, { db, secret: SECRET })
    assert.equal(resA.statusCode, 200)
    let r = outbound.get("out-doc-1")!
    assert.equal(r.sendblueStatus, "SENT", "first webhook flips to SENT")
    assert.equal(r.sendblueDeliveredAt, undefined, "no delivered timestamp on SENT")

    // Step 2: DELIVERED webhook on the SAME handle
    const delBody = JSON.stringify({
      is_outbound: true,
      message_handle: HANDLE,
      status: "DELIVERED",
      from_number: "+15557654321",
      number: "+15551234567",
    })
    const reqB = makeReq(delBody, sign(delBody))
    const resB = makeRes()
    await handleSendblueWebhook(reqB, resB, { db, secret: SECRET })
    assert.equal(resB.statusCode, 200)
    r = outbound.get("out-doc-1")!
    assert.equal(r.sendblueStatus, "DELIVERED", "second webhook advances to DELIVERED")
    assert.ok(r.sendblueDeliveredAt, "sendblueDeliveredAt is now set")
    assert.ok(typeof r.sendblueDeliveredAt === "string", "sendblueDeliveredAt is ISO string")

    // Audit rows: 2 outbound_mirror entries
    assert.equal(audit.filter((a) => a.type === "outbound_mirror").length, 2)
  })

  it("test 2: FAILED on outbound_mirror → sendblueFailedAt recorded", async () => {
    const HANDLE = "msg-h9-d3-2"
    const { db, outbound } = makeFakeDb({
      "out-doc-2": {
        status: "sent",
        userId: "u-2",
        toE164: "+15551234567",
        body: "fail-test",
        messageHandle: HANDLE,
        sendblueStatus: "QUEUED",
      },
    })
    const body = JSON.stringify({
      is_outbound: true,
      message_handle: HANDLE,
      status: "FAILED",
      from_number: "+15557654321",
      number: "+15551234567",
    })
    const req = makeReq(body, sign(body))
    const res = makeRes()
    await handleSendblueWebhook(req, res, { db, secret: SECRET })
    assert.equal(res.statusCode, 200)
    const r = outbound.get("out-doc-2")!
    assert.equal(r.sendblueStatus, "FAILED")
    assert.ok(r.sendblueFailedAt, "sendblueFailedAt timestamp recorded")
  })

  it("test 3: handle has no matching pa-outbound row → 200 + audit, no throw", async () => {
    const { db, outbound, audit } = makeFakeDb({}) // empty outbound
    const HANDLE = "msg-orphan"
    const body = JSON.stringify({
      is_outbound: true,
      message_handle: HANDLE,
      status: "DELIVERED",
      from_number: "+15557654321",
      number: "+15551234567",
    })
    const req = makeReq(body, sign(body))
    const res = makeRes()
    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200, "200 even when no row matches — Sendblue must NOT retry")
    assert.equal(outbound.size, 0, "no row created")
    assert.ok(audit.some((a) => a.type === "outbound_mirror"), "audit still recorded")
  })
})

// ── 2026-07-21 SMS fallback (Android/green-bubble): one-shot re-enqueue on delivery ERROR ──

describe("sms fallback on delivery ERROR", () => {
  beforeEach(() => {
    process.env.SENDBLUE_WEBHOOK_SECRET = SECRET
    _clearFeatureFlagCache()
  })
  afterEach(() => {
    delete process.env.SENDBLUE_WEBHOOK_SECRET
  })

  function errorBody(handle: string) {
    return JSON.stringify({
      is_outbound: true,
      message_handle: handle,
      status: "ERROR",
      service: "iMessage",
      was_downgraded: false,
      from_number: "+15557654321",
      number: "+15551234567",
    })
  }

  it("ERROR on a normal row → exactly one fallback row enqueued + smsFallbackAt stamped", async () => {
    const HANDLE = "msg-sms-fb-1"
    const { db, outbound } = makeFakeDb({
      "out-doc-1": {
        status: "sent",
        userId: "u-1",
        toE164: "+15551234567",
        body: "hey it's claire",
        idempotencyKey: "orig-key-1",
        messageHandle: HANDLE,
      },
    })
    const body = errorBody(HANDLE)
    const req = makeReq(body, sign(body))
    const res = makeRes()
    await handleSendblueWebhook(req, res, { db, secret: SECRET })
    assert.equal(res.statusCode, 200)

    const orig = outbound.get("out-doc-1")!
    assert.equal(orig.sendblueStatus, "ERROR")
    assert.equal(typeof orig.smsFallbackAt, "string", "one-shot stamp recorded")
    assert.equal(orig.sendblueService, "iMessage", "service telemetry recorded")

    const fallbackRows = [...outbound.entries()].filter(
      ([, d]) => d.runtimeSource === "sendblue_sms_fallback",
    )
    assert.equal(fallbackRows.length, 1, "exactly one fallback row")
    const [, fb] = fallbackRows[0]!
    assert.equal(fb.body, "hey it's claire")
    assert.equal(fb.userId, "u-1")
    assert.equal(fb.idempotencyKey, "orig-key-1:sms-fallback")
    assert.equal(fb.status, "pending")

    // Redelivered ERROR webhook → NO second fallback (smsFallbackAt guard).
    const res2 = makeRes()
    await handleSendblueWebhook(makeReq(body, sign(body)), res2, { db, secret: SECRET })
    const fallbackRows2 = [...outbound.entries()].filter(
      ([, d]) => d.runtimeSource === "sendblue_sms_fallback",
    )
    assert.equal(fallbackRows2.length, 1, "still exactly one fallback row")
  })

  it("ERROR on a row that IS a fallback → never chains a second fallback", async () => {
    const HANDLE = "msg-sms-fb-2"
    const { db, outbound } = makeFakeDb({
      "out-doc-fb": {
        status: "sent",
        userId: "u-1",
        toE164: "+15551234567",
        body: "hey it's claire",
        idempotencyKey: "orig-key-1:sms-fallback",
        runtimeSource: "sendblue_sms_fallback",
        messageHandle: HANDLE,
      },
    })
    const body = errorBody(HANDLE)
    const res = makeRes()
    await handleSendblueWebhook(makeReq(body, sign(body)), res, { db, secret: SECRET })
    assert.equal(res.statusCode, 200)
    assert.equal(outbound.size, 1, "no new rows — fallback of a fallback is forbidden")
  })

  it("DELIVERED with was_downgraded → green-bubble telemetry persisted, no fallback", async () => {
    const HANDLE = "msg-sms-fb-3"
    const { db, outbound } = makeFakeDb({
      "out-doc-1": {
        status: "sent",
        userId: "u-1",
        toE164: "+15551234567",
        body: "hi",
        idempotencyKey: "k1",
        messageHandle: HANDLE,
      },
    })
    const body = JSON.stringify({
      is_outbound: true,
      message_handle: HANDLE,
      status: "DELIVERED",
      service: "SMS",
      was_downgraded: true,
      from_number: "+15557654321",
      number: "+15551234567",
    })
    const res = makeRes()
    await handleSendblueWebhook(makeReq(body, sign(body)), res, { db, secret: SECRET })
    const r = outbound.get("out-doc-1")!
    assert.equal(r.sendblueService, "SMS")
    assert.equal(r.sendblueWasDowngraded, true)
    assert.equal(r.smsFallbackAt, undefined, "delivered → no fallback")
    assert.equal(outbound.size, 1)
  })
})
