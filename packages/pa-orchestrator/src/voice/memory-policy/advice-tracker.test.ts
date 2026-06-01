/**
 * Phase 38 T1 — advice-tracker tests.
 *
 * Coverage:
 * - Firestore mock + bilingual lang detection
 * - cos-sim parity with Phase 35 F4 (re-exported `cosineSim`)
 * - LRU cache hit/miss
 * - Missing API key graceful degrade
 * - `recentAdvice` ordering (oldest-first after fetch)
 * - `repeatScore` triggered/non-triggered + threshold env override
 */
import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"

import {
  ADVICE_TRACKER_COLLECTION,
  _defaultEmbedFn,
  _resetEmbedCache,
  _setEmbedFetchImpl,
  cosineSim,
  detectReplyLang,
  recentAdvice,
  repeatScore,
  trackAdvice,
} from "./advice-tracker.js"
import type { AdviceTrackerEntry } from "./types.js"

// ---------------------------------------------------------------------------
// In-memory Firestore double — supports collection().doc().collection()
// pattern needed by `pa-advice-tracker/{userId}/items/{turnId}`.
// ---------------------------------------------------------------------------

interface MockSubcoll {
  items: Map<string, Record<string, unknown>>
}
interface MockStore {
  byUser: Map<string, MockSubcoll>
  writeCount: number
  readCount: number
}

function makeMockFirestore(): { db: Firestore; store: MockStore } {
  const store: MockStore = { byUser: new Map(), writeCount: 0, readCount: 0 }

  function getOrCreateSubcoll(userId: string): MockSubcoll {
    let s = store.byUser.get(userId)
    if (!s) {
      s = { items: new Map() }
      store.byUser.set(userId, s)
    }
    return s
  }

  function makeItemDoc(userId: string, turnId: string) {
    const s = getOrCreateSubcoll(userId)
    return {
      get id() {
        return turnId
      },
      async set(v: Record<string, unknown>) {
        store.writeCount += 1
        s.items.set(turnId, v)
      },
      async get() {
        const v = s.items.get(turnId)
        return { exists: v !== undefined, id: turnId, data: () => v }
      },
    }
  }

  function makeItemsCollection(userId: string) {
    const s = getOrCreateSubcoll(userId)
    return {
      doc(id: string) {
        return makeItemDoc(userId, id)
      },
      orderBy(_field: string, _dir: string) {
        return {
          limit(n: number) {
            return {
              async get() {
                store.readCount += 1
                // Sort by ts desc (matches Firestore semantics).
                const all = Array.from(s.items.entries()).map(([id, data]) => ({
                  id,
                  data,
                }))
                all.sort((a, b) =>
                  String(b.data.ts ?? "").localeCompare(String(a.data.ts ?? ""))
                )
                const sliced = all.slice(0, n)
                return {
                  empty: sliced.length === 0,
                  docs: sliced.map((r) => ({
                    id: r.id,
                    data: () => r.data,
                  })),
                }
              },
            }
          },
        }
      },
    }
  }

  function makeUserDoc(userId: string) {
    return {
      get id() {
        return userId
      },
      collection(name: string) {
        if (name !== "items") throw new Error(`unexpected subcollection ${name}`)
        return makeItemsCollection(userId)
      },
    }
  }

  function makeRootCollection(name: string) {
    if (name !== ADVICE_TRACKER_COLLECTION) {
      throw new Error(`unexpected collection ${name}`)
    }
    return {
      doc(userId: string) {
        return makeUserDoc(userId)
      },
    }
  }

  const db = {
    collection: (name: string) => makeRootCollection(name),
  } as unknown as Firestore

  return { db, store }
}

// ---------------------------------------------------------------------------
// detectReplyLang
// ---------------------------------------------------------------------------

// CJK helper — build Chinese sample text from codepoints so this test file
// has no literal CJK (detectReplyLang still classifies legacy/mixed input).
const cjk = (...cps: number[]) => String.fromCharCode(...cps)
// "你应该多锻炼"
const ZH_ADVICE = cjk(0x4f60, 0x5e94, 0x8be5, 0x591a, 0x953b, 0x70bc)

test("detectReplyLang: pure zh", () => {
  assert.equal(detectReplyLang(ZH_ADVICE), "zh")
})

test("detectReplyLang: pure en", () => {
  assert.equal(detectReplyLang("you should exercise more"), "en")
})

test("detectReplyLang: mixed code-switch (≥ 20% minority)", () => {
  // half-half ZH/EN → mixed: "today standup 又卡 lol 不知道怎么修"
  const body =
    "today standup " + cjk(0x53c8, 0x5361) + " lol " + cjk(0x4e0d, 0x77e5, 0x9053, 0x600e, 0x4e48, 0x4fee)
  assert.equal(detectReplyLang(body), "mixed")
})

test("detectReplyLang: zh majority with brief en term → still zh", () => {
  // tiny en sliver should NOT trigger mixed
  const body =
    cjk(0x6211, 0x7528, 0x4e86) + " React " +
    cjk(0x5199, 0x4e86, 0x4e00, 0x4e2a, 0x957f, 0x957f, 0x7684, 0x5e94, 0x7528, 0x7a0b, 0x5e8f,
        0x8fd8, 0x6709, 0x6570, 0x636e, 0x5e93, 0x8fd8, 0x6709, 0x7f13, 0x5b58)
  assert.equal(detectReplyLang(body), "zh")
})

test("detectReplyLang: empty string → en (default)", () => {
  assert.equal(detectReplyLang(""), "en")
})

// ---------------------------------------------------------------------------
// cosineSim parity
// ---------------------------------------------------------------------------

test("cosineSim: identical vectors → 1.0", () => {
  const a = Float32Array.from([1, 2, 3])
  const b = Float32Array.from([1, 2, 3])
  assert.ok(Math.abs(cosineSim(a, b) - 1.0) < 1e-6)
})

test("cosineSim: orthogonal vectors → 0", () => {
  const a = Float32Array.from([1, 0])
  const b = Float32Array.from([0, 1])
  assert.equal(cosineSim(a, b), 0)
})

test("cosineSim: zero vector → 0 (no NaN)", () => {
  const a = Float32Array.from([0, 0, 0])
  const b = Float32Array.from([1, 2, 3])
  assert.equal(cosineSim(a, b), 0)
})

// ---------------------------------------------------------------------------
// trackAdvice — Firestore writes
// ---------------------------------------------------------------------------

test("trackAdvice: writes Firestore entry with embed (mocked)", async (t) => {
  _resetEmbedCache()
  process.env.SILICONFLOW_API_KEY = "test_key"
  // Mock fetch to return a deterministic 1024-dim vector
  _setEmbedFetchImpl((async () => {
    return new Response(
      JSON.stringify({
        data: [{ embedding: new Array(1024).fill(0.1), index: 0 }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  }) as typeof fetch)
  t.after(() => {
    _setEmbedFetchImpl(null)
    delete process.env.SILICONFLOW_API_KEY
    _resetEmbedCache()
  })

  const { db, store } = makeMockFirestore()
  await trackAdvice("u1", ZH_ADVICE, "t1", { db })
  assert.equal(store.writeCount, 1)
  const userBucket = store.byUser.get("u1")
  assert.ok(userBucket)
  const entry = userBucket!.items.get("t1") as Record<string, unknown>
  assert.equal(entry.userId, "u1")
  assert.equal(entry.turnId, "t1")
  assert.equal(entry.text, ZH_ADVICE)
  assert.equal(entry.lang, "zh")
  assert.ok(Array.isArray(entry.embedding))
  assert.equal((entry.embedding as number[]).length, 1024)
  assert.equal(entry.schemaVersion, 1)
})

test("trackAdvice: missing API key → entry persisted with embedding=null", async () => {
  delete process.env.SILICONFLOW_API_KEY
  delete process.env.PA_OPENAI_AGENT_API_KEY
  delete process.env.PA_SILICONFLOW_API_KEY
  _resetEmbedCache()

  const { db, store } = makeMockFirestore()
  await trackAdvice("u2", "you should exercise more", "t2", { db })
  assert.equal(store.writeCount, 1)
  const entry = store.byUser.get("u2")!.items.get("t2") as Record<string, unknown>
  assert.equal(entry.text, "you should exercise more")
  assert.equal(entry.lang, "en")
  assert.equal(entry.embedding, null)
  assert.equal(entry.embeddedAt, null)
})

test("trackAdvice: missing db (deps={}) → noop, no throw", async () => {
  await trackAdvice("u3", "anything", "t3", {})
  // No assertion needed — just shouldn't throw
})

test("trackAdvice: missing required fields → noop, no throw", async () => {
  const { db, store } = makeMockFirestore()
  await trackAdvice("", "x", "t", { db })
  await trackAdvice("u", "", "t", { db })
  await trackAdvice("u", "x", "", { db })
  assert.equal(store.writeCount, 0)
})

test("trackAdvice: opts.strategy + uxState propagate", async () => {
  delete process.env.SILICONFLOW_API_KEY
  const { db, store } = makeMockFirestore()
  await trackAdvice("u4", "rest tonight", "t4", { db }, {
    strategy: "Suggestion",
    uxState: "SoftConcerned",
  })
  const entry = store.byUser.get("u4")!.items.get("t4") as Record<string, unknown>
  assert.equal(entry.strategy, "Suggestion")
  assert.equal(entry.uxState, "SoftConcerned")
})

test("trackAdvice: opts.lang override", async () => {
  delete process.env.SILICONFLOW_API_KEY
  const { db, store } = makeMockFirestore()
  await trackAdvice("u5", "hello", "t5", { db }, { lang: "mixed" })
  const entry = store.byUser.get("u5")!.items.get("t5") as Record<string, unknown>
  assert.equal(entry.lang, "mixed")
})

// ---------------------------------------------------------------------------
// recentAdvice — Firestore reads
// ---------------------------------------------------------------------------

test("recentAdvice: returns oldest-first (sliding-window semantics)", async () => {
  delete process.env.SILICONFLOW_API_KEY
  const { db } = makeMockFirestore()
  // Seed 5 entries with strictly increasing ts via injected timestamps.
  for (let i = 0; i < 5; i++) {
    // Ensure ts is monotonically increasing
    const ts = `2026-04-29T00:00:0${i}.000Z`
    // We can't easily inject ts, but `ts` is set via Date.now() per call.
    // So sleep 5ms between writes to ensure monotonic order.
    await new Promise((r) => setTimeout(r, 5))
    await trackAdvice("u_recent", `advice ${i}`, `t${i}`, { db })
    void ts
  }
  const got = await recentAdvice("u_recent", 3, { db })
  assert.equal(got.length, 3)
  // Oldest-first → indices 2,3,4 (most recent 3, but in oldest-first order)
  assert.equal(got[0].text, "advice 2")
  assert.equal(got[1].text, "advice 3")
  assert.equal(got[2].text, "advice 4")
})

test("recentAdvice: missing db → []", async () => {
  const got = await recentAdvice("u", 3, {})
  assert.deepEqual(got, [])
})

test("recentAdvice: empty subcollection → []", async () => {
  const { db } = makeMockFirestore()
  const got = await recentAdvice("u_nonexistent", 3, { db })
  assert.deepEqual(got, [])
})

test("recentAdvice: n=0 → []", async () => {
  const { db } = makeMockFirestore()
  await trackAdvice("u_nzero", "x", "t1", { db })
  const got = await recentAdvice("u_nzero", 0, { db })
  assert.deepEqual(got, [])
})

// ---------------------------------------------------------------------------
// repeatScore — cos-sim
// ---------------------------------------------------------------------------

function fakeEmbedFn(map: Map<string, Float32Array>) {
  return async (texts: string[]): Promise<(Float32Array | null)[] | null> => {
    return texts.map((t) => map.get(t) ?? null)
  }
}

test("repeatScore: identical text → triggered (maxSim ≈ 1.0)", async () => {
  const vec = Float32Array.from(new Array(1024).fill(0.1))
  const embedFn = fakeEmbedFn(
    new Map([
      ["repeat me", vec],
      ["repeat me again", vec],
    ])
  )
  const recent: AdviceTrackerEntry[] = [
    {
      userId: "u",
      turnId: "t1",
      text: "repeat me",
      lang: "en",
      embedding: null,
      embeddedAt: null,
      strategy: null,
      uxState: null,
      ts: "2026-04-29T00:00:00.000Z",
      schemaVersion: 1,
    },
  ]
  const r = await repeatScore("repeat me again", recent, { embedFn })
  assert.equal(r.triggered, true)
  assert.ok(r.maxSim !== null && r.maxSim > 0.99)
  assert.equal(r.mostSimilarIdx, 0)
})

test("repeatScore: dissimilar text → not triggered", async () => {
  const v1 = Float32Array.from([1, 0, 0])
  const v2 = Float32Array.from([0, 1, 0])
  const embedFn = fakeEmbedFn(
    new Map([
      ["text A", v1],
      ["text B", v2],
    ])
  )
  const recent: AdviceTrackerEntry[] = [
    {
      userId: "u",
      turnId: "t1",
      text: "text B",
      lang: "en",
      embedding: null,
      embeddedAt: null,
      strategy: null,
      uxState: null,
      ts: "2026-04-29T00:00:00.000Z",
      schemaVersion: 1,
    },
  ]
  const r = await repeatScore("text A", recent, { embedFn })
  assert.equal(r.triggered, false)
  assert.equal(r.maxSim, 0)
})

test("repeatScore: uses stored embedding when present (no extra network call)", async () => {
  const vec = Float32Array.from(new Array(1024).fill(0.5))
  let embedCalls = 0
  const embedFn = async (texts: string[]) => {
    embedCalls += 1
    return texts.map(() => vec)
  }
  const recent: AdviceTrackerEntry[] = [
    {
      userId: "u",
      turnId: "t1",
      text: "stored",
      lang: "en",
      embedding: Array.from(vec),
      embeddedAt: "2026-04-29T00:00:00.000Z",
      strategy: null,
      uxState: null,
      ts: "2026-04-29T00:00:00.000Z",
      schemaVersion: 1,
    },
  ]
  const r = await repeatScore("new reply", recent, { embedFn })
  // Only the new reply needed network embedding (stored entry already has one).
  assert.equal(embedCalls, 1)
  assert.equal(r.triggered, true)
})

test("repeatScore: empty reply → no_input (not triggered)", async () => {
  const r = await repeatScore("", [], {})
  assert.equal(r.triggered, false)
  assert.equal(r.reason, "no_input")
})

test("repeatScore: empty history → no_history (not triggered)", async () => {
  const r = await repeatScore("anything", [], {})
  assert.equal(r.triggered, false)
  assert.equal(r.reason, "no_history")
})

test("repeatScore: missing API key + missing stored embedding → graceful degrade", async () => {
  delete process.env.SILICONFLOW_API_KEY
  delete process.env.PA_OPENAI_AGENT_API_KEY
  delete process.env.PA_SILICONFLOW_API_KEY
  _resetEmbedCache()
  const recent: AdviceTrackerEntry[] = [
    {
      userId: "u",
      turnId: "t1",
      text: "stored without embed",
      lang: "en",
      embedding: null,
      embeddedAt: null,
      strategy: null,
      uxState: null,
      ts: "2026-04-29T00:00:00.000Z",
      schemaVersion: 1,
    },
  ]
  const r = await repeatScore("new reply", recent, {})
  assert.equal(r.triggered, false)
  assert.equal(r.maxSim, null)
  assert.match(r.reason, /skipped: no embed api key/)
})

test("repeatScore: env threshold override (PA_MEMORY_REPEAT_THRESHOLD=0.5)", async () => {
  process.env.PA_MEMORY_REPEAT_THRESHOLD = "0.5"
  // Vectors with cos-sim ≈ 0.6 — above 0.5 threshold (triggered) but below 0.85 default
  const v1 = Float32Array.from([1, 0])
  const v2 = Float32Array.from([0.6, 0.8])
  const embedFn = fakeEmbedFn(
    new Map([
      ["new", v1],
      ["old", v2],
    ])
  )
  const recent: AdviceTrackerEntry[] = [
    {
      userId: "u",
      turnId: "t1",
      text: "old",
      lang: "en",
      embedding: null,
      embeddedAt: null,
      strategy: null,
      uxState: null,
      ts: "2026-04-29T00:00:00.000Z",
      schemaVersion: 1,
    },
  ]
  const r = await repeatScore("new", recent, { embedFn })
  assert.equal(r.triggered, true)
  assert.ok(r.maxSim! > 0.5 && r.maxSim! < 0.85)
  delete process.env.PA_MEMORY_REPEAT_THRESHOLD
})

test("repeatScore: network error → graceful degrade (logged not thrown)", async () => {
  const embedFn = async () => {
    throw new Error("simulated network down")
  }
  const recent: AdviceTrackerEntry[] = [
    {
      userId: "u",
      turnId: "t1",
      text: "x",
      lang: "en",
      embedding: null,
      embeddedAt: null,
      strategy: null,
      uxState: null,
      ts: "2026-04-29T00:00:00.000Z",
      schemaVersion: 1,
    },
  ]
  const r = await repeatScore("y", recent, { embedFn })
  assert.equal(r.triggered, false)
  assert.equal(r.maxSim, null)
  assert.match(r.reason, /skipped: embed network error/)
})

// ---------------------------------------------------------------------------
// LRU cache hit (reuses _defaultEmbedFn)
// ---------------------------------------------------------------------------

test("_defaultEmbedFn: LRU cache hit avoids second network call", async (t) => {
  process.env.SILICONFLOW_API_KEY = "test_key"
  _resetEmbedCache()
  let networkCalls = 0
  _setEmbedFetchImpl((async () => {
    networkCalls += 1
    return new Response(
      JSON.stringify({
        data: [{ embedding: new Array(1024).fill(0.7), index: 0 }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  }) as typeof fetch)
  t.after(() => {
    _setEmbedFetchImpl(null)
    delete process.env.SILICONFLOW_API_KEY
    _resetEmbedCache()
  })

  await _defaultEmbedFn(["cached_text"])
  await _defaultEmbedFn(["cached_text"])
  await _defaultEmbedFn(["cached_text"])
  assert.equal(networkCalls, 1, "second + third calls should hit LRU cache")
})

test("_defaultEmbedFn: missing API key returns null", async () => {
  delete process.env.SILICONFLOW_API_KEY
  delete process.env.PA_OPENAI_AGENT_API_KEY
  delete process.env.PA_SILICONFLOW_API_KEY
  _resetEmbedCache()
  const r = await _defaultEmbedFn(["any text"])
  assert.equal(r, null)
})

test("_defaultEmbedFn: empty input array → []", async () => {
  const r = await _defaultEmbedFn([])
  assert.deepEqual(r, [])
})
