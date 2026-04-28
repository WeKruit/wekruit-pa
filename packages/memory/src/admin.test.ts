import assert from "node:assert/strict"
import test from "node:test"
import { isResetCommand, RESET_PATTERNS, summarizeClearResult } from "./admin.js"

test("isResetCommand matches all canonical patterns and ignores surrounding whitespace", () => {
  for (const p of RESET_PATTERNS) {
    assert.equal(isResetCommand(p), true, `should match canonical: ${p}`)
    assert.equal(isResetCommand(`  ${p}  `), true, `should match with whitespace: ${p}`)
  }
})

test("isResetCommand is case-insensitive for ASCII patterns only", () => {
  assert.equal(isResetCommand("__pa_reset__"), true)
  assert.equal(isResetCommand("__Pa_Reset__"), true)
  assert.equal(isResetCommand("/PA-RESET"), true)
  // Chinese pattern is exact-match only (no case folding for CJK)
  assert.equal(isResetCommand("重置我的记忆"), true)
})

test("isResetCommand rejects partial / surrounding text (must be full body)", () => {
  assert.equal(isResetCommand("hello __PA_RESET__"), false)
  assert.equal(isResetCommand("__PA_RESET__ now"), false)
  assert.equal(isResetCommand("请重置我的记忆吧"), false)
  assert.equal(isResetCommand("normal user message"), false)
  assert.equal(isResetCommand(""), false)
  assert.equal(isResetCommand("   "), false)
})

test("summarizeClearResult produces a tester-readable line for live runs", () => {
  const out = summarizeClearResult({
    userId: "u1",
    dryRun: false,
    qdrant: { collection: "pa-memory", matched: 7, deleted: true },
    firestore: { "pa-memory-facts": 2, "pa-messages": 18, "pa-memory-actions": 0 },
  })
  assert.match(out, /✓ 测试记忆已清空/)
  assert.match(out, /pa-memory=7/)
  assert.match(out, /pa-memory-facts=2/)
  assert.match(out, /pa-messages=18/)
  assert.doesNotMatch(out, /pa-memory-actions=0/)
})

test("summarizeClearResult flags dry-run results distinctly", () => {
  const out = summarizeClearResult({
    userId: "u1",
    dryRun: true,
    qdrant: { collection: "pa-memory", matched: 0, deleted: false },
    firestore: {},
  })
  assert.match(out, /\[DRY-RUN\]/)
  assert.match(out, /all empty/)
})

// ----------------------------------------------------------------------------
// Phase 11.3 — clearUserMemory partition-key passthrough
// ----------------------------------------------------------------------------

import type { Firestore } from "firebase-admin/firestore"
import { clearUserMemory, type ClearUserMemoryDeps } from "./admin.js"

/**
 * Fakes a Firestore that returns empty snapshots for every where()-query.
 * `clearFirestoreCollection` only reads via `.where("userId", "==", id).get()`
 * and writes via `.batch()`, so we just have to satisfy the read shape; with
 * no docs there are no batched writes to model.
 */
function makeEmptyFirestoreFake(): Firestore {
  const empty = {
    empty: true,
    size: 0,
    docs: [],
  } as unknown
  const where = () => ({ get: async () => empty })
  const collection = () => ({ where, get: async () => empty })
  return { collection } as unknown as Firestore
}

/** Capture every Qdrant request bodies for assertions. */
function makeQdrantFakes() {
  const calls: { url: string; body: unknown }[] = []
  const fetchFn: typeof fetch = (async (input: unknown, init: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, body })
    if (url.endsWith("/points/count")) {
      return new Response(JSON.stringify({ result: { count: 3 } }), { status: 200 })
    }
    if (url.includes("/points/delete")) {
      return new Response(JSON.stringify({ result: { status: "ok" } }), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

test("clearUserMemory: omitting mem0PartitionKey keeps legacy behavior (Qdrant filter user_id == userId)", async () => {
  const { calls, fetchFn } = makeQdrantFakes()
  const deps: ClearUserMemoryDeps = {
    db: makeEmptyFirestoreFake(),
    qdrantUrl: "https://qdrant.local",
    qdrantApiKey: "key",
    fetch: fetchFn,
  }
  await clearUserMemory("u1", deps, { keepMessages: true })
  const countCall = calls.find((c) => c.url.endsWith("/points/count"))
  assert.ok(countCall, "count call should fire")
  const filter = (countCall!.body as { filter: { must: { match: { value: string } }[] } }).filter
  assert.equal(filter.must[0]!.match.value, "u1")
})

test("clearUserMemory: explicit mem0PartitionKey scopes Qdrant filter to that key (NOT userId)", async () => {
  const { calls, fetchFn } = makeQdrantFakes()
  const deps: ClearUserMemoryDeps = {
    db: makeEmptyFirestoreFake(),
    qdrantUrl: "https://qdrant.local",
    qdrantApiKey: "key",
    fetch: fetchFn,
  }
  // userId="u1" is the Firestore canonical id; "alt_partition" is the Qdrant
  // partition. Per the contract Firestore deletes still scope by userId,
  // but Qdrant calls use the partition.
  await clearUserMemory("u1", deps, {
    keepMessages: true,
    mem0PartitionKey: "alt_partition",
  })
  const countCall = calls.find((c) => c.url.endsWith("/points/count"))!
  const delCall = calls.find((c) => c.url.includes("/points/delete"))!
  const cFilter = (countCall.body as { filter: { must: { match: { value: string } }[] } }).filter
  const dFilter = (delCall.body as { filter: { must: { match: { value: string } }[] } }).filter
  assert.equal(cFilter.must[0]!.match.value, "alt_partition")
  assert.equal(dFilter.must[0]!.match.value, "alt_partition")
})

test("clearUserMemory: empty/whitespace mem0PartitionKey falls back to userId (defensive)", async () => {
  const { calls, fetchFn } = makeQdrantFakes()
  const deps: ClearUserMemoryDeps = {
    db: makeEmptyFirestoreFake(),
    qdrantUrl: "https://qdrant.local",
    qdrantApiKey: "key",
    fetch: fetchFn,
  }
  await clearUserMemory("u1", deps, {
    keepMessages: true,
    mem0PartitionKey: "   ",
  })
  const countCall = calls.find((c) => c.url.endsWith("/points/count"))!
  const filter = (countCall.body as { filter: { must: { match: { value: string } }[] } }).filter
  assert.equal(filter.must[0]!.match.value, "u1")
})

test("clearUserMemory: dry-run with mem0PartitionKey still scopes count by partition (no delete)", async () => {
  const { calls, fetchFn } = makeQdrantFakes()
  const deps: ClearUserMemoryDeps = {
    db: makeEmptyFirestoreFake(),
    qdrantUrl: "https://qdrant.local",
    qdrantApiKey: "key",
    fetch: fetchFn,
  }
  const r = await clearUserMemory("u1", deps, {
    keepMessages: true,
    dryRun: true,
    mem0PartitionKey: "alt_partition",
  })
  assert.equal(r.dryRun, true)
  assert.equal(r.qdrant.deleted, false)
  assert.equal(r.qdrant.matched, 3)
  // Count call MUST use the partition.
  const countCall = calls.find((c) => c.url.endsWith("/points/count"))!
  assert.equal(
    (countCall.body as { filter: { must: { match: { value: string } }[] } }).filter.must[0]!.match
      .value,
    "alt_partition"
  )
  // Delete call MUST NOT have been made.
  assert.equal(calls.filter((c) => c.url.includes("/points/delete")).length, 0)
})
