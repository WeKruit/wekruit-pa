import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, type ScheduledJob } from "@pa/core-types"
import {
  completeScheduledJob,
  enqueueScheduledJob,
  failScheduledJob,
  listDueScheduledJobIds,
  listStaleHeartbeats,
  tryClaimScheduledJob,
  writeRuntimeHeartbeat,
} from "./scheduled.js"

type QueryFilter = { field: string; op: string; value: unknown }

function isDeleteSentinel(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && value.constructor?.name === "DeleteTransform")
}

function merge(current: Record<string, unknown>, patch: Record<string, unknown>) {
  const next = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (isDeleteSentinel(value)) delete next[key]
    else next[key] = value
  }
  return next
}

function fakeFirestore(seed: Record<string, Record<string, Record<string, unknown>>> = {}) {
  const store = new Map(Object.entries(seed).map(([name, docs]) => [name, new Map(Object.entries(docs))]))
  const collectionMap = (name: string) => {
    let rows = store.get(name)
    if (!rows) {
      rows = new Map()
      store.set(name, rows)
    }
    return rows
  }
  const docRef = (collectionName: string, id: string) => ({
    id,
    async create(data: Record<string, unknown>) {
      if (collectionMap(collectionName).has(id)) throw new Error("exists")
      collectionMap(collectionName).set(id, { ...data })
    },
    async get() {
      const data = collectionMap(collectionName).get(id)
      return { id, exists: data != null, data: () => data }
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      const current = collectionMap(collectionName).get(id) ?? {}
      collectionMap(collectionName).set(id, opts?.merge ? merge(current, data) : { ...data })
    },
    async update(data: Record<string, unknown>) {
      const current = collectionMap(collectionName).get(id)
      if (!current) throw new Error(`missing ${id}`)
      collectionMap(collectionName).set(id, merge(current, data))
    },
  })
  const db = {
    collection(collectionName: string) {
      const query = {
        filters: [] as QueryFilter[],
        max: Infinity,
        where(field: string, op: string, value: unknown) {
          this.filters.push({ field, op, value })
          return this
        },
        limit(n: number) {
          this.max = n
          return this
        },
        doc(id: string) {
          return docRef(collectionName, id)
        },
        async get() {
          const rows = [...collectionMap(collectionName).entries()].filter(([, data]) =>
            this.filters.every((f) => {
              if (f.op !== "==") throw new Error(`unsupported op ${f.op}`)
              return data[f.field] === f.value
            })
          )
          return { docs: rows.slice(0, this.max).map(([id, data]) => ({ id, data: () => data })) }
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

function job(id: string, patch: Partial<ScheduledJob>): ScheduledJob {
  return {
    id,
    kind: "test",
    status: "pending",
    dueAt: "2026-04-24T00:00:00.000Z",
    payload: {},
    attemptCount: 0,
    maxAttempts: 2,
    backoffMs: 1000,
    createdAt: "2026-04-24T00:00:00.000Z",
    ...patch,
  }
}

test("scheduled jobs can be enqueued, listed, claimed, completed, and failed with backoff", async () => {
  const { db, store } = fakeFirestore()

  await enqueueScheduledJob(db, { id: "j1", kind: "test", dueAt: "2026-04-24T00:00:00.000Z" })
  assert.deepEqual(await listDueScheduledJobIds(db, { nowIso: "2026-04-24T00:01:00.000Z" }), ["j1"])

  const claimed = await tryClaimScheduledJob(db, "j1", { claimerId: "scheduler-1" })
  assert.equal(claimed?.status, "processing")
  await failScheduledJob(db, "j1", "boom")
  assert.equal(store.get(PA_COLLECTIONS.scheduledJobs)?.get("j1")?.status, "pending")
  assert.equal(store.get(PA_COLLECTIONS.scheduledJobs)?.get("j1")?.attemptCount, 1)

  await tryClaimScheduledJob(db, "j1", { claimerId: "scheduler-1" })
  await completeScheduledJob(db, "j1")
  assert.equal(store.get(PA_COLLECTIONS.scheduledJobs)?.get("j1")?.status, "completed")
  assert.equal(store.get(PA_COLLECTIONS.scheduledJobs)?.get("j1")?.lastError, undefined)
})

test("scheduled jobs dead-letter after max attempts and heartbeats report stale runtimes", async () => {
  const { db, store } = fakeFirestore({
    [PA_COLLECTIONS.scheduledJobs]: {
      j2: job("j2", { status: "processing", attemptCount: 1 }) as unknown as Record<string, unknown>,
    },
    [PA_COLLECTIONS.runtimeHeartbeats]: {
      old: { id: "old", runtimeId: "old", kind: "worker", status: "ok", lastSeenAt: "2026-04-24T00:00:00.000Z" },
      fresh: { id: "fresh", runtimeId: "fresh", kind: "worker", status: "ok", lastSeenAt: "2026-04-24T01:00:00.000Z" },
    },
  })

  await failScheduledJob(db, "j2", "again")
  await writeRuntimeHeartbeat(db, { runtimeId: "orch", kind: "orchestrator", status: "ok" })
  const stale = await listStaleHeartbeats(db, { olderThanIso: "2026-04-24T00:30:00.000Z" })

  assert.equal(store.get(PA_COLLECTIONS.scheduledJobs)?.get("j2")?.status, "dead_letter")
  assert.equal(store.get(PA_COLLECTIONS.runtimeHeartbeats)?.has("orchestrator_orch"), true)
  assert.deepEqual(stale.map((r) => r.id), ["old"])
})
