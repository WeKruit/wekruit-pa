import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"

import { handleSendblueWebhook } from "../webhook.js"
import type { SendblueInboundPayload } from "../types.js"
import { _clearFeatureFlagCache } from "@pa/pa-persistence"

const SECRET = "test-webhook-secret"

// ---------- Fake Firestore + broker harness ----------

type DocData = Record<string, unknown>

function makeFakeDb(opts: { rateLimitFlag?: boolean } = {}) {
  const inbound = new Map<string, DocData>()
  const audit: DocData[] = []
  const flags = new Map<string, DocData>()
  const rateLimit = new Map<string, DocData>()

  if (opts.rateLimitFlag) {
    flags.set("paRateLimitPerUserEnabled", {
      key: "paRateLimitPerUserEnabled",
      value: true,
      type: "bool",
      scope: "perUser",
      allowlist: [],
      blocklist: [],
    })
  }

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

  const collections: Record<string, unknown> = {
    pa_inbound_events: {
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
        }
      },
    },
    pa_audit_events: {
      add(data: DocData) {
        audit.push({ ...data })
        return Promise.resolve({ id: `audit_${audit.length}` })
      },
      doc(id: string) {
        return genericDocRef(new Map(), id)
      },
    },
    pa_feature_flags: {
      doc(id: string) {
        return genericDocRef(flags, id)
      },
    },
    pa_rate_limit: {
      doc(id: string) {
        return genericDocRef(rateLimit, id)
      },
    },
  }

  const db = {
    collection(name: string) {
      const c = collections[name]
      if (!c) throw new Error(`unexpected collection: ${name}`)
      return c
    },
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      const t = {
        async get(ref: { get(): Promise<unknown> }) {
          return ref.get()
        },
        update(ref: { _key: string }, data: DocData) {
          rateLimit.set(ref._key, { ...(rateLimit.get(ref._key) ?? {}), ...data })
        },
        set(ref: { _key: string }, data: DocData) {
          rateLimit.set(ref._key, { ...data })
        },
      }
      return fn(t)
    },
  } as unknown as Parameters<typeof handleSendblueWebhook>[2]["db"]

  return { db, inbound, audit, flags, rateLimit }
}

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex")
}

function makeReq(opts: {
  body: string
  signature?: string
  signatureHeader?: string
  headers?: Record<string, string>
}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(opts.signature ? { [opts.signatureHeader ?? "sendblue-signature"]: opts.signature } : {}),
    ...(opts.headers ?? {}),
  }
  return {
    rawBody: Buffer.from(opts.body, "utf8"),
    body: opts.body,
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

const ENV_KEYS = [
  "IMESSAGE_DM_ALLOWLIST",
  "IMESSAGE_PEERS",
  "IMESSAGE_PEER",
  "IMESSAGE_DEFAULT_PEER",
] as const

let savedEnv: Record<string, string | undefined>

function setEnvAllowlist(peers: string[], enable = true) {
  process.env.IMESSAGE_DM_ALLOWLIST = enable ? "1" : "0"
  process.env.IMESSAGE_PEERS = peers.join(",")
}

function basePayload(overrides: Partial<SendblueInboundPayload> = {}): SendblueInboundPayload {
  return {
    content: "hello sendblue",
    from_number: "+15551234567",
    to_number: "+15557654321",
    message_handle: "msg-abc-123",
    date_sent: "2026-04-27T20:00:00.000Z",
    status: "RECEIVED",
    service: "iMessage",
    ...overrides,
  }
}

// ---------- Tests ----------

describe("handleSendblueWebhook", () => {
  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    for (const k of ENV_KEYS) delete process.env[k]
    setEnvAllowlist(["+15551234567"])
    _clearFeatureFlagCache()
  })
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) process.env[k] = v
    }
  })

  it("Test 1: invalid HMAC → 401, no inbound event, no audit record", async () => {
    const { db, inbound, audit } = makeFakeDb()
    const body = JSON.stringify(basePayload())
    const req = makeReq({ body, signature: "deadbeef" })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 401)
    assert.equal(inbound.size, 0)
    assert.equal(audit.length, 0)
  })

  it("Test 2: valid HMAC + non-allowlisted from_number → 200, NO inbound, ONE audit allowlist_deny", async () => {
    setEnvAllowlist(["+15559999999"]) // Adam allowed; sender NOT
    const { db, inbound, audit } = makeFakeDb()
    const body = JSON.stringify(basePayload())
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 0)
    assert.equal(audit.length, 1)
    assert.equal(audit[0]!.type, "allowlist_deny")
    assert.equal(audit[0]!.channel, "imessage_sendblue")
    assert.equal(audit[0]!.fromNumber, "+15551234567")
  })

  it("Test 3: valid HMAC + allowlisted + receive → 200, ONE inbound row keyed sendblue-${message_handle}", async () => {
    const { db, inbound } = makeFakeDb()
    const body = JSON.stringify(basePayload())
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 1)
    const [doc] = [...inbound.values()]
    assert.ok(doc)
    assert.equal(doc!.idempotencyKey, "sendblue-msg-abc-123")
    assert.equal(doc!.channel, "imessage")
    assert.equal(doc!.status, "pending")
  })

  it("Test 4: same message_handle posted twice → exactly ONE inbound row (broker idempotency)", async () => {
    const { db, inbound } = makeFakeDb()
    const body = JSON.stringify(basePayload())
    const req1 = makeReq({ body, signature: SECRET })
    const res1 = makeRes()
    await handleSendblueWebhook(req1, res1, { db, secret: SECRET })

    const req2 = makeReq({ body, signature: SECRET })
    const res2 = makeRes()
    await handleSendblueWebhook(req2, res2, { db, secret: SECRET })

    assert.equal(res1.statusCode, 200)
    assert.equal(res2.statusCode, 200)
    assert.equal(inbound.size, 1)
  })

  it("Test 5: outbound event (is_outbound=true) → 200, NO inbound, audit outbound_mirror", async () => {
    const { db, inbound, audit } = makeFakeDb()
    const payload = { ...basePayload(), is_outbound: true }
    const body = JSON.stringify(payload)
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 0)
    assert.ok(audit.some((a) => a.type === "outbound_mirror"))
  })

  it("Test 6: typing_indicator / line_blocked event → 200, NO inbound, audit log only", async () => {
    const { db, inbound, audit } = makeFakeDb()
    // Synthetic typing payload (no message_handle, no content)
    const body = JSON.stringify({ type: "typing_indicator", number: "+15551234567" })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 0)
    assert.ok(audit.length >= 1)
  })

  it("Test 7: group_id non-empty → 200, NO inbound, audit group_chat_rejected (Q-03 lock)", async () => {
    const { db, inbound, audit } = makeFakeDb()
    const body = JSON.stringify({ ...basePayload(), group_id: "g-abc" })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 0)
    assert.ok(audit.some((a) => a.type === "group_chat_rejected"))
  })

  it("Test 8: empty content → 200, NO inbound (matches macOS worker [dm] empty; skip)", async () => {
    const { db, inbound } = makeFakeDb()
    const body = JSON.stringify({ ...basePayload(), content: "" })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 0)
  })

  it("Test 9: malformed JSON body (with valid HMAC) → 400 Bad Request", async () => {
    const { db, inbound } = makeFakeDb()
    const body = "{not-json"
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 400)
    assert.equal(inbound.size, 0)
  })

  it("Test 11 (Phase 26 T1): rate-limit flag enabled → 21st message in window returns 429", async () => {
    const { db, inbound, audit } = makeFakeDb({ rateLimitFlag: true })
    let lastStatus = 200
    for (let i = 0; i < 21; i++) {
      const body = JSON.stringify(basePayload({ message_handle: `msg-rl-${i}` }))
      const req = makeReq({ body, signature: SECRET })
      const res = makeRes()
      await handleSendblueWebhook(req, res, { db, secret: SECRET })
      lastStatus = res.statusCode
    }
    assert.equal(lastStatus, 429)
    // First 20 enqueued; 21st rejected → exactly 20 inbound rows.
    assert.equal(inbound.size, 20)
    assert.ok(audit.some((a) => a.type === "rate_limit_exceeded"))
  })

  it("Test 10: signature header alias sb-signature also accepted", async () => {
    // Sendblue auth is plaintext shared-secret compare (not HMAC-over-body)
    // per hmac.ts line 5-6 + verifier rewrite 2026-04-27. The signature
    // header carries the SECRET itself, not a hash of the body.
    const { db, inbound } = makeFakeDb()
    const body = JSON.stringify(basePayload())
    const req = makeReq({ body, signature: SECRET, signatureHeader: "sb-signature" })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 1)
  })
})
