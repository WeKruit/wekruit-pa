/**
 * paPendingOutboundAdmin handler tests.
 *
 * Drives the pure `runPendingOutboundAdmin` against an in-memory Firestore fake
 * (same shape as queue.test.ts). The focus is the SEND GATE — proving that no
 * message dispatches unless every gate passes AND `sendImpl` is wired, that
 * suppressed rows + live opt-out are hard-blocked, and that list/update/approve/
 * skip transitions behave.
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  PendingOutboundSchema,
  pendingOutboundDocId,
  type PendingOutbound,
} from "@pa/core-types"
import {
  runPendingOutboundAdmin,
  type PendingOutboundAdminDeps,
  type LiveRecipient,
} from "./admin.js"

type Store = Map<string, Map<string, Record<string, unknown>>>

const NOW = "2026-06-01T12:00:00.000Z"

function makeStore(): Store {
  return new Map(Object.values(PA_COLLECTIONS).map((name) => [name, new Map()]))
}

function makeFakeFirestore(store: Store = makeStore()): {
  db: Firestore
  store: Store
} {
  function col(name: string): Map<string, Record<string, unknown>> {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)!
  }
  let auto = 1
  function docRef(collectionName: string, id?: string) {
    const docId = id ?? `auto_${auto++}`
    return {
      id: docId,
      async get() {
        const data = col(collectionName).get(docId)
        return { exists: data !== undefined, id: docId, data: () => data }
      },
      async set(data: Record<string, unknown>) {
        col(collectionName).set(docId, { ...data })
      },
    }
  }
  function makeQuery(
    collectionName: string,
    predicate: (data: Record<string, unknown>) => boolean,
    limitN: number | null
  ) {
    return {
      where(field: string, _op: string, value: unknown) {
        return makeQuery(
          collectionName,
          (data) => predicate(data) && data[field] === value,
          limitN
        )
      },
      limit(n: number) {
        return makeQuery(collectionName, predicate, n)
      },
      async get() {
        let entries = Array.from(col(collectionName).entries()).filter(
          ([, data]) => predicate(data)
        )
        if (limitN !== null) entries = entries.slice(0, limitN)
        return {
          empty: entries.length === 0,
          docs: entries.map(([id, data]) => ({ id, data: () => data })),
        }
      },
    }
  }
  function collection(collectionName: string) {
    const base = makeQuery(collectionName, () => true, null)
    return {
      doc(id?: string) {
        return docRef(collectionName, id)
      },
      where: base.where,
      limit: base.limit,
      get: base.get,
    }
  }
  const db = { collection } as unknown as Firestore
  return { db, store }
}

function seedRow(
  store: Store,
  over: Partial<PendingOutbound> = {}
): PendingOutbound {
  const id =
    over.id ??
    pendingOutboundDocId({
      userId: over.userId ?? "user-1",
      reasonCode: over.reasonCode ?? "dup_send",
      sourceSessionId: over.sourceSessionId ?? "sess-abc",
    })
  const doc = PendingOutboundSchema.parse({
    id,
    userId: "user-1",
    toE164: "+14243201960",
    channel: "imessage",
    kind: "recovery",
    draftBody: "Hey, quick follow-up — still around?",
    whyQueued: "dup_send x4 on 2026-05-2x",
    reasonCode: "dup_send",
    sourceSessionId: "sess-abc",
    enrichmentSnapshot: null,
    status: "pending",
    suppressed: false,
    suppressedReason: null,
    createdAt: NOW,
    approvedBy: null,
    approvedAt: null,
    sentAt: null,
    sendError: null,
    version: 1,
    ...over,
  })
  store.get(PA_COLLECTIONS.pendingOutbound)!.set(doc.id, { ...doc })
  return doc
}

function baseDeps(
  db: Firestore,
  over: Partial<PendingOutboundAdminDeps> = {}
): PendingOutboundAdminDeps {
  return {
    db,
    actorUid: "admin1@wekruit.com",
    now: () => NOW,
    resolveLiveRecipient: async (): Promise<LiveRecipient> => ({
      toE164: "+14243201960",
      optedOut: false,
    }),
    ...over,
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test("list returns pending rows by default, newest first", async () => {
  const { db, store } = makeFakeFirestore()
  seedRow(store, { id: "a", sourceSessionId: "a", createdAt: "2026-06-01T01:00:00.000Z" })
  seedRow(store, { id: "b", sourceSessionId: "b", createdAt: "2026-06-01T03:00:00.000Z" })
  seedRow(store, { id: "c", sourceSessionId: "c", status: "sent", createdAt: "2026-06-01T02:00:00.000Z" })

  const res = await runPendingOutboundAdmin({ action: "list" }, baseDeps(db))
  assert.equal(res.action, "list")
  if (res.action !== "list") return
  assert.deepEqual(res.rows.map((r) => r.id), ["b", "a"]) // only pending, newest first
})

// ---------------------------------------------------------------------------
// update / approve / skip
// ---------------------------------------------------------------------------

test("update rewrites draftBody but not status", async () => {
  const { db, store } = makeFakeFirestore()
  const row = seedRow(store)
  const res = await runPendingOutboundAdmin(
    { action: "update", id: row.id, draftBody: "Edited grounded copy." },
    baseDeps(db)
  )
  if (res.action !== "update") return assert.fail("wrong action")
  assert.equal(res.doc.draftBody, "Edited grounded copy.")
  assert.equal(res.doc.status, "pending")
})

test("approve stamps approver + timestamp", async () => {
  const { db, store } = makeFakeFirestore()
  const row = seedRow(store)
  const res = await runPendingOutboundAdmin(
    { action: "approve", id: row.id },
    baseDeps(db)
  )
  if (res.action !== "approve") return assert.fail("wrong action")
  assert.equal(res.doc.status, "approved")
  assert.equal(res.doc.approvedBy, "admin1@wekruit.com")
  assert.equal(res.doc.approvedAt, NOW)
})

test("approve rejects a non-pending row", async () => {
  const { db, store } = makeFakeFirestore()
  const row = seedRow(store, { status: "approved" })
  await assert.rejects(
    runPendingOutboundAdmin({ action: "approve", id: row.id }, baseDeps(db))
  )
})

test("skip flips a pending row to skipped", async () => {
  const { db, store } = makeFakeFirestore()
  const row = seedRow(store)
  const res = await runPendingOutboundAdmin(
    { action: "skip", id: row.id },
    baseDeps(db)
  )
  if (res.action !== "skip") return assert.fail("wrong action")
  assert.equal(res.doc.status, "skipped")
})

// ---------------------------------------------------------------------------
// send — the gate
// ---------------------------------------------------------------------------

test("send is blocked when the row is not approved", async () => {
  const { db, store } = makeFakeFirestore()
  const row = seedRow(store, { status: "pending" })
  let dispatched = false
  const res = await runPendingOutboundAdmin(
    { action: "send", id: row.id },
    baseDeps(db, {
      sendImpl: async () => {
        dispatched = true
        return { providerMessageId: "x" }
      },
    })
  )
  if (res.action !== "send") return assert.fail("wrong action")
  assert.equal(res.blocked, true)
  assert.equal(res.ok, false)
  assert.equal(dispatched, false)
})

test("send is hard-blocked for suppressed rows even if approved + sendImpl wired", async () => {
  const { db, store } = makeFakeFirestore()
  const row = seedRow(store, {
    status: "approved",
    suppressed: true,
    suppressedReason: "opted_out",
  })
  let dispatched = false
  const res = await runPendingOutboundAdmin(
    { action: "send", id: row.id },
    baseDeps(db, {
      sendImpl: async () => {
        dispatched = true
        return { providerMessageId: "x" }
      },
    })
  )
  if (res.action !== "send") return assert.fail("wrong action")
  assert.equal(res.blocked, true)
  assert.equal(dispatched, false)
  assert.match(res.reason, /suppressed/)
})

test("send re-validates live opt-out at send time and persists suppression", async () => {
  const { db, store } = makeFakeFirestore()
  const row = seedRow(store, { status: "approved", suppressed: false })
  let dispatched = false
  const res = await runPendingOutboundAdmin(
    { action: "send", id: row.id },
    baseDeps(db, {
      resolveLiveRecipient: async () => ({
        toE164: "+14243201960",
        optedOut: true,
        optedOutReason: "do_not_contact",
      }),
      sendImpl: async () => {
        dispatched = true
        return { providerMessageId: "x" }
      },
    })
  )
  if (res.action !== "send") return assert.fail("wrong action")
  assert.equal(res.blocked, true)
  assert.equal(dispatched, false)
  assert.equal(res.doc.suppressed, true)
  assert.equal(res.doc.suppressedReason, "do_not_contact")
  // persisted
  const stored = store.get(PA_COLLECTIONS.pendingOutbound)!.get(row.id)!
  assert.equal(stored.suppressed, true)
})

test("send does NOT dispatch when sendImpl is not wired (production default)", async () => {
  const { db, store } = makeFakeFirestore()
  const row = seedRow(store, { status: "approved" })
  const res = await runPendingOutboundAdmin(
    { action: "send", id: row.id },
    baseDeps(db) // no sendImpl
  )
  if (res.action !== "send") return assert.fail("wrong action")
  assert.equal(res.blocked, true)
  assert.equal(res.reason, "send_not_wired")
  assert.equal(res.doc.status, "approved") // unchanged, never marked sent
})

test("send dispatches + marks sent only when every gate passes AND sendImpl wired", async () => {
  const { db, store } = makeFakeFirestore()
  const row = seedRow(store, { status: "approved" })
  const calls: unknown[] = []
  const res = await runPendingOutboundAdmin(
    { action: "send", id: row.id },
    baseDeps(db, {
      sendImpl: async (args) => {
        calls.push(args)
        return { providerMessageId: "msg-123" }
      },
    })
  )
  if (res.action !== "send") return assert.fail("wrong action")
  assert.equal(res.ok, true)
  assert.equal(res.blocked, false)
  assert.equal(res.doc.status, "sent")
  assert.equal(res.doc.sentAt, NOW)
  assert.equal(calls.length, 1)
  // dispatched against the LIVE handle, not necessarily the stale row value
  assert.deepEqual(calls[0], {
    toE164: "+14243201960",
    channel: "imessage",
    body: "Hey, quick follow-up — still around?",
    userId: "user-1",
    docId: row.id,
  })
})

test("send marks the row failed when sendImpl throws", async () => {
  const { db, store } = makeFakeFirestore()
  const row = seedRow(store, { status: "approved" })
  const res = await runPendingOutboundAdmin(
    { action: "send", id: row.id },
    baseDeps(db, {
      sendImpl: async () => {
        throw new Error("sendblue 503")
      },
    })
  )
  if (res.action !== "send") return assert.fail("wrong action")
  assert.equal(res.ok, false)
  assert.equal(res.blocked, false)
  assert.equal(res.doc.status, "failed")
  assert.match(res.doc.sendError ?? "", /503/)
})
