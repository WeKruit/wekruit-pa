/**
 * Phase 60 (DEV-01) — `__PA_FIND_MATCH__` admin trigger detection tests.
 *
 * Mirrors the structure of webhook.test.ts (fake DB + signed payload) but
 * focuses on:
 *   1. token detection in normalized.text
 *   2. admin-allowlist enforcement via PA_ADMIN_USER_IDS env
 *   3. fire-and-forget invocation of generateJobRecsForUser
 *   4. dev_trigger_find_match audit event written
 *   5. NO broker enqueue when trigger fires (short-circuit path)
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"

import { handleSendblueWebhook } from "../webhook.js"
import { _clearFeatureFlagCache } from "@pa/pa-persistence"

const SECRET = "test-webhook-secret"
const ADMIN_PHONE = "+15551234567"
const ADMIN_USER_ID = "admin-user-uuid"
const NON_ADMIN_USER_ID = "non-admin-uuid"

// ---------- Fake Firestore ----------

type DocData = Record<string, unknown>

function makeFakeDb(opts: { phoneToUser?: Record<string, string> } = {}) {
  const inbound = new Map<string, DocData>()
  const audit: DocData[] = []
  const flags = new Map<string, DocData>()

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
    doc(id: string) {
      return genericDocRef(new Map(), id)
    },
  }
  const flagsCollection = { doc(id: string) { return genericDocRef(flags, id) } }
  const rawWebhookCollection = {
    add(_data: DocData) { return Promise.resolve({ id: "raw_1" }) },
  }
  const tapbackCollection = {
    add(_data: DocData) { return Promise.resolve({ id: "tap_1" }) },
  }
  const rateLimit = new Map<string, DocData>()
  const rateLimitCollection = {
    doc(id: string) { return genericDocRef(rateLimit, id) },
  }

  const collections: Record<string, unknown> = {
    "pa-inbound-events": inboundCollection,
    "pa-audit-events": auditCollection,
    "pa-feature-flags": flagsCollection,
    "pa-rate-limits": rateLimitCollection,
    "pa-rate-limit": rateLimitCollection,
    "pa-sendblue-webhook-raw": rawWebhookCollection,
    "pa-tapback-events": tapbackCollection,
    pa_inbound_events: inboundCollection,
    pa_audit_events: auditCollection,
    pa_feature_flags: flagsCollection,
    pa_rate_limit: rateLimitCollection,
  }

  const db = {
    collection(name: string) {
      const c = collections[name]
      if (!c) throw new Error(`unexpected collection: ${name}`)
      return c
    },
  } as unknown as Parameters<typeof handleSendblueWebhook>[2]["db"]

  // Phone→userId map used by lookupUserByPhone stub.
  const phoneToUser = opts.phoneToUser ?? {}

  return { db, inbound, audit, phoneToUser }
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
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name]
    },
  } as unknown as Parameters<typeof handleSendblueWebhook>[0]
}

function makeRes() {
  let statusCode = 200
  let bodyOut: unknown = null
  return {
    status(code: number) {
      statusCode = code
      return this
    },
    json(body: unknown) {
      bodyOut = body
      return this
    },
    send(body: unknown) {
      bodyOut = body
      return this
    },
    set() {
      return this
    },
    get statusCode() {
      return statusCode
    },
    get bodyOut() {
      return bodyOut
    },
  } as Parameters<typeof handleSendblueWebhook>[1] & { statusCode: number; bodyOut: unknown }
}

function basePayload(text: string) {
  return {
    content: text,
    from_number: ADMIN_PHONE,
    to_number: "+15557654321",
    message_handle: `msg-${Date.now()}-${Math.random()}`,
    date_sent: "2026-05-06T20:00:00.000Z",
    status: "RECEIVED",
    service: "iMessage",
  }
}

const ENV_KEYS = [
  "IMESSAGE_DM_ALLOWLIST",
  "IMESSAGE_PEERS",
  "IMESSAGE_PEER",
  "IMESSAGE_DEFAULT_PEER",
  "PA_ADMIN_USER_IDS",
] as const

let savedEnv: Record<string, string | undefined>

describe("__PA_FIND_MATCH__ admin trigger (Phase 60 DEV-01)", () => {
  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    for (const k of ENV_KEYS) delete process.env[k]
    process.env.IMESSAGE_DM_ALLOWLIST = "1"
    process.env.IMESSAGE_PEERS = ADMIN_PHONE
    _clearFeatureFlagCache()
  })
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) process.env[k] = v
    }
  })

  it("Test 1: admin user → trigger fires, audit dev_trigger_find_match, NO broker enqueue", async () => {
    process.env.PA_ADMIN_USER_IDS = ADMIN_USER_ID
    const { db, inbound, audit, phoneToUser } = makeFakeDb({
      phoneToUser: { [ADMIN_PHONE]: ADMIN_USER_ID },
    })
    const body = JSON.stringify(basePayload("__PA_FIND_MATCH__"))
    const req = makeReq(body, sign(body))
    const res = makeRes()

    let triggerCalled = false
    let triggerArgs: unknown = null
    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async (_db, phone) => phoneToUser[phone] ?? null,
      generateJobRecsForUser: async (args) => {
        triggerCalled = true
        triggerArgs = args
        return { ok: true, jobCount: 5 }
      },
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.bodyOut, { ok: true, action: "find_match_triggered" })
    // No broker enqueue — short-circuit path
    assert.equal(inbound.size, 0)
    // Audit row written
    assert.ok(audit.some((a) => a.type === "dev_trigger_find_match"))
    // Wait one tick for the fire-and-forget then assert handler called
    await new Promise((r) => setImmediate(r))
    assert.equal(triggerCalled, true)
    assert.deepEqual(triggerArgs, { userId: ADMIN_USER_ID, toE164: ADMIN_PHONE })
  })

  it("Test 2: non-admin user → trigger DOES NOT fire, audit find_match_unauthorized", async () => {
    process.env.PA_ADMIN_USER_IDS = "some-other-uuid"
    const { db, inbound, audit, phoneToUser } = makeFakeDb({
      phoneToUser: { [ADMIN_PHONE]: NON_ADMIN_USER_ID },
    })
    const body = JSON.stringify(basePayload("__PA_FIND_MATCH__"))
    const req = makeReq(body, sign(body))
    const res = makeRes()

    let triggerCalled = false
    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async (_db, phone) => phoneToUser[phone] ?? null,
      generateJobRecsForUser: async () => {
        triggerCalled = true
        return { ok: true, jobCount: 1 }
      },
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.bodyOut, { ok: true, ignored: "find_match_unauthorized" })
    assert.equal(inbound.size, 0)
    assert.equal(triggerCalled, false)
    // Audit logged the unauthorized attempt
    const denied = audit.find(
      (a) => a.type === "inbound_skipped" && a.reason === "find_match_unauthorized"
    )
    assert.ok(denied, "expected inbound_skipped/find_match_unauthorized audit")
  })

  it("Test 3: PA_ADMIN_USER_IDS unset → trigger blocked, no handler called", async () => {
    // Don't set PA_ADMIN_USER_IDS at all
    const { db, audit, phoneToUser } = makeFakeDb({
      phoneToUser: { [ADMIN_PHONE]: ADMIN_USER_ID },
    })
    const body = JSON.stringify(basePayload("__PA_FIND_MATCH__"))
    const req = makeReq(body, sign(body))
    const res = makeRes()

    let triggerCalled = false
    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async (_db, phone) => phoneToUser[phone] ?? null,
      generateJobRecsForUser: async () => {
        triggerCalled = true
        return { ok: true, jobCount: 0 }
      },
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.bodyOut, { ok: true, ignored: "find_match_unauthorized" })
    assert.equal(triggerCalled, false)
    assert.ok(audit.some((a) => a.reason === "find_match_unauthorized"))
  })

  it("Test 4: phone has no userId mapping → unauthorized", async () => {
    process.env.PA_ADMIN_USER_IDS = ADMIN_USER_ID
    const { db, audit } = makeFakeDb({ phoneToUser: {} })
    const body = JSON.stringify(basePayload("__PA_FIND_MATCH__"))
    const req = makeReq(body, sign(body))
    const res = makeRes()

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      // Phone lookup returns null — defensive null path
      lookupUserByPhone: async () => null,
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.bodyOut, { ok: true, ignored: "find_match_unauthorized" })
    assert.ok(audit.some((a) => a.reason === "find_match_unauthorized"))
  })

  it("Test 5: regular text (no token) → trigger does NOT short-circuit", async () => {
    process.env.PA_ADMIN_USER_IDS = ADMIN_USER_ID
    const { db, inbound, phoneToUser } = makeFakeDb({
      phoneToUser: { [ADMIN_PHONE]: ADMIN_USER_ID },
    })
    const body = JSON.stringify(basePayload("just a normal message"))
    const req = makeReq(body, sign(body))
    const res = makeRes()

    let triggerCalled = false
    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async (_db, phone) => phoneToUser[phone] ?? null,
      generateJobRecsForUser: async () => {
        triggerCalled = true
        return { ok: true, jobCount: 0 }
      },
    })

    assert.equal(res.statusCode, 200)
    assert.equal(triggerCalled, false)
    // Normal path: broker enqueued the inbound row
    assert.equal(inbound.size, 1)
  })

  it("Test 6: token with surrounding text → still triggers", async () => {
    process.env.PA_ADMIN_USER_IDS = ADMIN_USER_ID
    const { db, audit, phoneToUser } = makeFakeDb({
      phoneToUser: { [ADMIN_PHONE]: ADMIN_USER_ID },
    })
    const body = JSON.stringify(basePayload("hey __PA_FIND_MATCH__ now please"))
    const req = makeReq(body, sign(body))
    const res = makeRes()

    let triggerCalled = false
    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async (_db, phone) => phoneToUser[phone] ?? null,
      generateJobRecsForUser: async () => {
        triggerCalled = true
        return { ok: true, jobCount: 3 }
      },
    })

    await new Promise((r) => setImmediate(r))
    assert.equal(res.statusCode, 200)
    assert.equal(triggerCalled, true)
    assert.ok(audit.some((a) => a.type === "dev_trigger_find_match"))
  })

  it("Test 7: comma-separated PA_ADMIN_USER_IDS → all listed admins authorized", async () => {
    process.env.PA_ADMIN_USER_IDS = `${NON_ADMIN_USER_ID},${ADMIN_USER_ID},extra-admin`
    const { db, audit, phoneToUser } = makeFakeDb({
      phoneToUser: { [ADMIN_PHONE]: ADMIN_USER_ID },
    })
    const body = JSON.stringify(basePayload("__PA_FIND_MATCH__"))
    const req = makeReq(body, sign(body))
    const res = makeRes()

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async (_db, phone) => phoneToUser[phone] ?? null,
      generateJobRecsForUser: async () => ({ ok: true, jobCount: 1 }),
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.bodyOut, { ok: true, action: "find_match_triggered" })
    assert.ok(audit.some((a) => a.type === "dev_trigger_find_match"))
  })
})
