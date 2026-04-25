import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  normalizeOutboundPeer,
  processOutboundJob,
  reclaimStuckOutboundJobs,
  shouldAppendOutboundTranscript,
} from "./outbox.js"

test("broker-managed outbound does not append a duplicate transcript message", () => {
  assert.equal(
    shouldAppendOutboundTranscript({ idempotencyKey: "out-imessage-in-19289" }),
    false
  )
})

test("dashboard playground outbound can append its operator transcript message", () => {
  assert.equal(shouldAppendOutboundTranscript({ idempotencyKey: "pg-user-123" }), true)
})

test("iMessage email handles are preserved as outbound peers", () => {
  assert.equal(normalizeOutboundPeer("Admin1@WeKruit.com"), "admin1@wekruit.com")
})

test("phone outbound peers are normalized to E.164", () => {
  assert.equal(normalizeOutboundPeer("(215) 403-4668"), "+12154034668")
})

type QueryFilter = { field: string; op: string; value: unknown }

function fakeFirestore(docs: Record<string, Record<string, unknown>>) {
  const store = new Map(Object.entries(docs))
  const docRef = (id: string) => ({
    id,
    async get() {
      const data = store.get(id)
      return { id, exists: data != null, data: () => data }
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      const current = store.get(id) ?? {}
      store.set(id, opts?.merge ? { ...current, ...data } : { ...data })
    },
    async update(data: Record<string, unknown>) {
      const current = store.get(id)
      if (!current) throw new Error(`missing doc ${id}`)
      store.set(id, { ...current, ...data })
    },
  })
  const db = {
    collection(collectionName: string) {
      assert.equal(collectionName, PA_COLLECTIONS.outbound)
      const query = {
        filters: [] as QueryFilter[],
        max: Infinity,
        where(field: string, op: string, value: unknown) {
          this.filters.push({ field, op, value })
          return this
        },
        orderBy() {
          return this
        },
        limit(n: number) {
          this.max = n
          return this
        },
        doc(id: string) {
          return docRef(id)
        },
        async get() {
          const rows = [...store.entries()].filter(([, data]) =>
            this.filters.every((f) => {
              if (f.op !== "==") throw new Error(`unsupported op ${f.op}`)
              return data[f.field] === f.value
            })
          )
          return {
            empty: rows.length === 0,
            docs: rows.slice(0, this.max).map(([id, data]) => ({ id, data: () => data })),
          }
        },
      }
      return query
    },
    async runTransaction<T>(
      fn: (t: {
        get(ref: ReturnType<typeof docRef>): Promise<{ id: string; exists: boolean; data(): Record<string, unknown> | undefined }>
        update(ref: ReturnType<typeof docRef>, data: Record<string, unknown>): void
      }) => Promise<T>
    ) {
      return fn({
        async get(ref) {
          return ref.get()
        },
        update(ref, data) {
          void ref.update(data)
        },
      })
    },
  }
  return { db: db as unknown as Firestore, store }
}

test("allowlist mismatch marks outbound failed instead of leaving it stuck in sending", async () => {
  const previous = process.env.PA_OUTBOUND_ALLOWLIST_E164
  process.env.PA_OUTBOUND_ALLOWLIST_E164 = "+12154034668"
  try {
    const { db, store } = fakeFirestore({
      out1: {
        status: "pending",
        userId: "u1",
        toE164: "+19999999999",
        body: "blocked",
        createdAt: "2026-04-24T00:00:00.000Z",
      },
    })

    await processOutboundJob(db, { send: async () => undefined } as never, () => undefined, "out1", store.get("out1")!)

    assert.equal(store.get("out1")?.status, "failed")
    assert.equal(store.get("out1")?.error, "blocked by PA_OUTBOUND_ALLOWLIST_E164")
  } finally {
    if (previous == null) delete process.env.PA_OUTBOUND_ALLOWLIST_E164
    else process.env.PA_OUTBOUND_ALLOWLIST_E164 = previous
  }
})

test("stuck sending outbound rows can be reclaimed to pending", async () => {
  const { db, store } = fakeFirestore({
    old: { status: "sending", updatedAt: "2026-04-24T00:00:00.000Z" },
    fresh: { status: "sending", updatedAt: "2026-04-24T01:00:00.000Z" },
    pending: { status: "pending", updatedAt: "2026-04-24T00:00:00.000Z" },
  })

  const reclaimed = await reclaimStuckOutboundJobs(db, {
    olderThanIso: "2026-04-24T00:30:00.000Z",
  })

  assert.deepEqual(reclaimed, ["old"])
  assert.equal(store.get("old")?.status, "pending")
  assert.equal(store.get("old")?.error, "reclaimed from stuck sending")
  assert.equal(store.get("fresh")?.status, "sending")
})
