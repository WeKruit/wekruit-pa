/**
 * Wave C Block F2 — Instantly webhook tests.
 *
 * Covers:
 *  - HTTP method gate (non-POST → 405).
 *  - HMAC verify accept + reject when secret configured.
 *  - HMAC skipped when secret unset (treat as open).
 *  - Idempotency: same `event_id` posted twice → 1 doc.
 *  - All event_type → OutreachEventKind mappings.
 *  - Plan lookup via emailHash.
 *  - Missing plan still persists the event with planId="unknown" and emits
 *    a feedback event.
 *  - Companion feedback-event with the right kind.
 *  - Bad body → 400.
 *  - Unknown event_type → 200 + ignored.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { createHmac, createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  handleInstantlyWebhook,
  verifyInstantlySignature,
  type InstantlyWebhookBody,
  type InstantlyWebhookRequest,
  type InstantlyWebhookResponse,
} from "./instantly-webhook.js"

const NOW = "2026-05-13T12:00:00.000Z"

type Store = Map<string, Map<string, Record<string, unknown>>>

function ensureCol(store: Store, name: string): Map<string, Record<string, unknown>> {
  if (!store.has(name)) store.set(name, new Map())
  return store.get(name)!
}

function makeStore(): Store {
  const map: Store = new Map()
  for (const name of Object.values(PA_COLLECTIONS)) map.set(name, new Map())
  return map
}

function makeFakeFirestore(store: Store = makeStore()): { db: Firestore; store: Store } {
  function docRef(collectionName: string, id: string) {
    return {
      id,
      async get() {
        const data = ensureCol(store, collectionName).get(id)
        return { exists: data !== undefined, id, data: () => data }
      },
      async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
        const col = ensureCol(store, collectionName)
        const current = col.get(id)
        col.set(id, opts?.merge && current ? { ...current, ...data } : { ...data })
      },
    }
  }
  function collection(collectionName: string) {
    return {
      doc(id: string) {
        return docRef(collectionName, id)
      },
      where(field: string, _op: string, value: unknown) {
        const entries = Array.from(ensureCol(store, collectionName).entries()).filter(
          ([, data]) => data[field] === value,
        )
        return {
          async get() {
            return {
              empty: entries.length === 0,
              docs: entries.map(([id, data]) => ({ id, data: () => data })),
            }
          },
        }
      },
    }
  }
  const db = { collection } as unknown as Firestore
  return { db, store }
}

function makeRes(): {
  res: InstantlyWebhookResponse
  status: () => number | undefined
  body: () => unknown
} {
  let _status: number | undefined
  let _body: unknown
  const res: InstantlyWebhookResponse = {
    status(code) {
      _status = code
      return res
    },
    json(body) {
      _body = body
      return body
    },
    send(body) {
      _body = body
      return body
    },
  }
  return { res, status: () => _status, body: () => _body }
}

function makeReq(body: InstantlyWebhookBody, method = "POST"): InstantlyWebhookRequest {
  const raw = JSON.stringify(body)
  return {
    method,
    headers: {},
    body,
    rawBody: Buffer.from(raw, "utf8"),
  }
}

function seedPlan(store: Store, planId: string, email: string) {
  const hash = createHash("sha256").update(email.toLowerCase(), "utf8").digest("hex")
  ensureCol(store, PA_COLLECTIONS.outreachPlans).set(planId, {
    planId,
    candidateId: "c1",
    jobId: "j1",
    companyId: "co1",
    emailHash: hash,
  })
}

// ---------------------------------------------------------------------------
// Method gate
// ---------------------------------------------------------------------------

test("webhook — non-POST returns 405", async () => {
  const { db } = makeFakeFirestore()
  const { res, status } = makeRes()
  const out = await handleInstantlyWebhook(
    { method: "GET", body: {} },
    res,
    { db, now: () => NOW },
  )
  assert.equal(out.status, 405)
  assert.equal(status(), 405)
})

// ---------------------------------------------------------------------------
// HMAC verify
// ---------------------------------------------------------------------------

test("verifyInstantlySignature — happy path returns true", () => {
  const secret = "test-secret"
  const body = Buffer.from('{"a":1}', "utf8")
  const sig = createHmac("sha256", secret).update(body).digest("hex")
  assert.equal(verifyInstantlySignature(body, sig, secret), true)
})

test("verifyInstantlySignature — wrong secret returns false", () => {
  const body = Buffer.from('{"a":1}', "utf8")
  const sig = createHmac("sha256", "wrong").update(body).digest("hex")
  assert.equal(verifyInstantlySignature(body, sig, "right"), false)
})

test("verifyInstantlySignature — missing header returns false", () => {
  assert.equal(verifyInstantlySignature(Buffer.from("x"), undefined, "s"), false)
})

test("webhook — HMAC reject returns 401", async () => {
  const { db } = makeFakeFirestore()
  const { res } = makeRes()
  const out = await handleInstantlyWebhook(
    {
      method: "POST",
      headers: { "x-instantly-signature": "deadbeef" },
      rawBody: Buffer.from('{"event_type":"sent","event_id":"x"}', "utf8"),
      body: { event_type: "sent", event_id: "x" },
    },
    res,
    { db, secret: "s", now: () => NOW },
  )
  assert.equal(out.status, 401)
})

test("webhook — HMAC accept persists event", async () => {
  const { db, store } = makeFakeFirestore()
  seedPlan(store, "plan-1", "ada@example.com")
  const body = {
    event_type: "reply",
    event_id: "ev-99",
    lead: { email: "ada@example.com", id: "ll-99" },
    occurred_at: NOW,
  }
  const raw = Buffer.from(JSON.stringify(body), "utf8")
  const secret = "test-secret"
  const sig = createHmac("sha256", secret).update(raw).digest("hex")
  const { res } = makeRes()
  const out = await handleInstantlyWebhook(
    {
      method: "POST",
      headers: { "x-instantly-signature": sig },
      rawBody: raw,
      body,
    },
    res,
    { db, secret, now: () => NOW },
  )
  assert.equal(out.status, 200)
  assert.equal(out.kind, "email_replied")
})

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("webhook — same event_id posted twice writes one event", async () => {
  const { db, store } = makeFakeFirestore()
  seedPlan(store, "plan-1", "ada@example.com")
  const body = {
    event_type: "reply",
    event_id: "ev-twice",
    lead: { email: "ada@example.com", id: "ll-1" },
    occurred_at: NOW,
  }
  const r1 = makeRes()
  await handleInstantlyWebhook(makeReq(body), r1.res, { db, now: () => NOW })
  const r2 = makeRes()
  const out2 = await handleInstantlyWebhook(makeReq(body), r2.res, { db, now: () => NOW })
  assert.equal(out2.status, 200)
  assert.equal(ensureCol(store, PA_COLLECTIONS.outreachEvents).size, 1)
})

// ---------------------------------------------------------------------------
// Event-type mappings
// ---------------------------------------------------------------------------

test("webhook — maps all known event_types to OutreachEventKind", async () => {
  const { db, store } = makeFakeFirestore()
  seedPlan(store, "plan-1", "ada@example.com")
  const cases: Array<{ in: string; out: string }> = [
    { in: "reply", out: "email_replied" },
    { in: "bounce", out: "email_bounced" },
    { in: "unsubscribe", out: "email_unsubscribed" },
    { in: "open", out: "email_opened" },
    { in: "click", out: "email_clicked" },
    { in: "sent", out: "email_sent" },
    { in: "spam", out: "email_marked_spam" },
  ]
  let i = 0
  for (const c of cases) {
    i += 1
    const r = makeRes()
    const out = await handleInstantlyWebhook(
      makeReq({
        event_type: c.in,
        event_id: `ev-${i}`,
        lead: { email: "ada@example.com" },
        occurred_at: NOW,
      }),
      r.res,
      { db, now: () => NOW },
    )
    assert.equal(out.kind, c.out, `${c.in} → ${c.out}`)
  }
  assert.equal(
    ensureCol(store, PA_COLLECTIONS.outreachEvents).size,
    cases.length,
  )
})

test("webhook — unknown event_type returns 200 ignored", async () => {
  const { db } = makeFakeFirestore()
  const r = makeRes()
  const out = await handleInstantlyWebhook(
    makeReq({ event_type: "marked_as_pancake", event_id: "ev-x" }),
    r.res,
    { db, now: () => NOW },
  )
  assert.equal(out.status, 200)
  assert.equal(out.reason, "unknown_event_type")
})

// ---------------------------------------------------------------------------
// Plan lookup + feedback emission
// ---------------------------------------------------------------------------

test("webhook — reply event resolves planId via email hash + emits candidate_reply feedback", async () => {
  const { db, store } = makeFakeFirestore()
  seedPlan(store, "plan-known", "ada@example.com")
  const r = makeRes()
  const out = await handleInstantlyWebhook(
    makeReq({
      event_type: "reply",
      event_id: "ev-reply",
      lead: { email: "ADA@example.com" }, // case is irrelevant for hash
      occurred_at: NOW,
    }),
    r.res,
    { db, now: () => NOW },
  )
  assert.equal(out.status, 200)
  const events = ensureCol(store, PA_COLLECTIONS.outreachEvents)
  const persisted = Array.from(events.values())[0]!
  assert.equal(persisted.planId, "plan-known")
  assert.equal(persisted.candidateId, "c1")
  // Feedback event paired.
  const feedback = ensureCol(store, PA_COLLECTIONS.feedbackEvents)
  assert.equal(feedback.size, 1)
  const fb = Array.from(feedback.values())[0]!
  assert.equal(fb.kind, "candidate_reply")
  assert.equal(fb.candidateId, "c1")
})

test("webhook — bounce event emits outreach_delivery feedback", async () => {
  const { db, store } = makeFakeFirestore()
  seedPlan(store, "plan-bounce", "ada@example.com")
  const r = makeRes()
  await handleInstantlyWebhook(
    makeReq({
      event_type: "bounce",
      event_id: "ev-bounce",
      lead: { email: "ada@example.com" },
      occurred_at: NOW,
    }),
    r.res,
    { db, now: () => NOW },
  )
  const fb = Array.from(ensureCol(store, PA_COLLECTIONS.feedbackEvents).values())[0]!
  assert.equal(fb.kind, "outreach_delivery")
  assert.equal(fb.outcome, "email_bounced")
})

test("webhook — missing plan still persists event with planId=unknown", async () => {
  const { db, store } = makeFakeFirestore()
  // No plan seeded.
  const r = makeRes()
  const out = await handleInstantlyWebhook(
    makeReq({
      event_type: "sent",
      event_id: "ev-orphan",
      lead: { email: "stranger@example.com" },
      occurred_at: NOW,
    }),
    r.res,
    { db, now: () => NOW },
  )
  assert.equal(out.status, 200)
  const persisted = Array.from(ensureCol(store, PA_COLLECTIONS.outreachEvents).values())[0]!
  assert.equal(persisted.planId, "unknown")
})

// ---------------------------------------------------------------------------
// Bad body
// ---------------------------------------------------------------------------

test("webhook — malformed body returns 400", async () => {
  const { db } = makeFakeFirestore()
  const r = makeRes()
  const out = await handleInstantlyWebhook(
    {
      method: "POST",
      headers: {},
      rawBody: Buffer.from("not-json", "utf8"),
      body: undefined,
    },
    r.res,
    { db, now: () => NOW },
  )
  assert.equal(out.status, 400)
})
