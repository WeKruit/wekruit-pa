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
    // Default the full suppression re-check to CLEAR so the older send-gate
    // tests keep exercising the gate they were written for. Tests that want to
    // assert the suppression gate inject their own `checkSuppression`, and the
    // "real default" test passes `checkSuppression: undefined` to fall through
    // to the production `isSuppressed`.
    checkSuppression: async () => ({
      suppressed: false,
      reason: "clear",
      signals: [],
      failedClosed: false,
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

// ---------------------------------------------------------------------------
// send — full isSuppressed re-check at click time (the post-queue pause gate)
// ---------------------------------------------------------------------------

test("REQUIRED(e): send is blocked at click time when isSuppressed fires after queueing (paused-after-approve)", async () => {
  // Row was queued + approved CLEAN (suppressed=false, live recipient OK), but
  // the candidate texted STOP afterward → the FULL suppression re-check must
  // block it even though the static row flag + basic live opt-out look clear.
  const { db, store } = makeFakeFirestore()
  const row = seedRow(store, { status: "approved", suppressed: false })
  let dispatched = false
  const res = await runPendingOutboundAdmin(
    { action: "send", id: row.id },
    baseDeps(db, {
      // basic live recipient looks reachable + not opted out…
      resolveLiveRecipient: async () => ({ toE164: "+14243201960", optedOut: false }),
      // …but the full suppression gate sees the reversible pause they just set.
      checkSuppression: async () => ({
        suppressed: true,
        reason: "outreach_status_paused",
        signals: ["outreach_status_paused"],
        failedClosed: false,
      }),
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
  assert.equal(res.reason, "outreach_status_paused")
  // the row is persisted as suppressed so the queue reflects reality
  assert.equal(res.doc.suppressed, true)
  assert.equal(res.doc.suppressedReason, "outreach_status_paused")
  const stored = store.get(PA_COLLECTIONS.pendingOutbound)!.get(row.id)!
  assert.equal(stored.suppressed, true)
})

test("REQUIRED(d): send dispatches + marks sent when the full suppression re-check is CLEAR", async () => {
  // Same clean path, but now the explicit full-suppression seam returns clear —
  // proving the new gate is wired in series with (not in place of) dispatch.
  const { db, store } = makeFakeFirestore()
  const row = seedRow(store, { status: "approved" })
  const calls: unknown[] = []
  const res = await runPendingOutboundAdmin(
    { action: "send", id: row.id },
    baseDeps(db, {
      checkSuppression: async () => ({
        suppressed: false,
        reason: "clear",
        signals: [],
        failedClosed: false,
      }),
      sendImpl: async (args) => {
        calls.push(args)
        return { providerMessageId: "msg-789" }
      },
    })
  )
  if (res.action !== "send") return assert.fail("wrong action")
  assert.equal(res.ok, true)
  assert.equal(res.blocked, false)
  assert.equal(res.doc.status, "sent")
  assert.equal(calls.length, 1)
})

test("send fails CLOSED when isSuppressed itself errors (recovery kind), no dispatch", async () => {
  // If the suppression read throws, the default (recovery) behavior must be to
  // NOT send. We model that by a checkSuppression that returns a failedClosed
  // suppression — the gate blocks and never reaches sendImpl.
  const { db, store } = makeFakeFirestore()
  const row = seedRow(store, { status: "approved" })
  let dispatched = false
  const res = await runPendingOutboundAdmin(
    { action: "send", id: row.id },
    baseDeps(db, {
      checkSuppression: async () => ({
        suppressed: true,
        reason: "user_read_failed",
        signals: ["user_read_failed"],
        failedClosed: true,
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
  assert.equal(res.reason, "user_read_failed")
})

test("default checkSuppression wires the real isSuppressed (a real opted_out pa-users doc blocks)", async () => {
  // No checkSuppression injected → the handler must fall back to the real
  // isSuppressed(db, userId). Seed a pa-users doc that is opted out and prove
  // the send is blocked WITHOUT ever calling sendImpl.
  const { db, store } = makeFakeFirestore()
  const row = seedRow(store, { status: "approved" })
  store.get(PA_COLLECTIONS.users)!.set("user-1", {
    id: "user-1",
    phoneE164: "+14243201960",
    candidateLifecycleState: "opted_out",
  })
  let dispatched = false
  const res = await runPendingOutboundAdmin(
    { action: "send", id: row.id },
    baseDeps(db, {
      // intentionally NOT injecting checkSuppression — exercise the real default
      checkSuppression: undefined,
      sendImpl: async () => {
        dispatched = true
        return { providerMessageId: "x" }
      },
    })
  )
  if (res.action !== "send") return assert.fail("wrong action")
  assert.equal(res.blocked, true)
  assert.equal(dispatched, false)
  assert.match(res.reason, /opted_out|lifecycle/)
})
