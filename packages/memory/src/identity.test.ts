import assert from "node:assert/strict"
import test from "node:test"
import {
  recordDriftIfAny,
  resolveMem0PartitionKey,
  __resetDriftCacheForTests,
} from "./identity.js"

// ---- resolveMem0PartitionKey ------------------------------------------------

test("resolveMem0PartitionKey: unset mem0UserId falls back to user.id", () => {
  assert.equal(resolveMem0PartitionKey({ id: "u1" }), "u1")
})

test("resolveMem0PartitionKey: mem0UserId set to same value as id returns id", () => {
  assert.equal(resolveMem0PartitionKey({ id: "u1", mem0UserId: "u1" }), "u1")
})

test("resolveMem0PartitionKey: mem0UserId set to different value wins", () => {
  assert.equal(
    resolveMem0PartitionKey({ id: "u1", mem0UserId: "alt_partition" }),
    "alt_partition"
  )
})

test("resolveMem0PartitionKey: empty-string mem0UserId is treated as unset", () => {
  assert.equal(resolveMem0PartitionKey({ id: "u1", mem0UserId: "" }), "u1")
})

test("resolveMem0PartitionKey: whitespace-only mem0UserId is treated as unset", () => {
  assert.equal(resolveMem0PartitionKey({ id: "u1", mem0UserId: "   " }), "u1")
})

test("resolveMem0PartitionKey: mem0UserId is trimmed when set", () => {
  assert.equal(
    resolveMem0PartitionKey({ id: "u1", mem0UserId: "  alt  " }),
    "alt"
  )
})

test("resolveMem0PartitionKey: null mem0UserId falls back to user.id", () => {
  // Some Firestore fixtures + zod-parsed shapes deliver `null` for cleared optionals.
  assert.equal(
    resolveMem0PartitionKey({ id: "u1", mem0UserId: null as unknown as string }),
    "u1"
  )
})

test("resolveMem0PartitionKey: throws TypeError when id is missing", () => {
  assert.throws(
    () => resolveMem0PartitionKey({ id: undefined as unknown as string }),
    /user\.id is required/
  )
})

test("resolveMem0PartitionKey: throws TypeError when id is empty/whitespace", () => {
  assert.throws(() => resolveMem0PartitionKey({ id: "" }), TypeError)
  assert.throws(() => resolveMem0PartitionKey({ id: "   " }), TypeError)
})

// ---- recordDriftIfAny -------------------------------------------------------

type FakeDb = {
  writes: { collection: string; id: string; data: unknown }[]
  collection: (name: string) => {
    doc: (id: string) => {
      set: (data: unknown) => Promise<void>
    }
  }
}

function makeFakeDb(opts: { fail?: boolean } = {}): FakeDb {
  const writes: FakeDb["writes"] = []
  return {
    writes,
    collection(name: string) {
      return {
        doc(id: string) {
          return {
            async set(data: unknown) {
              if (opts.fail) throw new Error("simulated firestore error")
              writes.push({ collection: name, id, data })
            },
          }
        },
      }
    },
  }
}

test("recordDriftIfAny: writes an audit row when keys differ", async () => {
  __resetDriftCacheForTests()
  const fake = makeFakeDb()
  const logs: string[] = []
  await recordDriftIfAny(
    { userId: "u1", mem0UserId: "alt", surface: "orchestrator_turn" },
    {
      db: fake as unknown as import("firebase-admin/firestore").Firestore,
      logger: (s) => logs.push(s),
      now: () => Date.parse("2026-04-26T00:00:00.000Z"),
    }
  )
  assert.equal(fake.writes.length, 1)
  assert.equal(fake.writes[0]!.collection, "pa-audit-events")
  const row = fake.writes[0]!.data as {
    kind: string
    userId: string
    actor: string
    meta: { mem0UserId: string; surface: string }
    createdAt: string
  }
  assert.equal(row.kind, "memory.identity_drift")
  assert.equal(row.userId, "u1")
  assert.equal(row.actor, "system")
  assert.equal(row.meta.mem0UserId, "alt")
  assert.equal(row.meta.surface, "orchestrator_turn")
  assert.equal(row.createdAt, "2026-04-26T00:00:00.000Z")
  // Console line also emitted.
  assert.ok(logs.some((l) => l.includes("memory.identity_drift")))
})

test("recordDriftIfAny: does NOT write when keys match", async () => {
  __resetDriftCacheForTests()
  const fake = makeFakeDb()
  await recordDriftIfAny(
    { userId: "u1", mem0UserId: "u1", surface: "orchestrator_turn" },
    { db: fake as unknown as import("firebase-admin/firestore").Firestore }
  )
  assert.equal(fake.writes.length, 0)
})

test("recordDriftIfAny: throttles repeat sightings of the same tuple", async () => {
  // Use an explicit per-test cache to avoid cross-test bleed.
  const cache = new Set<string>()
  const fake = makeFakeDb()
  for (let i = 0; i < 5; i++) {
    await recordDriftIfAny(
      { userId: "u1", mem0UserId: "alt", surface: "orchestrator_turn" },
      { db: fake as unknown as import("firebase-admin/firestore").Firestore, seenCache: cache }
    )
  }
  assert.equal(fake.writes.length, 1)
})

test("recordDriftIfAny: different surfaces fire independently", async () => {
  const cache = new Set<string>()
  const fake = makeFakeDb()
  await recordDriftIfAny(
    { userId: "u1", mem0UserId: "alt", surface: "orchestrator_turn" },
    { db: fake as unknown as import("firebase-admin/firestore").Firestore, seenCache: cache }
  )
  await recordDriftIfAny(
    { userId: "u1", mem0UserId: "alt", surface: "after_turn" },
    { db: fake as unknown as import("firebase-admin/firestore").Firestore, seenCache: cache }
  )
  await recordDriftIfAny(
    { userId: "u1", mem0UserId: "alt", surface: "memory_admin" },
    { db: fake as unknown as import("firebase-admin/firestore").Firestore, seenCache: cache }
  )
  assert.equal(fake.writes.length, 3)
})

test("recordDriftIfAny: Firestore write failure is swallowed", async () => {
  const cache = new Set<string>()
  const fake = makeFakeDb({ fail: true })
  const logs: string[] = []
  // Must NOT throw.
  await recordDriftIfAny(
    { userId: "u1", mem0UserId: "alt", surface: "orchestrator_turn" },
    {
      db: fake as unknown as import("firebase-admin/firestore").Firestore,
      seenCache: cache,
      logger: (s) => logs.push(s),
    }
  )
  // Console line for the drift was emitted before the write failed.
  assert.ok(logs.some((l) => l.includes("memory.identity_drift")))
  // The failure path also logs.
  assert.ok(logs.some((l) => l.includes("write_failed")))
})

test("recordDriftIfAny: missing db skips the firestore write but still logs", async () => {
  const cache = new Set<string>()
  const logs: string[] = []
  await recordDriftIfAny(
    { userId: "u1", mem0UserId: "alt", surface: "memory_admin" },
    { seenCache: cache, logger: (s) => logs.push(s) }
  )
  assert.ok(logs.some((l) => l.includes("memory.identity_drift")))
})
