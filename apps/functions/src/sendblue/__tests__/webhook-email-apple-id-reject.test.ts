/**
 * Identity hardening 2026-05-20 — webhook gates non-E.164 senders.
 *
 * REWORKED 2026-06-13 (switch-to-phone guidance): email-Apple-ID senders are no
 * longer rejected at all — replying INTO the email thread is allowed on the
 * inbound-only plan, so we send ONE guidance bubble back to the email handle
 * asking them to flip "Start New Conversations From" to their phone number. This
 * applies whether or not we can resolve their identity (identity is not needed
 * to reply to the thread that just texted us). The guidance dedup/STOP/resolved
 * cases are covered by `webhook-email-sender-resolution.test.ts`; this file
 * keeps the gate's boundary behavior:
 *
 *  1. `from_number: "user@icloud.com"` (unresolvable) → 200 OK, ONE switch-to-
 *     phone guidance reply enqueued to the email handle, no pitch/prescreen.
 *  2. `from_number: "+15551234567"` (E.164) → 200 OK accepted, gate not fired.
 *  3. `from_number: "1234"` (garbage / not E.164, not email) → 200 OK ignored,
 *     `non_e164_sender_rejected` audit recorded.
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
  const conflicts = new Map<string, DocData>()
  const guidance = new Map<string, DocData>()
  const outbound = new Map<string, DocData>()

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
      async create(data: DocData) {
        if (store.has(id)) {
          const err: Error & { code?: number } = new Error("ALREADY_EXISTS")
          err.code = 6
          throw err
        }
        store.set(id, { ...data })
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
    "pa-outbound": { doc(id: string) { return genericDocRef(outbound, id) }, where() { return { limit() { return this }, async get() { return { docs: [], empty: true, size: 0 } } } } },
    "pa-users": { doc(id: string) { return genericDocRef(new Map(), id) }, where() { return { limit() { return this }, async get() { return { docs: [], empty: true, size: 0 } } } } },
    "pa-candidate-handles": { doc(id: string) { return genericDocRef(new Map(), id) } },
    // Email-sender resolution 2026-06-11 — unresolved senders write an ops
    // review item here (idempotent, fail-soft).
    "pa-candidate-identity-conflicts": { doc(id: string) { return genericDocRef(conflicts, id) } },
    // Switch-to-phone guidance 2026-06-13 — dedup marker store.
    "pa-email-switch-guidance": { doc(id: string) { return genericDocRef(guidance, id) } },
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

  return { db, inbound, audit, conflicts, guidance, outbound }
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

  it("UNRESOLVABLE email-based Apple ID sender → switch-to-phone guidance into the email thread", async () => {
    const { db, audit, guidance, outbound } = makeFakeDb()
    const body = JSON.stringify({
      // Token "abc123" is too short for the opener parsers and nothing in the
      // fake db matches the email — every resolution arm misses. Guidance still
      // sends (identity is not needed to reply to the thread that texted us).
      content: "Hello, WeKruit! abc123",
      from_number: "alice@icloud.com",
      to_number: "+14243201960",
      message_handle: "msg-email-apple-1",
      date_sent: "2026-06-13T10:00:00Z",
      status: "RECEIVED",
      service: "iMessage",
    })
    const req = makeReq(body, sign(body))
    const res = makeRes()
    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200, "200 OK so Sendblue doesn't retry")
    const bodyOut = res.bodyOut as { ok: boolean; ignored?: string }
    assert.equal(bodyOut.ignored, "email_sender_switch_guidance_sent", "guidance, not silence")
    const sends = [...outbound.values()]
    assert.equal(sends.length, 1, "exactly one guidance reply enqueued")
    assert.equal(sends[0]!.toE164, "alice@icloud.com", "reply goes to the email handle")
    assert.equal(sends[0]!.runtimeSource, "pa_identity_notice")
    assert.equal(guidance.size, 1, "dedup marker stamped")
    const sent = audit.filter((a) => a.type === "email_sender_switch_guidance_sent")
    assert.equal(sent.length, 1, "guidance-sent audit recorded")
    assert.equal(sent[0]!.fromNumber, "alice@icloud.com", "audit preserves raw sender for forensics")
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
    // (broker enqueue, trigger routing, etc.) is covered by other test files;
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
