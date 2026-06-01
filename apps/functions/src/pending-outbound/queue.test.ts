/**
 * pa-pending-outbound queue writer tests.
 *
 * Drives `enqueuePendingOutbound` / `listPending` against an in-memory
 * Firestore fake (same shape as the one in
 * `src/external-supply/resolve-identity.test.ts`). Covers:
 *  - schema validation (bad input rejected)
 *  - idempotent enqueue (same key -> exactly one doc)
 *  - listPending status filtering
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  pendingOutboundDocId,
  type PendingOutbound,
} from "@pa/core-types"
import {
  enqueuePendingOutbound,
  listPending,
  type EnqueuePendingOutboundInput,
} from "./queue.js"

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
      async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
        const current = col(collectionName).get(docId)
        col(collectionName).set(
          docId,
          opts?.merge && current ? { ...current, ...data } : { ...data }
        )
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

function baseInput(
  over: Partial<EnqueuePendingOutboundInput> = {}
): EnqueuePendingOutboundInput {
  return {
    userId: "user-1",
    kind: "recovery",
    draftBody: "Hey, quick follow-up — still around?",
    whyQueued: "dup_send x4 on 2026-05-2x",
    reasonCode: "dup_send",
    sourceSessionId: "sess-abc",
    ...over,
  }
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

test("enqueuePendingOutbound applies defaults and persists a valid doc", async () => {
  const { db, store } = makeFakeFirestore()
  const res = await enqueuePendingOutbound(db, baseInput(), { now: () => NOW })

  const expectedId = pendingOutboundDocId({
    userId: "user-1",
    reasonCode: "dup_send",
    sourceSessionId: "sess-abc",
  })
  assert.equal(res.id, expectedId)
  assert.equal(res.id, "pending-user-1-dup-send-sess-abc")
  assert.equal(res.idempotent, false)

  const stored = store.get(PA_COLLECTIONS.pendingOutbound)!.get(expectedId) as
    | PendingOutbound
    | undefined
  assert.ok(stored)
  assert.equal(stored.id, expectedId)
  assert.equal(stored.channel, "imessage") // default
  assert.equal(stored.status, "pending") // default
  assert.equal(stored.suppressed, false) // default
  assert.equal(stored.version, 1) // default
  assert.equal(stored.createdAt, NOW)
  assert.equal(stored.toE164, null)
  assert.equal(stored.enrichmentSnapshot, null)
  assert.equal(stored.approvedBy, null)
})

test("enqueuePendingOutbound rejects invalid input (empty draftBody) without writing", async () => {
  const { db, store } = makeFakeFirestore()
  await assert.rejects(
    () =>
      enqueuePendingOutbound(db, baseInput({ draftBody: "" }), {
        now: () => NOW,
      }),
    /draftBody|String must contain|too_small|expected/i
  )
  assert.equal(store.get(PA_COLLECTIONS.pendingOutbound)!.size, 0)
})

test("enqueuePendingOutbound persists provided suppression + channel + snapshot", async () => {
  const { db } = makeFakeFirestore()
  const res = await enqueuePendingOutbound(
    db,
    baseInput({
      channel: "sms",
      suppressed: true,
      suppressedReason: "opted_out",
      enrichmentSnapshot: { targetRoleFunction: ["software_engineering"] },
      toE164: "+14243201960",
    }),
    { now: () => NOW }
  )
  assert.equal(res.doc.channel, "sms")
  assert.equal(res.doc.suppressed, true)
  assert.equal(res.doc.suppressedReason, "opted_out")
  assert.equal(res.doc.toE164, "+14243201960")
  assert.deepEqual(res.doc.enrichmentSnapshot, {
    targetRoleFunction: ["software_engineering"],
  })
})

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("enqueuePendingOutbound is idempotent — same key yields exactly one doc", async () => {
  const { db, store } = makeFakeFirestore()

  const first = await enqueuePendingOutbound(db, baseInput(), { now: () => NOW })
  assert.equal(first.idempotent, false)

  // Re-run the "backfill" with the same logical message (new body content).
  const second = await enqueuePendingOutbound(
    db,
    baseInput({ draftBody: "Updated draft after re-run" }),
    { now: () => "2026-06-01T13:00:00.000Z" }
  )
  assert.equal(second.id, first.id)
  assert.equal(second.idempotent, true)

  // Exactly one doc, overwritten with the latest content.
  assert.equal(store.get(PA_COLLECTIONS.pendingOutbound)!.size, 1)
  const stored = store
    .get(PA_COLLECTIONS.pendingOutbound)!
    .get(first.id) as PendingOutbound
  assert.equal(stored.draftBody, "Updated draft after re-run")
})

test("different reasonCode or sourceSessionId yields distinct docs", async () => {
  const { db, store } = makeFakeFirestore()
  await enqueuePendingOutbound(db, baseInput(), { now: () => NOW })
  await enqueuePendingOutbound(
    db,
    baseInput({ reasonCode: "dropoff", kind: "reengage" }),
    { now: () => NOW }
  )
  await enqueuePendingOutbound(db, baseInput({ sourceSessionId: "sess-xyz" }), {
    now: () => NOW,
  })
  // Null session collapses to the `nosession` segment (still distinct from above).
  await enqueuePendingOutbound(db, baseInput({ sourceSessionId: null }), {
    now: () => NOW,
  })
  assert.equal(store.get(PA_COLLECTIONS.pendingOutbound)!.size, 4)
})

// ---------------------------------------------------------------------------
// listPending filter
// ---------------------------------------------------------------------------

test("listPending defaults to status=pending and excludes other statuses", async () => {
  const { db } = makeFakeFirestore()
  await enqueuePendingOutbound(db, baseInput({ sourceSessionId: "s1" }), {
    now: () => NOW,
  })
  await enqueuePendingOutbound(
    db,
    baseInput({ sourceSessionId: "s2", status: "approved" }),
    { now: () => NOW }
  )
  await enqueuePendingOutbound(
    db,
    baseInput({ sourceSessionId: "s3", status: "sent" }),
    { now: () => NOW }
  )

  const pending = await listPending(db)
  assert.equal(pending.length, 1)
  assert.equal(pending[0]!.status, "pending")
  assert.equal(pending[0]!.sourceSessionId, "s1")
})

test("listPending with explicit status filters to that status", async () => {
  const { db } = makeFakeFirestore()
  await enqueuePendingOutbound(
    db,
    baseInput({ sourceSessionId: "s1", status: "approved" }),
    { now: () => NOW }
  )
  await enqueuePendingOutbound(
    db,
    baseInput({ sourceSessionId: "s2", status: "approved" }),
    { now: () => NOW }
  )
  await enqueuePendingOutbound(db, baseInput({ sourceSessionId: "s3" }), {
    now: () => NOW,
  })

  const approved = await listPending(db, { status: "approved" })
  assert.equal(approved.length, 2)
  assert.ok(approved.every((r) => r.status === "approved"))
})

test("listPending with status=null returns all rows; limit caps results", async () => {
  const { db } = makeFakeFirestore()
  await enqueuePendingOutbound(db, baseInput({ sourceSessionId: "s1" }), {
    now: () => NOW,
  })
  await enqueuePendingOutbound(
    db,
    baseInput({ sourceSessionId: "s2", status: "sent" }),
    { now: () => NOW }
  )

  const all = await listPending(db, { status: null })
  assert.equal(all.length, 2)

  const capped = await listPending(db, { status: null, limit: 1 })
  assert.equal(capped.length, 1)
})
