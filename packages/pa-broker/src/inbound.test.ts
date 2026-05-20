import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, type PaInboundEvent } from "@pa/core-types"
import {
  completeInboundEvent,
  createInboundEvent,
  failInboundEvent,
  listClaimableInboundIds,
  tryClaimInboundEvent,
} from "./inbound.js"

type QueryFilter = { field: string; op: string; value: unknown }

function isDeleteSentinel(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && value.constructor?.name === "DeleteTransform")
}

function applyPatch(current: Record<string, unknown>, patch: Record<string, unknown>) {
  const next = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (isDeleteSentinel(value)) delete next[key]
    else next[key] = value
  }
  return next
}

function fakeFirestore(initialDocs: Record<string, PaInboundEvent> = {}) {
  const docs = new Map<string, Record<string, unknown>>(Object.entries(initialDocs))
  const docRef = (id: string) => ({
    id,
    async create(data: Record<string, unknown>) {
      if (docs.has(id)) {
        const error = new Error("already exists") as Error & { code?: number }
        error.code = 6
        throw error
      }
      docs.set(id, { ...data })
    },
    async get() {
      const data = docs.get(id)
      return {
        id,
        exists: data != null,
        data: () => data,
      }
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      const current = docs.get(id) ?? {}
      docs.set(id, opts?.merge ? applyPatch(current, data) : { ...data })
    },
    async update(data: Record<string, unknown>) {
      const current = docs.get(id)
      if (!current) throw new Error(`missing doc ${id}`)
      docs.set(id, applyPatch(current, data))
    },
  })
  const db = {
    collection(collectionName: string) {
      assert.equal(collectionName, PA_COLLECTIONS.inboundEvents)
      const query = {
        filters: [] as QueryFilter[],
        orderField: null as string | null,
        max: Infinity,
        where(field: string, op: string, value: unknown) {
          this.filters.push({ field, op, value })
          return this
        },
        orderBy(field: string) {
          this.orderField = field
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
          let rows = [...docs.entries()].filter(([, data]) =>
            this.filters.every((f) => {
              if (f.op !== "==") throw new Error(`unsupported op ${f.op}`)
              return (data as Record<string, unknown>)[f.field] === f.value
            })
          )
          if (this.orderField) {
            const orderField = this.orderField
            rows = rows.sort((a, b) =>
              String((a[1] as Record<string, unknown>)[orderField] ?? "").localeCompare(
                String((b[1] as Record<string, unknown>)[orderField] ?? "")
              )
            )
          }
          return {
            docs: rows.slice(0, this.max).map(([id, data]) => ({
              id,
              data: () => data,
            })),
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
          const current = docs.get(ref.id)
          if (!current) throw new Error(`missing doc ${ref.id}`)
          docs.set(ref.id, applyPatch(current, data))
        },
      })
    },
  }
  return { db: db as unknown as Firestore, docs }
}

function inbound(id: string, patch: Partial<PaInboundEvent>): PaInboundEvent {
  return {
    id,
    channel: "imessage",
    status: "pending",
    idempotencyKey: id,
    rawPayload: {},
    createdAt: "2026-04-24T00:00:00.000Z",
    attemptCount: 0,
    maxAttempts: 8,
    correlationId: `corr-${id}`,
    ...patch,
  }
}

test("listClaimableInboundIds includes expired processing leases and skips active processing leases", async () => {
  const { db } = fakeFirestore({
    pending: inbound("pending", { status: "pending" }),
    expiredProcessing: inbound("expiredProcessing", {
      status: "processing",
      leaseUntil: "2000-01-01T00:00:00.000Z",
    }),
    activeProcessing: inbound("activeProcessing", {
      status: "processing",
      leaseUntil: "2999-01-01T00:00:00.000Z",
    }),
  })

  const ids = await listClaimableInboundIds(db)

  assert.deepEqual(ids.sort(), ["expiredProcessing", "pending"])
})

test("createInboundEvent is idempotent by idempotency key", async () => {
  const { db } = fakeFirestore()

  const first = await createInboundEvent(db, {
    channel: "imessage",
    idempotencyKey: "same-row",
    rawPayload: { text: "hi" },
  })
  const second = await createInboundEvent(db, {
    channel: "imessage",
    idempotencyKey: "same-row",
    rawPayload: { text: "changed" },
  })

  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(first.id, second.id)
  assert.deepEqual(second.event.rawPayload, { text: "hi" })
})

test("tryClaimInboundEvent claims pending and refuses active processing lease", async () => {
  const { db } = fakeFirestore({
    pending: inbound("pending", { status: "pending" }),
    active: inbound("active", { status: "processing", leaseUntil: "2999-01-01T00:00:00.000Z" }),
  })

  const claimed = await tryClaimInboundEvent(db, "pending", { claimerId: "orch-1", leaseMs: 1000 })
  const refused = await tryClaimInboundEvent(db, "active", { claimerId: "orch-1", leaseMs: 1000 })

  assert.equal(claimed?.status, "processing")
  assert.equal(claimed?.claimedBy, "orch-1")
  assert.equal(refused, null)
})

test("failInboundEvent increments attempts and dead-letters at max attempts", async () => {
  const { db, docs } = fakeFirestore({
    evt: inbound("evt", { status: "processing", attemptCount: 1, maxAttempts: 2 }),
  })

  await failInboundEvent(db, "evt", "boom")

  assert.equal(docs.get("evt")?.status, "dead_letter")
  assert.equal(docs.get("evt")?.attemptCount, 2)
  assert.equal(docs.get("evt")?.deadLetterReason, "boom")
  assert.equal(docs.get("evt")?.leaseUntil, null)
  assert.equal(docs.get("evt")?.claimedBy, null)
})

test("completeInboundEvent clears stale error and lease fields", async () => {
  const { db, docs } = fakeFirestore({
    evt: inbound("evt", {
      status: "failed",
      lastError: "old",
      deadLetterReason: "old dead letter",
      leaseUntil: "2999-01-01T00:00:00.000Z",
      claimedBy: "orch-old",
    }),
  })

  await completeInboundEvent(db, "evt", { userId: "u1", sessionId: "s1", agentTurnId: "t1" })

  assert.equal(docs.get("evt")?.status, "completed")
  assert.equal(docs.get("evt")?.lastError, undefined)
  assert.equal(docs.get("evt")?.deadLetterReason, undefined)
  assert.equal(docs.get("evt")?.leaseUntil, null)
  assert.equal(docs.get("evt")?.claimedBy, null)
  assert.equal(docs.get("evt")?.userId, "u1")
})

test("createInboundEvent stamps coalescing:true on create when input.coalescing=true (TD-A race fix)", async () => {
  // v1.5 TD-A (2026-05-03 Adam P0 race-condition): the SendBlue webhook now
  // pre-decides whether a row will be coalesced and asks broker to write the
  // flag on the SAME doc.create() call so onPaInbound's onDocumentCreated
  // trigger sees `coalescing:true` in its single read — no race window.
  const { db, docs } = fakeFirestore()
  const result = await createInboundEvent(db, {
    channel: "imessage",
    idempotencyKey: "td-a-with-flag",
    rawPayload: { text: "hi" },
    coalescing: true,
  })
  assert.equal(result.created, true)
  const written = docs.get(result.id) as Record<string, unknown> | undefined
  assert.ok(written, "doc was created")
  assert.equal(written!.coalescing, true, "coalescing flag stamped immediately")
  assert.equal(written!.status, "pending")
  assert.equal(written!.idempotencyKey, "td-a-with-flag")
})

test("createInboundEvent omits coalescing field when input.coalescing is absent or false", async () => {
  // Backward compatibility: every legacy caller (test-mode, admin path,
  // processCoalescedTurn synthesizing the merged event) MUST NOT have a
  // `coalescing` field stamped on their docs — that would cause onPaInbound
  // to skip them.
  const { db, docs } = fakeFirestore()
  const r1 = await createInboundEvent(db, {
    channel: "imessage",
    idempotencyKey: "td-a-no-flag",
    rawPayload: { text: "hi" },
  })
  const r2 = await createInboundEvent(db, {
    channel: "imessage",
    idempotencyKey: "td-a-flag-false",
    rawPayload: { text: "hi" },
    coalescing: false,
  })
  const w1 = docs.get(r1.id) as Record<string, unknown>
  const w2 = docs.get(r2.id) as Record<string, unknown>
  assert.equal("coalescing" in w1, false, "no field when omitted")
  assert.equal("coalescing" in w2, false, "no field when explicitly false (backward compat)")
})
