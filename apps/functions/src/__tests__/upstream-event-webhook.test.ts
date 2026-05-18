import assert from "node:assert/strict"
import test from "node:test"
import { createHash, createHmac } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import {
  saveUpstreamTemplate,
  setFlag,
  _clearFeatureFlagCache,
  UPSTREAM_TEMPLATES_COLLECTION,
  UPSTREAM_FIRES_COLLECTION,
} from "@pa/pa-persistence"
import { handleUpstreamEventWebhook } from "../upstream-event-webhook.js"

// -----------------------------------------------------------------------------
// In-memory Firestore double — covers the API surface this handler uses:
// collection(c).doc(id).{get, set, update, add}, collection(c).where().limit().get(),
// runTransaction.
// -----------------------------------------------------------------------------

type Store = Map<string, Map<string, Record<string, unknown>>>

function makeFakeFirestore(): Firestore {
  const store: Store = new Map()
  function getCol(name: string): Map<string, Record<string, unknown>> {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)!
  }

  let autoId = 0

  const docRef = (col: string, id: string) => ({
    id,
    _col: col,
    _id: id,
    async get() {
      const data = getCol(col).get(id)
      return { exists: data !== undefined, data: () => data, id }
    },
    async set(data: Record<string, unknown>) {
      getCol(col).set(id, { ...data })
    },
    async update(data: Record<string, unknown>) {
      const cur = getCol(col).get(id) ?? {}
      getCol(col).set(id, { ...cur, ...data })
    },
  })

  function makeQuery(col: string, filters: { field?: string; val?: unknown }[] = [], lim?: number) {
    return {
      where(field: string, _op: string, val: unknown) {
        return makeQuery(col, [...filters, { field, val }], lim)
      },
      orderBy() {
        return makeQuery(col, filters, lim)
      },
      limit(n: number) {
        return makeQuery(col, filters, n)
      },
      async get() {
        const all = Array.from(getCol(col).entries())
        let rows = all.filter(([, data]) =>
          filters.every((f) => f.field == null || data[f.field] === f.val)
        )
        if (lim != null) rows = rows.slice(0, lim)
        return {
          empty: rows.length === 0,
          docs: rows.map(([id, data]) => ({ id, data: () => data })),
        }
      },
    }
  }

  const colRef = (name: string) => ({
    doc(id?: string) {
      return docRef(name, id ?? `auto_${++autoId}`)
    },
    where(field: string, op: string, val: unknown) {
      return makeQuery(name).where(field, op, val)
    },
    orderBy() {
      return makeQuery(name)
    },
    limit(n: number) {
      return makeQuery(name).limit(n)
    },
    async get() {
      const rows = Array.from(getCol(name).entries())
      return { docs: rows.map(([id, data]) => ({ id, data: () => data })) }
    },
    async add(data: Record<string, unknown>) {
      const id = `auto_${++autoId}`
      getCol(name).set(id, { ...data })
      return { id }
    },
    async count() {
      const rows = Array.from(getCol(name).entries())
      return { get: async () => ({ data: () => ({ count: rows.length }) }) } as unknown as { get: () => Promise<{ data: () => { count: number } }> }
    },
  })

  const fs = {
    collection: (name: string) => colRef(name),
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      const t = {
        async get(ref: { _col: string; _id: string }) {
          const data = getCol(ref._col).get(ref._id)
          return { exists: data !== undefined, data: () => data }
        },
        set(ref: { _col: string; _id: string }, payload: Record<string, unknown>) {
          getCol(ref._col).set(ref._id, { ...payload })
        },
        update(ref: { _col: string; _id: string }, payload: Record<string, unknown>) {
          const cur = getCol(ref._col).get(ref._id) ?? {}
          getCol(ref._col).set(ref._id, { ...cur, ...payload })
        },
      }
      return await fn(t)
    },
    _store: store,
  }
  return fs as unknown as Firestore
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const SECRET = "test-upstream-secret"
const ACTOR = "test@wekruit.com"

function sign(body: string, secret = SECRET) {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex")
}

type CapturedRes = {
  status(code: number): CapturedRes
  json(body: unknown): CapturedRes
  _status: number | null
  _json: unknown
}

function makeRes(): CapturedRes {
  const r: CapturedRes = {
    _status: null,
    _json: null,
    status(code) {
      this._status = code
      return this
    },
    json(body) {
      this._json = body
      return this
    },
  }
  return r
}

async function bootstrapTemplate(db: Firestore, opts: Partial<{ enabled: boolean; rateLimitPerHour: number; eventKind: string; templateId: string; messageTemplate: string }> = {}) {
  return await saveUpstreamTemplate(db, {
    templateId: opts.templateId ?? "interview_scheduled",
    name: "Interview scheduled",
    eventKind: opts.eventKind ?? "interview_scheduled",
    messageTemplate: opts.messageTemplate ?? "Hi {{userName}}, your interview is at {{when}}.",
    enabled: opts.enabled ?? true,
    rateLimitPerHour: opts.rateLimitPerHour ?? 1,
    updatedBy: ACTOR,
  })
}

async function bootstrapUser(db: Firestore, userId: string, phone: string | null) {
  await db.collection("pa-users").doc(userId).set(
    phone == null ? { id: userId } : { id: userId, phoneE164: phone }
  )
}

function sessionDocId(userId: string, channel: string, externalChatId: string): string {
  const h = createHash("sha256").update(`${userId}|${channel}|${externalChatId}`).digest("hex")
  return `ses_${h.slice(0, 32)}`
}

async function bootstrapSession(db: Firestore, userId: string, phone: string) {
  const id = sessionDocId(userId, "imessage", phone)
  await db.collection("pa-sessions").doc(id).set({
    id,
    userId,
    channel: "imessage",
    externalChatId: phone,
    createdAt: "2026-04-28T00:00:00.000Z",
  })
}

async function enableFlag(db: Firestore) {
  _clearFeatureFlagCache()
  await setFlag(
    db,
    "upstreamConnectorEnabled",
    { value: true, type: "bool", scope: "global" },
    { actor: ACTOR, reason: "test setup" }
  )
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

test("rejects request without HMAC signature → 401", async () => {
  const db = makeFakeFirestore()
  const body = JSON.stringify({ eventKind: "x", userId: "u1", payload: {} })
  const res = makeRes()
  await handleUpstreamEventWebhook(
    { rawBody: body, headers: {} },
    res,
    { db, secret: SECRET }
  )
  assert.equal(res._status, 401)
  assert.deepEqual(res._json, { ok: false, error: "invalid_signature" })
})

test("rejects bad signature → 401", async () => {
  const db = makeFakeFirestore()
  const body = JSON.stringify({ eventKind: "x", userId: "u1", payload: {} })
  const res = makeRes()
  await handleUpstreamEventWebhook(
    { rawBody: body, headers: { "x-pa-upstream-signature": "deadbeef" } },
    res,
    { db, secret: SECRET }
  )
  assert.equal(res._status, 401)
})

test("rejects malformed JSON body → 400", async () => {
  const db = makeFakeFirestore()
  const body = "not json"
  const res = makeRes()
  await handleUpstreamEventWebhook(
    {
      rawBody: body,
      headers: { "x-pa-upstream-signature": sign(body) },
    },
    res,
    { db, secret: SECRET }
  )
  assert.equal(res._status, 400)
  assert.deepEqual(res._json, { ok: false, error: "malformed_body" })
})

test("rejects missing eventKind → 400", async () => {
  const db = makeFakeFirestore()
  const body = JSON.stringify({ userId: "u1", payload: {} })
  const res = makeRes()
  await handleUpstreamEventWebhook(
    { rawBody: body, headers: { "x-pa-upstream-signature": sign(body) } },
    res,
    { db, secret: SECRET }
  )
  assert.equal(res._status, 400)
  assert.deepEqual(res._json, { ok: false, error: "missing_eventKind_or_userId" })
})

test("returns 404 when no template matches eventKind", async () => {
  const db = makeFakeFirestore()
  await enableFlag(db)
  const body = JSON.stringify({ eventKind: "nope", userId: "u1", payload: {} })
  const res = makeRes()
  await handleUpstreamEventWebhook(
    { rawBody: body, headers: { "x-pa-upstream-signature": sign(body) } },
    res,
    { db, secret: SECRET }
  )
  assert.equal(res._status, 404)
})

test("returns 404 when matching template is disabled", async () => {
  const db = makeFakeFirestore()
  await enableFlag(db)
  await bootstrapTemplate(db, { enabled: false })
  const body = JSON.stringify({ eventKind: "interview_scheduled", userId: "u1", payload: {} })
  const res = makeRes()
  await handleUpstreamEventWebhook(
    { rawBody: body, headers: { "x-pa-upstream-signature": sign(body) } },
    res,
    { db, secret: SECRET }
  )
  assert.equal(res._status, 404)
})

test("returns 503 when upstreamConnectorEnabled flag is false", async () => {
  const db = makeFakeFirestore()
  _clearFeatureFlagCache()
  // Flag absent → defaultValue=false → 503
  await bootstrapTemplate(db)
  await bootstrapUser(db, "u1", "+15551234567")
  const body = JSON.stringify({ eventKind: "interview_scheduled", userId: "u1", payload: {} })
  const res = makeRes()
  await handleUpstreamEventWebhook(
    { rawBody: body, headers: { "x-pa-upstream-signature": sign(body) } },
    res,
    { db, secret: SECRET }
  )
  assert.equal(res._status, 503)
})

test("happy path: hands rendered context to runtime, never direct pa-outbound", async () => {
  const db = makeFakeFirestore()
  await enableFlag(db)
  await bootstrapTemplate(db, { rateLimitPerHour: 5 })
  await bootstrapUser(db, "u1", "+15551234567")
  await bootstrapSession(db, "u1", "+15551234567")
  const body = JSON.stringify({
    eventKind: "interview_scheduled",
    userId: "u1",
    payload: { userName: "Alex", when: "Friday 3pm" },
  })
  const res = makeRes()
  await handleUpstreamEventWebhook(
    {
      rawBody: body,
      headers: { "x-pa-upstream-signature": sign(body) },
    },
    res,
    {
      db,
      secret: SECRET,
      newId: () => "out-deterministic-1",
      nowIso: () => "2026-04-28T12:00:00.000Z",
      nowMs: () => 1_777_000_000_000,
    }
  )
  assert.equal(res._status, 200)
  const payload = res._json as { ok: boolean; runtimeEventId: string }
  assert.equal(payload.ok, true)
  assert.ok(payload.runtimeEventId.startsWith("runtime_"))

  const fs = db as unknown as { _store: Map<string, Map<string, Record<string, unknown>>> }
  assert.equal(fs._store.get("pa-outbound")?.size ?? 0, 0)
  const eventDoc = fs._store.get("pa-inbound-events")?.get(payload.runtimeEventId) as
    | Record<string, unknown>
    | undefined
  assert.ok(eventDoc, "runtime event doc missing")
  assert.equal(eventDoc!.status, "pending")
  assert.equal(eventDoc!.userId, "u1")
  assert.match(String(eventDoc!.body), /system-event:upstream_event:interview_scheduled/)
  assert.match(String(eventDoc!.body), /Hi Alex, your interview is at Friday 3pm\./)
  assert.equal((eventDoc!.rawMeta as Record<string, unknown>).runtimeEvent, true)

  // Audit row written
  const audit = fs._store.get("pa-audit-events")
  const enqueued = audit
    ? Array.from(audit.values()).find((r) => r.result === "runtime_handoff")
    : undefined
  assert.ok(enqueued, "audit runtime handoff row missing")
  assert.equal(enqueued!.kind, "upstream_inbound")
  assert.equal(enqueued!.runtimeEventId, payload.runtimeEventId)
})

test("rate limit: second call within same hour bucket → 429", async () => {
  const db = makeFakeFirestore()
  await enableFlag(db)
  await bootstrapTemplate(db, { rateLimitPerHour: 1 })
  await bootstrapUser(db, "u1", "+15551234567")
  await bootstrapSession(db, "u1", "+15551234567")
  const body = JSON.stringify({
    eventKind: "interview_scheduled",
    userId: "u1",
    payload: { userName: "Alex" },
  })
  const baseDeps = {
    db,
    secret: SECRET,
    nowMs: () => 1_777_000_000_000,
    newId: () => `id-${Math.random()}`,
  }
  const res1 = makeRes()
  await handleUpstreamEventWebhook(
    { rawBody: body, headers: { "x-pa-upstream-signature": sign(body) } },
    res1,
    baseDeps
  )
  assert.equal(res1._status, 200)
  const res2 = makeRes()
  await handleUpstreamEventWebhook(
    { rawBody: body, headers: { "x-pa-upstream-signature": sign(body) } },
    res2,
    baseDeps
  )
  assert.equal(res2._status, 429)
})

test("returns 422 when target user has no phone", async () => {
  const db = makeFakeFirestore()
  await enableFlag(db)
  await bootstrapTemplate(db, { rateLimitPerHour: 5 })
  await bootstrapUser(db, "u-noPhone", null)
  const body = JSON.stringify({ eventKind: "interview_scheduled", userId: "u-noPhone", payload: {} })
  const res = makeRes()
  await handleUpstreamEventWebhook(
    { rawBody: body, headers: { "x-pa-upstream-signature": sign(body) } },
    res,
    { db, secret: SECRET }
  )
  assert.equal(res._status, 422)
})

test("custom resolveUserPhone is honored", async () => {
  const db = makeFakeFirestore()
  await enableFlag(db)
  await bootstrapTemplate(db, { rateLimitPerHour: 5 })
  await bootstrapSession(db, "u1", "+19999999999")
  const body = JSON.stringify({
    eventKind: "interview_scheduled",
    userId: "u1",
    payload: { userName: "X" },
  })
  const res = makeRes()
  let resolverCalled = false
  await handleUpstreamEventWebhook(
    { rawBody: body, headers: { "x-pa-upstream-signature": sign(body) } },
    res,
    {
      db,
      secret: SECRET,
      resolveUserPhone: async () => {
        resolverCalled = true
        return "+19999999999"
      },
      newId: () => "x",
    }
  )
  assert.equal(res._status, 200)
  assert.equal(resolverCalled, true)
})

// Quiet "unused" warnings for collection constants imported for clarity.
void UPSTREAM_TEMPLATES_COLLECTION
void UPSTREAM_FIRES_COLLECTION
