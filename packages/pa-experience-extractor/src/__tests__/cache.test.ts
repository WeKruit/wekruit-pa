/**
 * cache.ts tests — in-memory implementation idempotency + production
 * binding path correctness via a stub Firestore.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  inMemoryExtractionCache,
  firestoreExtractionCache,
  workEntryDocPath,
} from "../cache.js"
import { computeEntryId } from "../entry-id.js"
import type { WorkEntryExtractionOutput } from "../types.js"

function makeOutput(overrides: Partial<WorkEntryExtractionOutput> = {}): WorkEntryExtractionOutput {
  return {
    entryId: "default-entry",
    extractedSkills: ["python"],
    durationMonths: 24,
    industryGuess: null,
    responsibilityLevel: "individual_contributor",
    confidence: 0.8,
    llmModel: "gpt-5.4-nano",
    extractedAt: "2026-05-22T00:00:00.000Z",
    ...overrides,
  }
}

test("inMemoryExtractionCache: write then read returns same value", async () => {
  const cache = inMemoryExtractionCache()
  const value = makeOutput({ entryId: "e1" })
  await cache.write("u1", value)
  const read = await cache.read("u1", "e1")
  assert.deepEqual(read, value)
})

test("inMemoryExtractionCache: read of missing key returns null", async () => {
  const cache = inMemoryExtractionCache()
  const read = await cache.read("u1", "missing")
  assert.equal(read, null)
})

test("inMemoryExtractionCache: write twice overwrites (idempotent on same id)", async () => {
  const cache = inMemoryExtractionCache()
  const v1 = makeOutput({ entryId: "e1", extractedSkills: ["python"] })
  const v2 = makeOutput({ entryId: "e1", extractedSkills: ["python", "go"] })
  await cache.write("u1", v1)
  await cache.write("u1", v2)
  const read = await cache.read("u1", "e1")
  assert.deepEqual(read?.extractedSkills, ["python", "go"])
})

test("inMemoryExtractionCache: scoping per uid", async () => {
  const cache = inMemoryExtractionCache()
  await cache.write("u1", makeOutput({ entryId: "e1", extractedSkills: ["x"] }))
  await cache.write("u2", makeOutput({ entryId: "e1", extractedSkills: ["y"] }))
  assert.deepEqual((await cache.read("u1", "e1"))?.extractedSkills, ["x"])
  assert.deepEqual((await cache.read("u2", "e1"))?.extractedSkills, ["y"])
})

test("computeEntryId: same input → same hash (idempotent)", () => {
  const a = computeEntryId({ uid: "u1", index: 0, title: "SWE", startDate: "2022-01" })
  const b = computeEntryId({ uid: "u1", index: 0, title: "SWE", startDate: "2022-01" })
  assert.equal(a, b)
})

test("computeEntryId: different title → different hash", () => {
  const a = computeEntryId({ uid: "u1", index: 0, title: "SWE", startDate: "2022-01" })
  const b = computeEntryId({ uid: "u1", index: 0, title: "Senior SWE", startDate: "2022-01" })
  assert.notEqual(a, b)
})

test("computeEntryId: title casing/whitespace normalized", () => {
  const a = computeEntryId({ uid: "u1", index: 0, title: "  Software Engineer  ", startDate: "2022-01" })
  const b = computeEntryId({ uid: "u1", index: 0, title: "software engineer", startDate: "2022-01" })
  assert.equal(a, b)
})

test("workEntryDocPath: shape matches plan §5 (pa-users/{uid}/workEntries/{entryId})", () => {
  assert.equal(workEntryDocPath("u1", "e1"), "pa-users/u1/workEntries/e1")
})

// firestoreExtractionCache stub test — exercises the path-building +
// fall-through-on-malformed-doc behavior with a minimal Firestore-like fake.
test("firestoreExtractionCache: returns null for missing doc", async () => {
  const stub = makeFirestoreStub({})
  const cache = firestoreExtractionCache(stub.db)
  const read = await cache.read("u1", "missing")
  assert.equal(read, null)
})

test("firestoreExtractionCache: round-trip via stub Firestore", async () => {
  const stub = makeFirestoreStub({})
  const cache = firestoreExtractionCache(stub.db)
  const value = makeOutput({ entryId: "rt-1" })
  await cache.write("u1", value)
  const read = await cache.read("u1", "rt-1")
  assert.deepEqual(read, value)
})

test("firestoreExtractionCache: malformed cache doc → null (treat as miss)", async () => {
  const stub = makeFirestoreStub({
    "pa-users/u1/workEntries/bad": { totallyNotTheSchema: true },
  })
  const cache = firestoreExtractionCache(stub.db)
  const read = await cache.read("u1", "bad")
  assert.equal(read, null)
})

// ---------------------------------------------------------------------------
// Minimal Firestore stub — enough surface for the cache module.
// ---------------------------------------------------------------------------

function makeFirestoreStub(initial: Record<string, unknown>) {
  const store = new Map<string, unknown>(Object.entries(initial))

  function docHandle(path: string) {
    return {
      async get() {
        const exists = store.has(path)
        return {
          exists,
          data: () => (exists ? (store.get(path) as Record<string, unknown>) : undefined),
        }
      },
      async set(value: unknown, _opts?: { merge?: boolean }) {
        store.set(path, value)
      },
      collection(sub: string) {
        return collectionHandle(`${path}/${sub}`)
      },
    }
  }
  function collectionHandle(path: string) {
    return {
      doc(id: string) {
        return docHandle(`${path}/${id}`)
      },
    }
  }
  return {
    db: { collection: (name: string) => collectionHandle(name) } as unknown as import("firebase-admin/firestore").Firestore,
    store,
  }
}
