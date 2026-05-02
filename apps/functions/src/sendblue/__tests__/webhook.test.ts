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
  const tapbacks: DocData[] = []

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
        // Stream H9 TD1 — webhook now writes Timestamp expiresAtTs after broker
        // enqueue via .set({merge:true}). Harness must accept it so the
        // non-fatal log path doesn't trip and noise the test output.
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
  const rateLimitCollection = { doc(id: string) { return genericDocRef(rateLimit, id) } }
  // Phase 33 — accept fire-and-forget writes from logRawWebhook without
  // shape constraints; tests don't assert on contents.
  const rawWebhookCollection = {
    add(_data: DocData) { return Promise.resolve({ id: "raw_1" }) },
  }
  const tapbackCollection = {
    add(data: DocData) {
      tapbacks.push({ ...data })
      return Promise.resolve({ id: `tap_${tapbacks.length}` })
    },
  }
  const collections: Record<string, unknown> = {
    // Phase 23+ kebab-case migration. Old snake-case keys retained as
    // aliases so any stale code path during transition still resolves.
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

  return { db, inbound, audit, flags, rateLimit, tapbacks }
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

  it("Test 8: empty content AND no media_url → 200, NO inbound (matches macOS worker [dm] empty; skip)", async () => {
    const { db, inbound } = makeFakeDb()
    // Explicit: no media_url. Skip-empty rule still applies.
    const body = JSON.stringify({ ...basePayload(), content: "" })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 0)
  })

  it("Test 8b (BUG #6): empty content + media_url → 200, ONE inbound row with mediaUrl + attachmentReceived in rawPayload", async () => {
    const { db, inbound } = makeFakeDb()
    const mediaUrl = "https://storage.googleapis.com/inbound-file-store/test-resume.pdf"
    const body = JSON.stringify({ ...basePayload(), content: "", media_url: mediaUrl })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200, "empty content with media_url MUST NOT skip — that was BUG #6")
    assert.equal(inbound.size, 1, "attachment-only message must enqueue a single inbound row")
    const [doc] = [...inbound.values()]
    assert.ok(doc)
    assert.equal(doc!.idempotencyKey, "sendblue-msg-abc-123")
    assert.equal(doc!.channel, "imessage")
    const raw = doc!.rawPayload as Record<string, unknown>
    assert.equal(raw.mediaUrl, mediaUrl)
    assert.equal(raw.attachmentReceived, true)
    assert.equal(raw.text, "[attachment]")
  })

  it("Test 8d (Stream D): media_url → 200 + inbound enqueued + sendReaction(love) called once + ingestCv called once with resolved userId", async () => {
    const { db, inbound } = makeFakeDb()
    const mediaUrl = "https://storage.googleapis.com/inbound-file-store/test-cv.pdf"
    const body = JSON.stringify({ ...basePayload(), content: "", media_url: mediaUrl })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    const reactionCalls: Array<{ to: string; messageHandle: string; reaction: string }> = []
    const ingestCalls: Array<{ userId: string; mediaUrl: string; sessionId?: string }> = []

    const sendReactionMock = async (input: { to: string; messageHandle: string; reaction: string }) => {
      reactionCalls.push({ to: input.to, messageHandle: input.messageHandle, reaction: input.reaction })
      return { status: "ok" }
    }
    const ingestCvMock = async (input: { userId: string; mediaUrl: string; sessionId?: string }) => {
      ingestCalls.push({ userId: input.userId, mediaUrl: input.mediaUrl, sessionId: input.sessionId })
      return { ok: true as const, resumeId: "rsm_test_1" }
    }
    const lookupMock = async (_db: unknown, phone: string) => {
      return phone === "+15551234567" ? "user_adam_test" : null
    }

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      sendReaction: sendReactionMock,
      ingestCv: ingestCvMock,
      lookupUserByPhone: lookupMock,
    })

    // Reply path is unchanged — 200 + one inbound row.
    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 1)

    // Both side-effects are fire-and-forget; let the microtask queue settle
    // before asserting on the mock state.
    await new Promise((r) => setTimeout(r, 20))

    // D2: tapback ❤️ fired exactly once.
    assert.equal(reactionCalls.length, 1, "sendReaction must be called exactly once on media_url receipt")
    assert.equal(reactionCalls[0]!.to, "+15551234567")
    assert.equal(reactionCalls[0]!.messageHandle, "msg-abc-123")
    assert.equal(reactionCalls[0]!.reaction, "love")

    // D4: ingestCv fired with resolved userId.
    assert.equal(ingestCalls.length, 1, "ingestCv must be called exactly once on media_url receipt with a resolvable user")
    assert.equal(ingestCalls[0]!.userId, "user_adam_test")
    assert.equal(ingestCalls[0]!.mediaUrl, mediaUrl)
  })

  it("Test 8e (Stream D): text-only inbound (no media_url) → no sendReaction, no ingestCv", async () => {
    const { db } = makeFakeDb()
    const body = JSON.stringify(basePayload())
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    let reactionCount = 0
    let ingestCount = 0
    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      sendReaction: async () => { reactionCount++; return {} },
      ingestCv: async () => { ingestCount++; return { ok: false as const, reason: "test" } },
      lookupUserByPhone: async () => "user_adam_test",
    })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(res.statusCode, 200)
    assert.equal(reactionCount, 0, "no media_url → no reaction")
    assert.equal(ingestCount, 0, "no media_url → no ingest")
  })

  it("Test 8c (tapback inbound): Loved \"...\" → still enqueues inbound + writes pa-tapback-events row", async () => {
    const { db, inbound, tapbacks } = makeFakeDb()
    const body = JSON.stringify({ ...basePayload(), content: "Loved “Career check-in tomorrow?”" })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    // Normal inbound still flows through so Claire can acknowledge in chat.
    assert.equal(inbound.size, 1)
    // Plus a tapback-events row for the matching pipeline.
    assert.equal(tapbacks.length, 1)
    const tap = tapbacks[0]!
    assert.equal(tap.kind, "love")
    assert.equal(tap.quotedText, "Career check-in tomorrow?")
    assert.equal(tap.sourceMessageHandle, "msg-abc-123")
    assert.equal(tap.userId, "+15551234567")
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

  // Phase 33 — Regression lock for the 2026-04-28 incident: Sendblue's
  // production webhook header is `sb-signing-secret` carrying the configured
  // shared secret value verbatim. The verifier MUST accept this format.
  it("Test 12 (Phase 33 regression lock): real Sendblue sb-signing-secret header → 200 + enqueued", async () => {
    const { db, inbound } = makeFakeDb()
    const body = JSON.stringify(basePayload({ message_handle: "msg-real-sendblue" }))
    const req = makeReq({ body, signature: SECRET, signatureHeader: "sb-signing-secret" })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200, "real Sendblue header must be accepted post-fix")
    assert.equal(inbound.size, 1)
  })

  // Phase 33 — every delivery hits pa-sendblue-webhook-raw BEFORE verify.
  // Even on 401, the raw payload is preserved for replay.
  it("Test 13 (Phase 33): raw-payload log written even when HMAC verify fails", async () => {
    const captured: Array<Record<string, unknown>> = []
    const { db } = makeFakeDb()
    // Tap the raw collection by overlaying a custom add() that captures rows.
    const origCollection = (db as { collection(name: string): unknown }).collection
    ;(db as { collection(name: string): unknown }).collection = (name: string) => {
      if (name === "pa-sendblue-webhook-raw") {
        return {
          add(row: Record<string, unknown>) {
            captured.push(row)
            return Promise.resolve({ id: `raw_${captured.length}` })
          },
        }
      }
      return origCollection.call(db, name)
    }
    const body = JSON.stringify(basePayload())
    const req = makeReq({ body, signature: "wrong-secret", signatureHeader: "sb-signing-secret" })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 401, "wrong secret must still reject")
    // Allow ms for the fire-and-forget write to land.
    await new Promise((r) => setTimeout(r, 20))
    assert.ok(captured.length >= 1, "raw payload must be logged even on 401")
    assert.equal(typeof captured[0]?.bodyText, "string")
  })

  // Stream G4a — synthetic-webhook marker tests.
  it("Test 14 (Stream G4a): X-E2E-Test:1 → rawMeta.e2eTest=true on raw row + rawPayload.e2eTest=true on inbound + allowlist bypassed for non-allowlisted from_number", async () => {
    // Sender NOT in allowlist — proves the test header bypasses the gate.
    setEnvAllowlist(["+15559999999"])
    const captured: Array<Record<string, unknown>> = []
    const { db, inbound } = makeFakeDb()
    const origCollection = (db as { collection(name: string): unknown }).collection
    ;(db as { collection(name: string): unknown }).collection = (name: string) => {
      if (name === "pa-sendblue-webhook-raw") {
        return {
          add(row: Record<string, unknown>) {
            captured.push(row)
            return Promise.resolve({ id: `raw_${captured.length}` })
          },
        }
      }
      return origCollection.call(db, name)
    }
    const body = JSON.stringify(basePayload({ message_handle: "msg-e2e-1" }))
    const req = makeReq({ body, signature: SECRET, headers: { "x-e2e-test": "1" } })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200, "X-E2E-Test:1 must NOT trigger allowlist_deny")
    assert.equal(inbound.size, 1, "synthetic test must enqueue inbound (allowlist bypassed)")

    // Allow microtask for fire-and-forget raw log.
    await new Promise((r) => setTimeout(r, 20))
    assert.ok(captured.length >= 1, "raw payload row must be written")
    const rawRow = captured[0]!
    assert.equal((rawRow.rawMeta as { e2eTest?: boolean } | undefined)?.e2eTest, true,
      "rawMeta.e2eTest=true must be present when X-E2E-Test header is set")

    const inboundDoc = [...inbound.values()][0]!
    const raw = inboundDoc.rawPayload as Record<string, unknown>
    assert.equal(raw.e2eTest, true, "inbound rawPayload.e2eTest=true must be present")
  })

  it("Test 15 (Stream G4a): no X-E2E-Test header → no e2eTest field anywhere (regression lock)", async () => {
    const captured: Array<Record<string, unknown>> = []
    const { db, inbound } = makeFakeDb()
    const origCollection = (db as { collection(name: string): unknown }).collection
    ;(db as { collection(name: string): unknown }).collection = (name: string) => {
      if (name === "pa-sendblue-webhook-raw") {
        return {
          add(row: Record<string, unknown>) {
            captured.push(row)
            return Promise.resolve({ id: `raw_${captured.length}` })
          },
        }
      }
      return origCollection.call(db, name)
    }
    const body = JSON.stringify(basePayload({ message_handle: "msg-organic-1" }))
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 1)
    await new Promise((r) => setTimeout(r, 20))
    assert.ok(captured.length >= 1)
    const rawRow = captured[0]!
    assert.equal(rawRow.rawMeta, undefined,
      "organic traffic must NOT have rawMeta field — backward compat with existing analytics")

    const inboundDoc = [...inbound.values()][0]!
    const raw = inboundDoc.rawPayload as Record<string, unknown>
    assert.equal(raw.e2eTest, undefined,
      "organic traffic must NOT have rawPayload.e2eTest field")
  })

})
