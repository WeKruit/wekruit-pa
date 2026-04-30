/**
 * Phase 38 T4 — runMemoryPolicy orchestrator smoke tests.
 *
 * Coverage:
 * - Full pipeline happy path (with mocks for Firestore + embed + Mem0 + persona)
 * - Latency p95 < 200ms over 50 invocations on warm path (mocks return fast)
 * - Graceful degrade across all 4 deps (Firestore / embed / Mem0 / persona)
 * - Single-call concurrency (recentAdvice + detectContradiction parallel)
 */
import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"

import { runMemoryPolicy, _setEmbedFetchImpl, _resetEmbedCache } from "./index.js"
import type { AdviceTrackerDeps, MemoryPolicyContext, PersonaSnapshot } from "./types.js"

// ---------------------------------------------------------------------------
// Mock Firestore (same shape as advice-tracker.test.ts)
// ---------------------------------------------------------------------------

function makeMockFirestore(): { db: Firestore; reads: number; writes: number } {
  const items = new Map<string, Map<string, Record<string, unknown>>>()
  let reads = 0
  let writes = 0

  function makeUserDoc(userId: string) {
    if (!items.has(userId)) items.set(userId, new Map())
    const sub = items.get(userId)!
    return {
      collection: () => ({
        doc: (id: string) => ({
          async set(v: Record<string, unknown>) {
            writes += 1
            sub.set(id, v)
          },
        }),
        orderBy: () => ({
          limit: (n: number) => ({
            async get() {
              reads += 1
              const all = Array.from(sub.entries()).map(([id, data]) => ({ id, data }))
              all.sort((a, b) =>
                String(b.data.ts ?? "").localeCompare(String(a.data.ts ?? ""))
              )
              const sliced = all.slice(0, n)
              return {
                empty: sliced.length === 0,
                docs: sliced.map((r) => ({ id: r.id, data: () => r.data })),
              }
            },
          }),
        }),
      }),
    }
  }

  const db = {
    collection: () => ({
      doc: (userId: string) => makeUserDoc(userId),
    }),
  } as unknown as Firestore

  return {
    db,
    get reads() {
      return reads
    },
    get writes() {
      return writes
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("runMemoryPolicy: missing required field → returns empty result, no throw", async () => {
  const r = await runMemoryPolicy(
    { userId: "", turnId: "t", claireReply: "x" },
    {}
  )
  assert.equal(r.advice.recent.length, 0)
  assert.equal(r.advice.repeatScore.triggered, false)
  assert.equal(r.contradiction.violated, false)
  assert.equal(r.advice.injection, "")
})

test("runMemoryPolicy: full pipeline happy path with all mocks", async () => {
  const { db } = makeMockFirestore()
  const v1 = Float32Array.from(new Array(1024).fill(0.1))
  const embedFn = async (texts: string[]) => texts.map(() => v1)
  const mem0Search = async () => ["I'm vegetarian"]
  const persona: PersonaSnapshot = {
    soul: "Claire is gentle.",
    style: "",
    examples: "",
  }
  const getPersona = async () => persona

  const ctx: MemoryPolicyContext = {
    userId: "u_happy",
    turnId: "t1",
    claireReply: "try the steak place",
    userLang: "en",
  }
  const r = await runMemoryPolicy(ctx, { db, embedFn, mem0Search, getPersona })

  assert.ok(Array.isArray(r.advice.recent))
  assert.equal(r.advice.recent.length, 0, "no prior advice in fresh user")
  assert.equal(r.contradiction.violated, true)
  assert.equal(r.contradiction.type, "dietary")
  assert.equal(r.advice.injection, "", "no recent advice → empty injection")
})

test("runMemoryPolicy: with prior advice, generates injection", async () => {
  delete process.env.SILICONFLOW_API_KEY
  const { db } = makeMockFirestore()

  // Seed Firestore with two prior advice entries.
  const { trackAdvice } = await import("./advice-tracker.js")
  await trackAdvice("u_seed", "you should rest tonight", "t1", { db })
  await new Promise((r) => setTimeout(r, 5))
  await trackAdvice("u_seed", "you should drink more water", "t2", { db })
  await new Promise((r) => setTimeout(r, 5))

  const ctx: MemoryPolicyContext = {
    userId: "u_seed",
    turnId: "t3",
    claireReply: "you should rest more tonight",
    userLang: "en",
  }
  const r = await runMemoryPolicy(ctx, { db })

  assert.equal(r.advice.recent.length, 2)
  assert.ok(r.advice.injection.length > 0, "injection should be non-empty")
  assert.match(r.advice.injection, /\[MEMORY-POLICY\]/)
  assert.match(r.advice.injection, /Already-given advice/)
})

test("runMemoryPolicy: zh injection note when userLang=zh", async () => {
  const { db } = makeMockFirestore()
  const { trackAdvice } = await import("./advice-tracker.js")
  await trackAdvice("u_zh", "你应该多休息", "t1", { db })
  await new Promise((r) => setTimeout(r, 2))

  const ctx: MemoryPolicyContext = {
    userId: "u_zh",
    turnId: "t2",
    claireReply: "今晚早点睡",
    userLang: "zh",
  }
  const r = await runMemoryPolicy(ctx, { db })
  assert.match(r.advice.injection, /已经给过的建议/)
})

test("runMemoryPolicy: graceful degrade — missing all deps", async () => {
  const r = await runMemoryPolicy(
    {
      userId: "u",
      turnId: "t",
      claireReply: "any reply",
    },
    {}
  )
  assert.equal(r.advice.recent.length, 0)
  assert.equal(r.contradiction.violated, false)
  assert.equal(r.advice.injection, "")
  assert.ok(r.latencyMs >= 0)
})

test("runMemoryPolicy: latency p95 < 200ms over 50 invocations (warm path)", async () => {
  const { db } = makeMockFirestore()
  const v1 = Float32Array.from(new Array(1024).fill(0.5))
  const embedFn = async (texts: string[]) => texts.map(() => v1)
  const mem0Search = async () => ["fact 1", "fact 2"]
  const getPersona = async (): Promise<PersonaSnapshot> => ({
    soul: "neutral",
    style: "",
    examples: "",
  })

  // Pre-seed one entry so injection path runs too.
  const { trackAdvice } = await import("./advice-tracker.js")
  await trackAdvice("u_lat", "prior advice", "t0", { db, embedFn })

  const samples: number[] = []
  for (let i = 0; i < 50; i++) {
    const start = performance.now()
    await runMemoryPolicy(
      {
        userId: "u_lat",
        turnId: `t${i + 1}`,
        claireReply: `iteration ${i} — try this approach today`,
        userLang: "en",
      },
      { db, embedFn, mem0Search, getPersona }
    )
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  const p95 = samples[Math.floor(samples.length * 0.95)]
  assert.ok(p95 < 200, `p95 latency ${p95.toFixed(2)}ms exceeds 200ms budget`)
})

test("runMemoryPolicy: parallel concurrency — recentAdvice + contradiction overlap", async () => {
  const { db } = makeMockFirestore()
  let recentStarted = 0
  let recentCompleted = 0
  let contraStarted = 0
  let contraCompleted = 0

  // Wrap deps to track concurrent execution.
  const mem0Search = async () => {
    contraStarted += 1
    await new Promise((r) => setTimeout(r, 30))
    contraCompleted += 1
    return ["facts"]
  }

  // The recent path is via Firestore mock — instrument it via a wrapper db.
  const wrappedDb = {
    collection: (name: string) => ({
      doc: (uid: string) => ({
        collection: () => ({
          doc: (id: string) => ({
            async set(v: Record<string, unknown>) {
              const inner = (db as unknown as { collection: (n: string) => unknown }).collection(name) as {
                doc: (u: string) => {
                  collection: () => {
                    doc: (i: string) => { set: (v: Record<string, unknown>) => Promise<void> }
                  }
                }
              }
              return inner.doc(uid).collection().doc(id).set(v)
            },
          }),
          orderBy: () => ({
            limit: (n: number) => ({
              async get() {
                recentStarted += 1
                await new Promise((r) => setTimeout(r, 30))
                recentCompleted += 1
                const inner = (db as unknown as { collection: (n: string) => unknown }).collection(name) as {
                  doc: (u: string) => {
                    collection: () => {
                      orderBy: () => {
                        limit: (l: number) => {
                          get: () => Promise<{ empty: boolean; docs: { id: string; data: () => unknown }[] }>
                        }
                      }
                    }
                  }
                }
                return inner.doc(uid).collection().orderBy().limit(n).get()
              },
            }),
          }),
        }),
      }),
    }),
  } as unknown as Firestore

  const start = performance.now()
  await runMemoryPolicy(
    {
      userId: "u_concur",
      turnId: "t",
      claireReply: "any reply",
      userLang: "en",
    },
    { db: wrappedDb, mem0Search }
  )
  const wall = performance.now() - start

  assert.equal(recentStarted, 1)
  assert.equal(recentCompleted, 1)
  assert.equal(contraStarted, 1)
  assert.equal(contraCompleted, 1)
  // If sequential, wall would be ~60ms; parallel should be ~30-40ms.
  assert.ok(wall < 60, `expected parallel concurrency to keep wall < 60ms, got ${wall.toFixed(2)}ms`)
})

test("runMemoryPolicy: contradiction failure swallowed, advice still computes", async () => {
  const { db } = makeMockFirestore()
  const mem0Search = async () => {
    throw new Error("mem0 down")
  }
  const r = await runMemoryPolicy(
    {
      userId: "u",
      turnId: "t",
      claireReply: "any reply",
    },
    { db, mem0Search }
  )
  // Contradiction swallowed; advice still works.
  assert.equal(r.contradiction.violated, false)
  assert.equal(r.advice.recent.length, 0)
})

test("runMemoryPolicy: factsCache bypasses Mem0 search", async () => {
  let mem0Called = false
  const mem0Search = async () => {
    mem0Called = true
    return []
  }
  const r = await runMemoryPolicy(
    {
      userId: "u",
      turnId: "t",
      claireReply: "try the steakhouse",
      factsCache: ["I'm vegetarian"],
    },
    { mem0Search }
  )
  assert.equal(mem0Called, false, "factsCache should bypass mem0Search")
  assert.equal(r.contradiction.violated, true)
  assert.equal(r.contradiction.type, "dietary")
})

// Cleanup any embed fetch overrides
test("cleanup: reset embed fetch + cache after suite", () => {
  _setEmbedFetchImpl(null)
  _resetEmbedCache()
  assert.ok(true)
})
