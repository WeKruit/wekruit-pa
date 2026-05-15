/**
 * Phase B5 — `loadCompaniesByName` unit tests.
 *
 * Mirrors the V16 test style: uses MockFirestore as the Firestore double,
 * exercises cache miss/hit, missing-doc omission, and >10 batched chunks.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "../mock-firestore.js"
import {
  loadCompaniesByName,
  __resetLoadCompaniesCacheForTests,
  LOAD_COMPANIES_BATCH_SIZE,
} from "../../lib/load-companies.js"

// ---------------------------------------------------------------------------
// Read-tracking wrapper — counts every `doc().get()` for a given collection.
// ---------------------------------------------------------------------------

function withReadCounter(mfs: MockFirestore): { db: MockFirestore; reads: { count: number } } {
  const reads = { count: 0 }
  const originalCollection = mfs.collection.bind(mfs)
  // monkey-patch only the pa-companies collection
  ;(mfs as unknown as { collection: (p: string) => unknown }).collection = (path: string) => {
    const coll = originalCollection(path)
    if (path !== "pa-companies") return coll
    const originalDoc = (coll as { doc: (id: string) => { get: () => Promise<unknown> } }).doc.bind(coll)
    ;(coll as { doc: (id: string) => unknown }).doc = (id: string) => {
      const ref = originalDoc(id)
      const originalGet = ref.get.bind(ref)
      ref.get = async () => {
        reads.count++
        return originalGet()
      }
      return ref
    }
    return coll
  }
  return { db: mfs, reads }
}

// ---------------------------------------------------------------------------
// Case 1: Cache miss → Firestore fetch → returns mapped info
// ---------------------------------------------------------------------------

test("loadCompaniesByName: cache miss fetches from Firestore and returns mapped info", async () => {
  __resetLoadCompaniesCacheForTests()
  const mfs = new MockFirestore()
  await mfs.collection("pa-companies").doc("anthropic").set({
    id: "anthropic",
    displayName: "Anthropic",
    companyStage: "series_d_plus",
    companyTags: ["ai_native", "unicorn"],
  })
  await mfs.collection("pa-companies").doc("openai").set({
    id: "openai",
    displayName: "OpenAI",
    companyStage: "private_mature",
    companyTags: ["ai_native"],
  })

  const got = await loadCompaniesByName(asFirestore(mfs), ["Anthropic", "OpenAI"])
  assert.equal(got.size, 2)
  const a = got.get("anthropic")
  assert.ok(a)
  assert.equal(a!.stage, "series_d_plus")
  assert.deepEqual(a!.tags, ["ai_native", "unicorn"])
  const o = got.get("openai")
  assert.ok(o)
  assert.equal(o!.stage, "private_mature")
  assert.deepEqual(o!.tags, ["ai_native"])
})

// ---------------------------------------------------------------------------
// Case 2: Cache hit → no second Firestore read within 5 min
// ---------------------------------------------------------------------------

test("loadCompaniesByName: cache hit avoids second Firestore read", async () => {
  __resetLoadCompaniesCacheForTests()
  const mfs = new MockFirestore()
  await mfs.collection("pa-companies").doc("anthropic").set({
    companyStage: "series_d_plus",
    companyTags: ["ai_native"],
  })
  const { db, reads } = withReadCounter(mfs)

  // First call — should hit Firestore once.
  const first = await loadCompaniesByName(asFirestore(db), ["Anthropic"])
  assert.equal(first.size, 1)
  assert.equal(reads.count, 1, "first call should issue exactly one Firestore read")

  // Second call with same (variant-cased) name — should be cache hit, no read.
  const second = await loadCompaniesByName(asFirestore(db), ["anthropic"])
  assert.equal(second.size, 1)
  assert.equal(second.get("anthropic")?.stage, "series_d_plus")
  assert.equal(reads.count, 1, "second call should NOT issue another Firestore read")
})

// ---------------------------------------------------------------------------
// Case 3: Missing doc → omitted from result
// ---------------------------------------------------------------------------

test("loadCompaniesByName: missing docs are omitted (no unknown stub)", async () => {
  __resetLoadCompaniesCacheForTests()
  const mfs = new MockFirestore()
  await mfs.collection("pa-companies").doc("anthropic").set({
    companyStage: "series_d_plus",
    companyTags: ["ai_native"],
  })
  // "Walgreens" intentionally absent.

  const got = await loadCompaniesByName(asFirestore(mfs), ["Anthropic", "Walgreens"])
  assert.equal(got.size, 1)
  assert.ok(got.has("anthropic"))
  assert.equal(got.has("walgreens"), false)
})

// ---------------------------------------------------------------------------
// Case 4: >10 names → multiple batched reads (chunk size = 10)
// ---------------------------------------------------------------------------

test("loadCompaniesByName: more than 10 names triggers multiple batches", async () => {
  __resetLoadCompaniesCacheForTests()
  assert.equal(LOAD_COMPANIES_BATCH_SIZE, 10, "guard: batch size assumption")

  const mfs = new MockFirestore()
  const names: string[] = []
  for (let i = 0; i < 23; i++) {
    const name = `Co ${i}`
    names.push(name)
    // doc id derived from normalizeCompanyName: "Co 0" -> "co-0"
    await mfs.collection("pa-companies").doc(`co-${i}`).set({
      companyStage: "seed",
      companyTags: [`tag-${i}`],
    })
  }

  // Track how many parallel waves we issue by counting how many reads happen
  // before each `await` boundary in loadCompaniesByName. We just confirm all
  // 23 docs are returned + total read count = 23 (no double-fetching).
  const { db, reads } = withReadCounter(mfs)
  const got = await loadCompaniesByName(asFirestore(db), names)

  assert.equal(got.size, 23)
  assert.equal(reads.count, 23, "should issue exactly one read per unique normalized name")
  // Sanity-check sample
  assert.equal(got.get("co-0")?.stage, "seed")
  assert.deepEqual(got.get("co-22")?.tags, ["tag-22"])
})
