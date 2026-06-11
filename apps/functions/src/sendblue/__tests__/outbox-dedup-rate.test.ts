/**
 * outbox-dedup-rate.test.ts — 2026-06-10 trust audit, fixes 3 + 5.
 *
 * Fix 3 — duplicate-send guard: live evidence showed identical bubbles
 * delivered 2-6x within minutes (a full rec batch twice 1min apart; the same
 * question 4x in 3min). The outbox now terminal-skips a row whose body already
 * SENT to the same user within 5min — unless `allowRepeat:true` or the body is
 * a short ack (<20 chars).
 *
 * Fix 5 — HTTP 429 handling: consecutive-429 tracking on the row; the 3rd
 * consecutive 429 dead-letters as `dead_letter_rate_limited`, emits
 * `pa.outbox.rate_capped`, and fires the (fail-soft) Slack alert seam.
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"

import { paSendblueOutboxHandler, findRecentDuplicateOutbound, outboundBodyHash } from "../outbox.js"
import { SendblueServerError } from "../sendblue-client.js"
import { _resetPoolCache, _resetCountersCache } from "../pool.js"

type DocData = Record<string, unknown>

/**
 * Query-capable fake Firestore: pa-outbound supports
 * where("userId","==",..).orderBy("createdAt","desc").limit(n).get() so the
 * duplicate guard sees prior rows (the suite-wide fake in outbox.test.ts
 * returns empty there, which exercises only the fail-open path).
 */
function makeQueryFakeDb(
  initialOutbound: Record<string, DocData> = {},
  users: Record<string, DocData> = {},
) {
  const outbound = new Map<string, DocData>(
    Object.entries(initialOutbound).map(([id, row]) => [
      id,
      { runtimeApproved: true, runtimeSource: "test_runtime", ...row },
    ])
  )
  const usersMap = new Map<string, DocData>(Object.entries(users))
  const generic = new Map<string, Map<string, DocData>>()

  function pickStore(coll: string): Map<string, DocData> {
    if (coll === "pa-outbound") return outbound
    if (coll === "pa-users") return usersMap
    if (!generic.has(coll)) generic.set(coll, new Map())
    return generic.get(coll)!
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
    let orderField: string | null = null
    let orderDesc = false
    let max = Number.POSITIVE_INFINITY
    const q = {
      where(field: string, _op: string, value: unknown) {
        filters.push([field, value])
        return q
      },
      orderBy(field: string, dir?: string) {
        orderField = field
        orderDesc = dir === "desc"
        return q
      },
      limit(n: number) {
        max = n
        return q
      },
      async get() {
        let rows = [...pickStore(coll).entries()].filter(([, d]) =>
          filters.every(([f, v]) => d[f] === v)
        )
        if (orderField) {
          rows.sort(([, a], [, b]) => {
            const av = String(a[orderField!] ?? "")
            const bv = String(b[orderField!] ?? "")
            return orderDesc ? bv.localeCompare(av) : av.localeCompare(bv)
          })
        }
        rows = rows.slice(0, max)
        const docs = rows.map(([id, data]) => ({ id, data: () => data }))
        return { docs, empty: docs.length === 0, size: docs.length }
      },
    }
    return q
  }

  const db = {
    collection(name: string) {
      return {
        doc(id: string) {
          return makeDocRef(name, id)
        },
        where(field: string, op: string, value: unknown) {
          return makeQuery(name).where(field, op, value)
        },
        async add(data: DocData) {
          const store = pickStore(name)
          const id = `auto_${store.size + 1}`
          store.set(id, { ...data })
          return { id }
        },
        limit(n: number) {
          return makeQuery(name).limit(n)
        },
        async get() {
          return makeQuery(name).get()
        },
      }
    },
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      const t = {
        async get(ref: { get(): Promise<unknown> }) {
          return ref.get()
        },
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
  return { db, outbound }
}

function makeSendblueMock(opts: { throwError?: Error | Error[] } = {}) {
  let calls = 0
  const errors = Array.isArray(opts.throwError)
    ? [...opts.throwError]
    : opts.throwError
      ? [opts.throwError]
      : []
  const sendImessage = async () => {
    calls++
    const err = errors.shift()
    if (err) throw err
    return {
      type: "message" as const,
      uuid: "uuid-1",
      message_handle: "uuid-1",
      status: "QUEUED",
      from_number: "+15557654321",
      number: "+15551234567",
      content: "x",
      service: "iMessage" as const,
      is_outbound: true as const,
    }
  }
  const sendTypingIndicator = async () => {}
  return { sendImessage, sendTypingIndicator, get calls() { return calls } }
}

const PEER = "+15551234567"
const USER = { id: "u-1", phoneE164: PEER }
const T0 = new Date("2026-06-10T12:00:00Z")
const iso = (msAgo: number) => new Date(T0.getTime() - msAgo).toISOString()
const LONG_BODY = "found a few that fit right now — including WeKruit partner roles 👇"

function makeEvent(docId: string, data: DocData) {
  const row = { runtimeApproved: true, runtimeSource: "test_runtime", ...data }
  return { params: { docId }, data: { data: () => row, id: docId } }
}

function baseDeps(db: unknown, sb: ReturnType<typeof makeSendblueMock>, extra: DocData = {}) {
  return {
    db: db as never,
    sendblueClient: sb,
    now: () => T0,
    log: () => {},
    getUser: async () => USER as never,
    ...extra,
  }
}

beforeEach(() => {
  process.env.PA_TYPING_INDICATOR = "0"
  _resetPoolCache()
  _resetCountersCache()
})
afterEach(() => {
  delete process.env.PA_TYPING_INDICATOR
  _resetPoolCache()
  _resetCountersCache()
})

describe("fix 3 — outbox duplicate-send guard", () => {
  function pendingRow(body: string, extra: DocData = {}): DocData {
    return {
      status: "pending",
      userId: USER.id,
      toE164: PEER,
      body,
      idempotencyKey: "out-new-row",
      createdAt: T0.toISOString(),
      ...extra,
    }
  }
  function sentRow(body: string, msAgo: number): DocData {
    return {
      status: "sent",
      userId: USER.id,
      toE164: PEER,
      body,
      idempotencyKey: `out-prior-${msAgo}`,
      createdAt: iso(msAgo),
      sentAt: iso(msAgo),
    }
  }

  it("identical body SENT 1min ago → duplicate_skipped, no POST", async () => {
    const row = pendingRow(LONG_BODY)
    const { db, outbound } = makeQueryFakeDb(
      { "doc-new": row, "doc-prior": sentRow(LONG_BODY, 60_000) },
      { [USER.id]: USER }
    )
    const sb = makeSendblueMock()
    await paSendblueOutboxHandler(makeEvent("doc-new", row) as never, baseDeps(db, sb))
    assert.equal(sb.calls, 0, "no Sendblue POST")
    const final = outbound.get("doc-new")!
    assert.equal(final.status, "duplicate_skipped")
    assert.equal(final.duplicateOfDocId, "doc-prior")
  })

  it("same body sent 10min ago → OUTSIDE the window → sends normally", async () => {
    const row = pendingRow(LONG_BODY)
    const { db, outbound } = makeQueryFakeDb(
      { "doc-new": row, "doc-prior": sentRow(LONG_BODY, 10 * 60_000) },
      { [USER.id]: USER }
    )
    const sb = makeSendblueMock()
    await paSendblueOutboxHandler(makeEvent("doc-new", row) as never, baseDeps(db, sb))
    assert.equal(sb.calls, 1)
    assert.equal(outbound.get("doc-new")!.status, "sent")
  })

  it("allowRepeat:true bypasses the guard (intentional repeat)", async () => {
    const row = pendingRow(LONG_BODY, { allowRepeat: true })
    const { db, outbound } = makeQueryFakeDb(
      { "doc-new": row, "doc-prior": sentRow(LONG_BODY, 60_000) },
      { [USER.id]: USER }
    )
    const sb = makeSendblueMock()
    await paSendblueOutboxHandler(makeEvent("doc-new", row) as never, baseDeps(db, sb))
    assert.equal(sb.calls, 1)
    assert.equal(outbound.get("doc-new")!.status, "sent")
  })

  it("short acks (<20 chars) legitimately repeat → never deduped", async () => {
    const row = pendingRow("ok!")
    const { db, outbound } = makeQueryFakeDb(
      { "doc-new": row, "doc-prior": sentRow("ok!", 30_000) },
      { [USER.id]: USER }
    )
    const sb = makeSendblueMock()
    await paSendblueOutboxHandler(makeEvent("doc-new", row) as never, baseDeps(db, sb))
    assert.equal(sb.calls, 1)
    assert.equal(outbound.get("doc-new")!.status, "sent")
  })

  it("a prior row for a DIFFERENT user never matches", async () => {
    const row = pendingRow(LONG_BODY)
    const { db, outbound } = makeQueryFakeDb(
      {
        "doc-new": row,
        "doc-other": { ...sentRow(LONG_BODY, 30_000), userId: "someone-else" },
      },
      { [USER.id]: USER }
    )
    const sb = makeSendblueMock()
    await paSendblueOutboxHandler(makeEvent("doc-new", row) as never, baseDeps(db, sb))
    assert.equal(sb.calls, 1)
    assert.equal(outbound.get("doc-new")!.status, "sent")
  })

  it("findRecentDuplicateOutbound ignores failed/pending prior rows and is fail-open on db errors", async () => {
    const { db } = makeQueryFakeDb(
      {
        "doc-failed": { ...sentRow(LONG_BODY, 30_000), status: "failed" },
        "doc-pending": { ...sentRow(LONG_BODY, 30_000), status: "pending" },
      },
      { [USER.id]: USER }
    )
    const hit = await findRecentDuplicateOutbound(db as never, {
      userId: USER.id,
      body: LONG_BODY,
      excludeDocId: "doc-new",
      nowMs: T0.getTime(),
    })
    assert.equal(hit, null, "only sent/delivered rows count")

    const throwingDb = {
      collection: () => ({
        where: () => {
          throw new Error("query down")
        },
      }),
    }
    const failOpen = await findRecentDuplicateOutbound(throwingDb as never, {
      userId: USER.id,
      body: LONG_BODY,
      excludeDocId: "doc-new",
      nowMs: T0.getTime(),
    })
    assert.equal(failOpen, null, "fail-open: error → no dedup, send proceeds")
  })

  it("outboundBodyHash is stable across surrounding whitespace", () => {
    assert.equal(outboundBodyHash(`  ${LONG_BODY}  `), outboundBodyHash(LONG_BODY))
    assert.notEqual(outboundBodyHash("a"), outboundBodyHash("b"))
  })
})

describe("fix 5 — 429 rate-limit handling", () => {
  function pending429Row(extra: DocData = {}): DocData {
    return {
      status: "pending",
      userId: USER.id,
      toE164: PEER,
      body: "hello there candidate, here is your update",
      idempotencyKey: "out-429",
      createdAt: T0.toISOString(),
      ...extra,
    }
  }

  it("first 429 → status=pending with consecutive429Count=1 (retry continues)", async () => {
    const row = pending429Row()
    const { db, outbound } = makeQueryFakeDb({ "doc-1": row }, { [USER.id]: USER })
    const sb = makeSendblueMock({ throwError: new SendblueServerError(429, "rate limited", {}, "30") })
    await paSendblueOutboxHandler(makeEvent("doc-1", row) as never, baseDeps(db, sb))
    const final = outbound.get("doc-1")!
    assert.equal(final.status, "pending")
    assert.equal(final.consecutive429Count, 1)
    assert.equal(final.attemptCount, 1)
    assert.equal(final.retryAfter, "30")
  })

  it("3rd consecutive 429 → dead_letter_rate_limited + pa.outbox.rate_capped + Slack alert", async () => {
    const row = pending429Row({ consecutive429Count: 2, attemptCount: 2 })
    const { db, outbound } = makeQueryFakeDb({ "doc-1": row }, { [USER.id]: USER })
    const sb = makeSendblueMock({ throwError: new SendblueServerError(429, "rate limited", {}) })
    const logs: Array<{ event: unknown; payload?: Record<string, unknown> }> = []
    const alerts: Array<Record<string, unknown>> = []
    await paSendblueOutboxHandler(
      makeEvent("doc-1", row) as never,
      baseDeps(db, sb, {
        log: (event: unknown, payload?: Record<string, unknown>) => logs.push({ event, payload }),
        postSlackAlert: async (input: Record<string, unknown>) => {
          alerts.push(input)
          return { posted: true }
        },
      })
    )
    const final = outbound.get("doc-1")!
    assert.equal(final.status, "dead_letter_rate_limited")
    assert.equal(final.consecutive429Count, 3)
    assert.ok(final.deadLetteredAt)
    assert.ok(logs.some((l) => l.event === "pa.outbox.rate_capped"), "rate_capped log emitted")
    assert.equal(alerts.length, 1, "Slack alert fired")
    assert.equal(alerts[0]!.level, "error")
  })

  it("Slack alert seam failing never blocks the dead-letter write (fail-soft)", async () => {
    const row = pending429Row({ consecutive429Count: 2 })
    const { db, outbound } = makeQueryFakeDb({ "doc-1": row }, { [USER.id]: USER })
    const sb = makeSendblueMock({ throwError: new SendblueServerError(429, "rate limited", {}) })
    await paSendblueOutboxHandler(
      makeEvent("doc-1", row) as never,
      baseDeps(db, sb, {
        postSlackAlert: async () => {
          throw new Error("slack down")
        },
      })
    )
    assert.equal(outbound.get("doc-1")!.status, "dead_letter_rate_limited")
  })

  it("a non-429 5xx RESETS the consecutive-429 streak", async () => {
    const row = pending429Row({ consecutive429Count: 2, attemptCount: 2 })
    const { db, outbound } = makeQueryFakeDb({ "doc-1": row }, { [USER.id]: USER })
    const sb = makeSendblueMock({ throwError: new SendblueServerError(503, "upstream sad", {}) })
    await paSendblueOutboxHandler(makeEvent("doc-1", row) as never, baseDeps(db, sb))
    const final = outbound.get("doc-1")!
    assert.equal(final.status, "pending")
    assert.equal(final.consecutive429Count, 0, "non-429 transient breaks the streak")
    assert.equal(final.attemptCount, 3)
  })
})
