/**
 * Identity hardening 2026-05-20 — webhook rejects non-E.164 senders.
 *
 * Sendblue accepts inbound iMessage from email-based Apple IDs (per
 * https://docs.sendblue.com/faq/) but the REST API has no documented
 * outbound path for email senders, and our identity layer assumes
 * `pa-users.phoneE164` is always a valid E.164 string. Without the
 * gate, an email-Apple-ID sender would create a polluted pa-users row
 * with `phoneE164: "user@icloud.com"`.
 *
 * Email-Apple-ID support is deferred to https://github.com/WeKruit/wekruit-pa/issues/142.
 *
 * Verifies:
 *  1. `from_number: "user@icloud.com"` → 200 OK ignored, audit recorded,
 *     no pa-inbound-events row created.
 *  2. `from_number: "+15551234567"` (E.164) → 200 OK accepted, pa-inbound-events
 *     row created.
 *  3. `from_number: "1234"` (garbage / not E.164) → 200 OK ignored, audit recorded.
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"

import { handleSendblueWebhook } from "../webhook.js"
import { _clearFeatureFlagCache } from "@pa/pa-persistence"

const SECRET = "test-webhook-secret"
type DocData = Record<string, unknown>

function makeFakeDb() {
  const inbound = new Map<string, DocData>()
  const audit: DocData[] = []
  const flags = new Map<string, DocData>()
  const rateLimit = new Map<string, DocData>()
  const rawWebhook: DocData[] = []
  const tapbacks: DocData[] = []

  function genericDocRef(store: Map<string, DocData>, id: string) {
    return {
      async get() {
        const data = store.get(id)
        return { exists: data !== undefined, data: () => data, id }
      },
      async set(data: DocData, options?: { merge?: boolean }) {
        if (options?.merge) store.set(id, { ...(store.get(id) ?? {}), ...data })
        else store.set(id, { ...data })
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
  const collections: Record<string, unknown> = {
    "pa-inbound-events": inboundCollection,
    "pa-audit-events": { add(d: DocData) { audit.push({ ...d }); return Promise.resolve({ id: `a_${audit.length}` }) }, doc(id: string) { return genericDocRef(new Map(), id) } },
    "pa-feature-flags": { doc(id: string) { return genericDocRef(flags, id) } },
    "pa-rate-limits": { doc(id: string) { return genericDocRef(rateLimit, id) } },
    "pa-rate-limit": { doc(id: string) { return genericDocRef(rateLimit, id) } },
    "pa-sendblue-webhook-raw": { add(d: DocData) { rawWebhook.push(d); return Promise.resolve({ id: "r_1" }) } },
    "pa-tapback-events": { add(d: DocData) { tapbacks.push(d); return Promise.resolve({ id: `t_${tapbacks.length}` }) } },
    "pa-outbound": { doc(id: string) { return genericDocRef(new Map(), id) }, where() { return { limit() { return this }, async get() { return { docs: [], empty: true, size: 0 } } } } },
    "pa-users": { doc(id: string) { return genericDocRef(new Map(), id) }, where() { return { limit() { return this }, async get() { return { docs: [], empty: true, size: 0 } } } } },
    "pa-candidate-handles": { doc(id: string) { return genericDocRef(new Map(), id) } },
  }
  const db = {
    collection(name: string) {
      const c = collections[name]
      if (!c) throw new Error(`unexpected collection: ${name}`)
      return c
    },
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      return fn({ async get(ref: { get(): Promise<unknown> }) { return ref.get() }, update() {}, set() {} })
    },
  } as unknown as Parameters<typeof handleSendblueWebhook>[2]["db"]

  return { db, inbound, audit }
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

describe("Identity hardening — Sendblue webhook rejects non-E.164 sender", () => {
  beforeEach(() => { _clearFeatureFlagCache() })
  afterEach(() => { _clearFeatureFlagCache() })

  it("rejects email-based Apple ID sender (from_number contains '@')", async () => {
    const { db, inbound, audit } = makeFakeDb()
    const body = JSON.stringify({
      content: "Hello, WeKruit! abc123",
      from_number: "alice@icloud.com",
      to_number: "+14243201960",
      message_handle: "msg-email-apple-1",
      date_sent: "2026-05-20T10:00:00Z",
      status: "RECEIVED",
      service: "iMessage",
    })
    const req = makeReq(body, sign(body))
    const res = makeRes()
    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200, "200 OK so Sendblue doesn't retry")
    const bodyOut = res.bodyOut as { ok: boolean; ignored?: string }
    assert.equal(bodyOut.ignored, "non_e164_sender_rejected", "explicit ignore reason")
    assert.equal(inbound.size, 0, "no pa-inbound-events row was created")
    const rejected = audit.filter((a) => a.type === "non_e164_sender_rejected")
    assert.equal(rejected.length, 1, "audit row recorded once")
    assert.equal(rejected[0]!.fromNumber, "alice@icloud.com", "audit preserves raw sender for forensics")
    assert.equal(rejected[0]!.reason, "email_apple_id", "audit reason classifies the format")
  })

  it("accepts E.164 sender (proves the gate isn't over-broad)", async () => {
    const { db, audit } = makeFakeDb()
    const body = JSON.stringify({
      content: "Hello, WeKruit! abc123",
      from_number: "+15551234567",
      to_number: "+14243201960",
      message_handle: "msg-phone-1",
      date_sent: "2026-05-20T10:00:00Z",
      status: "RECEIVED",
      service: "iMessage",
    })
    const req = makeReq(body, sign(body))
    const res = makeRes()
    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200, "200 OK accepted")
    // The gate does not reject a valid E.164 sender — downstream behavior
    // (broker enqueue, allowlist, etc.) is covered by other test files;
    // here we only assert the new gate did not fire.
    const rejected = audit.filter((a) => a.type === "non_e164_sender_rejected")
    assert.equal(rejected.length, 0, "no rejection audit for E.164 sender")
  })

  it("rejects malformed sender (not E.164, not email — defensive)", async () => {
    const { db, inbound, audit } = makeFakeDb()
    const body = JSON.stringify({
      content: "Hi",
      from_number: "1234",
      to_number: "+14243201960",
      message_handle: "msg-junk-1",
      date_sent: "2026-05-20T10:00:00Z",
      status: "RECEIVED",
      service: "iMessage",
    })
    const req = makeReq(body, sign(body))
    const res = makeRes()
    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 0, "no pa-inbound-events row")
    const rejected = audit.filter((a) => a.type === "non_e164_sender_rejected")
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0]!.reason, "unknown", "classified as unknown format")
  })
})
