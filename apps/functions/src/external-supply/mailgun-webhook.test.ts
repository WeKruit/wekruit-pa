/**
 * Tests for the Mailgun webhook handler. Mirrors the Instantly webhook
 * idempotency + signature verify scenarios but consumes Mailgun's
 * `event-data` payload shape and verifies the new event-kind mapping.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { createHmac } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  handleMailgunWebhook,
  verifyMailgunSignature,
  type MailgunWebhookBody,
  type MailgunWebhookRequest,
  type MailgunWebhookResponse,
} from "./mailgun-webhook.js"

const NOW = "2026-05-14T13:00:00.000Z"

// ---------------------------------------------------------------------------
// In-memory Firestore fake
// ---------------------------------------------------------------------------

type Store = Map<string, Map<string, Record<string, unknown>>>

function makeStore(): Store {
  return new Map(Object.values(PA_COLLECTIONS).map((name) => [name, new Map()]))
}

function ensureCol(store: Store, name: string): Map<string, Record<string, unknown>> {
  let col = store.get(name)
  if (!col) {
    col = new Map()
    store.set(name, col)
  }
  return col
}

function makeFakeDb(store: Store): Firestore {
  const collection = (name: string) => {
    const col = ensureCol(store, name)
    const filters: Array<[string, string, unknown]> = []
    const builder = {
      doc(id: string) {
        return {
          async get() {
            const data = col.get(id)
            return { exists: data !== undefined, data: () => data }
          },
          async set(value: Record<string, unknown>, opts?: { merge?: boolean }) {
            const prior = col.get(id) ?? {}
            col.set(id, opts?.merge ? { ...prior, ...value } : value)
          },
        }
      },
      where(field: string, op: string, value: unknown) {
        filters.push([field, op, value])
        return builder
      },
      limit(_n: number) {
        return builder
      },
      orderBy(_f: string, _d?: string) {
        return builder
      },
      async get() {
        const docs: Array<{ data(): Record<string, unknown> }> = []
        for (const [, row] of col.entries()) {
          const match = filters.every(([f, op, v]) => {
            const left = (row as Record<string, unknown>)[f]
            return op === "==" ? left === v : true
          })
          if (match) docs.push({ data: () => row })
        }
        return { empty: docs.length === 0, docs }
      },
    }
    return builder
  }
  return { collection } as unknown as Firestore
}

// ---------------------------------------------------------------------------
// Response capture
// ---------------------------------------------------------------------------

interface Captured {
  status: number
  body: unknown
}

function makeRes(captured: Captured): MailgunWebhookResponse {
  const res: MailgunWebhookResponse = {
    status: (code) => {
      captured.status = code
      return {
        json: (b) => {
          captured.body = b
        },
        send: (b) => {
          captured.body = b
        },
      }
    },
    json: (b) => {
      captured.body = b
    },
    send: (b) => {
      captured.body = b
    },
  }
  return res
}

function makeReq(body: MailgunWebhookBody, method = "POST"): MailgunWebhookRequest {
  return {
    method,
    headers: {},
    body,
    rawBody: Buffer.from(JSON.stringify(body)),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("rejects non-POST requests with 405", async () => {
  const store = makeStore()
  const captured: Captured = { status: 0, body: null }
  await handleMailgunWebhook(
    { method: "GET", headers: {}, body: {} },
    makeRes(captured),
    { db: makeFakeDb(store), signingKey: "", now: () => NOW },
  )
  assert.equal(captured.status, 405)
})

test("returns 200 ignored for unmapped event types", async () => {
  const store = makeStore()
  const captured: Captured = { status: 0, body: null }
  await handleMailgunWebhook(
    makeReq({ "event-data": { event: "list_unsubscribed", id: "evt-1" } }),
    makeRes(captured),
    { db: makeFakeDb(store), signingKey: "", now: () => NOW },
  )
  assert.equal(captured.status, 200)
  assert.deepEqual(captured.body, { ok: true, ignored: "list_unsubscribed" })
})

test("delivered event maps to email_sent + writes outreach + feedback rows", async () => {
  const store = makeStore()
  const captured: Captured = { status: 0, body: null }
  await handleMailgunWebhook(
    makeReq({
      "event-data": {
        event: "delivered",
        id: "evt-delivered-1",
        timestamp: 1714660000,
        recipient: "alice@example.test",
      },
    }),
    makeRes(captured),
    { db: makeFakeDb(store), signingKey: "", now: () => NOW },
  )
  assert.equal(captured.status, 200)
  assert.equal((captured.body as { kind?: string }).kind, "email_sent")
  // One row in pa-outreach-events.
  const evRow = [...ensureCol(store, PA_COLLECTIONS.outreachEvents).values()][0]
  assert.ok(evRow)
  assert.equal((evRow as { provider?: string }).provider, "mailgun")
  // Paired feedback event written.
  assert.equal(ensureCol(store, PA_COLLECTIONS.feedbackEvents).size, 1)
})

test("bounced event maps to email_bounced", async () => {
  const store = makeStore()
  const captured: Captured = { status: 0, body: null }
  await handleMailgunWebhook(
    makeReq({
      "event-data": { event: "bounced", id: "evt-bounce-1", recipient: "ghost@example.test" },
    }),
    makeRes(captured),
    { db: makeFakeDb(store), signingKey: "", now: () => NOW },
  )
  assert.equal((captured.body as { kind?: string }).kind, "email_bounced")
})

test("replaying same event id is idempotent", async () => {
  const store = makeStore()
  const captured: Captured = { status: 0, body: null }
  const body: MailgunWebhookBody = {
    "event-data": { event: "opened", id: "evt-open-1", recipient: "alice@example.test" },
  }
  await handleMailgunWebhook(makeReq(body), makeRes(captured), {
    db: makeFakeDb(store),
    signingKey: "",
    now: () => NOW,
  })
  // Second call against the same store.
  const captured2: Captured = { status: 0, body: null }
  await handleMailgunWebhook(makeReq(body), makeRes(captured2), {
    db: makeFakeDb(store),
    signingKey: "",
    now: () => NOW,
  })
  assert.equal(captured2.status, 200)
  assert.equal((captured2.body as { idempotent?: boolean }).idempotent, true)
  assert.equal(ensureCol(store, PA_COLLECTIONS.outreachEvents).size, 1)
})

test("invalid signature rejected with 401 when signing key configured", async () => {
  const store = makeStore()
  const captured: Captured = { status: 0, body: null }
  await handleMailgunWebhook(
    makeReq({
      signature: { timestamp: "1", token: "t", signature: "deadbeef" },
      "event-data": { event: "delivered", id: "evt-x", recipient: "alice@example.test" },
    }),
    makeRes(captured),
    { db: makeFakeDb(store), signingKey: "secret-key", now: () => NOW },
  )
  assert.equal(captured.status, 401)
})

test("valid signature is accepted + verifyMailgunSignature is hmac-sha256", () => {
  const key = "test-signing-key"
  const sig = {
    timestamp: "1714660000",
    token: "tok-abc",
    signature: createHmac("sha256", key).update("1714660000tok-abc").digest("hex"),
  }
  assert.equal(verifyMailgunSignature(key, sig), true)
  assert.equal(verifyMailgunSignature(key, { ...sig, signature: "0".repeat(64) }), false)
  assert.equal(verifyMailgunSignature("", sig), false)
})
