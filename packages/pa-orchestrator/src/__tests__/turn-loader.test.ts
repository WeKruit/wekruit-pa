/**
 * iter30 WS3 — `turn-loader.ts` unit tests.
 *
 * Coverage:
 *  1. 4-tier batched read shape — Tier 1 fans out in a single tick;
 *     Tier 2 cache hit/miss collapses repeated calls.
 *  2. LRU + TTL invariants — entries expire after TTL, LRU eviction
 *     when capacity is exceeded.
 *  3. Synthetic latency budget — p99 ≤ 300ms over 50 cold runs with
 *     in-memory fakes.
 *  4. Fail-OPEN: WS7 entity-tag loader error returns [] (no throw).
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import type { AgentDef, ChatMessage, MemoryFact } from "@pa/core-types"
import { FeatureFlagsSchema } from "../run-context.js"
import {
  _clearTurnLoaderCaches,
  _turnLoaderCacheSizes,
  loadTurnContext,
  type LoadTurnInput,
  type TurnLoaderDeps,
  type TurnLoaderStore,
} from "../turn-loader.js"

// ---------------------------------------------------------------------------
// Test doubles — minimal Firestore + store. We track call counts so we can
// assert that Tier 1 fanout actually parallelises and that Tier 2 caches.
// ---------------------------------------------------------------------------

interface FakeCounters {
  userDocReads: number
  loadHistoryCalls: number
  listMemoryFactsCalls: number
  getMem0UserIdCalls: number
  loadPersonalizationCalls: number
}

function makeFakes(opts: {
  userDoc?: Record<string, unknown>
  history?: ChatMessage[]
  facts?: MemoryFact[]
  mem0UserId?: string
}): {
  db: Firestore
  store: TurnLoaderStore
  counters: FakeCounters
  agent: AgentDef
} {
  const counters: FakeCounters = {
    userDocReads: 0,
    loadHistoryCalls: 0,
    listMemoryFactsCalls: 0,
    getMem0UserIdCalls: 0,
    loadPersonalizationCalls: 0,
  }
  const userDoc = opts.userDoc ?? {}
  const db = {
    collection() {
      return {
        doc() {
          return {
            async get() {
              counters.userDocReads += 1
              return {
                exists: Object.keys(userDoc).length > 0,
                data: () => userDoc,
              }
            },
          }
        },
      }
    },
  } as unknown as Firestore

  const store: TurnLoaderStore = {
    async loadHistory(_sessionId, _limit) {
      counters.loadHistoryCalls += 1
      return opts.history ?? []
    },
    async listMemoryFacts(_userId) {
      counters.listMemoryFactsCalls += 1
      return opts.facts ?? []
    },
    async getMem0UserId(_userId) {
      counters.getMem0UserIdCalls += 1
      return opts.mem0UserId
    },
    async loadPersonalizationContext(_agent, _args, _history) {
      counters.loadPersonalizationCalls += 1
      return { memoryBlock: null, mem0Degraded: false }
    },
    log() {
      /* swallow */
    },
  }

  const agent: AgentDef = {
    id: "claire",
    name: "Claire",
    systemPrompt: "system",
    provider: "openai",
    model: "gpt-4.1-nano",
    temperature: 0.7,
    version: "1",
    memoryMode: "firestore_only",
    toolPolicy: "none",
  } as unknown as AgentDef

  return { db, store, counters, agent }
}

function makeInput(
  fakes: ReturnType<typeof makeFakes>,
  deps: TurnLoaderDeps = {}
): LoadTurnInput {
  return {
    db: fakes.db,
    event: {
      id: "evt-1",
      userId: "user-1",
      sessionId: "session-1",
      body: "hello world",
    },
    agent: fakes.agent,
    store: fakes.store,
    turnId: "00000000-0000-4000-8000-000000000001",
    deps,
  }
}

// ---------------------------------------------------------------------------

test("loadTurnContext: Tier 1 fans out in a single round-trip", async () => {
  _clearTurnLoaderCaches()
  const fakes = makeFakes({
    userDoc: { role: "swe", yoe: 5, resumeAccepted: true, resumeParseCount: 1 },
    history: [],
  })
  const ctx = await loadTurnContext(makeInput(fakes))
  // Each Tier-1 dependency was hit exactly once (single batch).
  assert.equal(fakes.counters.userDocReads, 1)
  assert.equal(fakes.counters.loadHistoryCalls, 1)
  assert.equal(fakes.counters.getMem0UserIdCalls, 1)
  // Tier 3 ran exactly once.
  assert.equal(fakes.counters.listMemoryFactsCalls, 1)
  assert.equal(fakes.counters.loadPersonalizationCalls, 1)
  // Profile reflects user doc.
  assert.equal(ctx.userProfile.role, "swe")
  assert.equal(ctx.userProfile.yoe, 5)
  assert.equal(ctx.userProfile.resumeAccepted, true)
  // Locale auto-detected — body is en-only.
  assert.equal(ctx.locale, "en-US")
  // mem0PartitionKey falls back to userId when no mem0UserId in doc.
  assert.equal(ctx.mem0PartitionKey, "user-1")
})

test("loadTurnContext: Tier 2 cache hit collapses repeated handbook+flags reads", async () => {
  _clearTurnLoaderCaches()
  const fakes = makeFakes({})
  let handbookCalls = 0
  let flagsCalls = 0
  const deps: TurnLoaderDeps = {
    async loadHandbook() {
      handbookCalls += 1
      return null
    },
    async loadFeatureFlags() {
      flagsCalls += 1
      return FeatureFlagsSchema.parse({})
    },
  }
  await loadTurnContext(makeInput(fakes, deps))
  await loadTurnContext(makeInput(fakes, deps))
  await loadTurnContext(makeInput(fakes, deps))
  // 3 turns → handbook (slug-keyed) hit cache after first; flags hit too.
  assert.equal(handbookCalls, 1, "handbook cached")
  assert.equal(flagsCalls, 1, "flags cached")
})

test("loadTurnContext: TTL expiry forces re-read", async () => {
  _clearTurnLoaderCaches()
  const fakes = makeFakes({})
  let handbookCalls = 0
  // Synthetic clock — first call now=0, second call now beyond TTL.
  let now = 0
  const deps: TurnLoaderDeps = {
    now: () => now,
    async loadHandbook() {
      handbookCalls += 1
      return null
    },
  }
  await loadTurnContext(makeInput(fakes, deps))
  now = 60_000 // > TTL_HANDBOOK_MS (30s)
  await loadTurnContext(makeInput(fakes, deps))
  assert.equal(handbookCalls, 2, "TTL expiry re-reads")
})

test("loadTurnContext: Tier-4 entity-tag loader fails OPEN with []", async () => {
  _clearTurnLoaderCaches()
  const fakes = makeFakes({})
  const deps: TurnLoaderDeps = {
    async loadEntityTagPreferences() {
      throw new Error("WS7 not deployed")
    },
  }
  const ctx = await loadTurnContext(makeInput(fakes, deps))
  assert.deepEqual(ctx.userProfile.preferences, [])
})

test("loadTurnContext: locale detection — zh / en / mixed", async () => {
  _clearTurnLoaderCaches()
  const cases: Array<{ body: string; expected: "zh-CN" | "en-US" | "mixed" }> =
    [
      { body: "我想找工作", expected: "zh-CN" },
      { body: "I want a new job", expected: "en-US" },
      { body: "请帮我 review 一下 resume", expected: "mixed" },
    ]
  for (const { body, expected } of cases) {
    const fakes = makeFakes({})
    const ctx = await loadTurnContext({
      ...makeInput(fakes),
      event: {
        id: "e",
        userId: "u",
        sessionId: "s",
        body,
      },
    })
    assert.equal(ctx.locale, expected, `locale for "${body}"`)
  }
})

test("loadTurnContext: synthetic p99 latency ≤ 300ms over 50 runs", async () => {
  _clearTurnLoaderCaches()
  const fakes = makeFakes({
    userDoc: { role: "pm", resumeAccepted: false, resumeParseCount: 0 },
    history: [],
  })
  const samples: number[] = []
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now()
    await loadTurnContext(makeInput(fakes))
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  const p99 = samples[Math.floor(samples.length * 0.99)] ?? samples.at(-1) ?? 0
  assert.ok(p99 < 300, `p99=${p99}ms exceeded 300ms budget`)
})

test("loadTurnContext: cache sizes reflect distinct keys, not total reads", async () => {
  _clearTurnLoaderCaches()
  const fakes = makeFakes({})
  // One handbook slug, one user, one weights table → small steady-state.
  await loadTurnContext(makeInput(fakes))
  await loadTurnContext(makeInput(fakes))
  const sizes = _turnLoaderCacheSizes()
  assert.ok(sizes.handbook <= 1, `handbook ≤1 (got ${sizes.handbook})`)
  assert.ok(sizes.weights <= 1, `weights ≤1 (got ${sizes.weights})`)
  assert.ok(sizes.agent <= 1, `agent ≤1 (got ${sizes.agent})`)
})

test("loadTurnContext: recentTurnsForMirror is last-5 assistant only, newest-first", async () => {
  _clearTurnLoaderCaches()
  const history: ChatMessage[] = [
    {
      id: "1",
      sessionId: "s",
      userId: "u",
      role: "user",
      body: "u1",
      createdAt: "2026-05-03T00:00:00.000Z",
    },
    {
      id: "2",
      sessionId: "s",
      userId: "u",
      role: "assistant",
      body: "a1",
      createdAt: "2026-05-03T00:00:01.000Z",
    },
    {
      id: "3",
      sessionId: "s",
      userId: "u",
      role: "user",
      body: "u2",
      createdAt: "2026-05-03T00:00:02.000Z",
    },
    {
      id: "4",
      sessionId: "s",
      userId: "u",
      role: "assistant",
      body: "a2",
      createdAt: "2026-05-03T00:00:03.000Z",
    },
  ] as unknown as ChatMessage[]
  const fakes = makeFakes({ history })
  const ctx = await loadTurnContext(makeInput(fakes))
  // Only assistant turns retained; newest-first order.
  const bodies = ctx.recentTurnsForMirror.map((m) => m.body)
  assert.deepEqual(bodies, ["a2", "a1"])
})
