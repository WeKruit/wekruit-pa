import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, type AgentDef } from "@pa/core-types"
import {
  afterAssistantTurn,
  isSurpriseEligible,
  loadPersonalizationContext,
  type MemoryStackDeps,
} from "./stacked.js"
import { mem0Search } from "./mem0.js"

const fakeDb = null as unknown as Firestore

const minimalAgent: AgentDef = {
  id: "ag1",
  name: "t",
  systemPrompt: "s",
  provider: "openai",
  model: "m",
  status: "published",
  temperature: 0.7,
  memoryMode: "mem0",
  toolPolicy: "none",
  version: "1",
}

test("firestore_only does not call Mem0 search or add", async () => {
  let searchCalls = 0
  let addCalls = 0
  const deps: MemoryStackDeps = {
    getMem0Config: () => ({ apiKey: "should-not-matter" }),
    mem0Search: async () => {
      searchCalls++
      return []
    },
    mem0Add: async () => {
      addCalls++
    },
  }
  const r = await loadPersonalizationContext(
    fakeDb,
    { userId: "u1", sessionId: "s1", userMessage: "hi", memoryMode: "firestore_only" },
    [],
    deps
  )
  assert.equal(searchCalls, 0)
  assert.equal(addCalls, 0)
  assert.equal(r.mem0Degraded, false)
})

test("mem0 with config runs search; writeback calls add", async () => {
  let searchCalls = 0
  let addCalls = 0
  const deps: MemoryStackDeps = {
    getMem0Config: () => ({ apiKey: "k" }),
    mem0Search: async () => {
      searchCalls++
      return ["line1"]
    },
    mem0Add: async () => {
      addCalls++
    },
  }
  const load = await loadPersonalizationContext(
    fakeDb,
    { userId: "u1", sessionId: "s1", userMessage: "hi", memoryMode: "mem0" },
    [],
    deps
  )
  assert.equal(searchCalls, 1)
  assert.equal(load.mem0SearchResultCount, 1)
  assert.ok((load.memoryBlock || "").includes("line1"))

  const after = await afterAssistantTurn(
    fakeDb,
    minimalAgent,
    {
      userId: "u1",
      sessionId: "s1",
      userText: "hi",
      assistantText: "there",
      memoryMode: "mem0",
    },
    deps
  )
  assert.equal(addCalls, 1)
  assert.equal(after.writebackRan, true)
  assert.equal(after.writebackSkipReason, null)
})

test("mem0 without config returns degraded and does not throw on load", async () => {
  const deps: MemoryStackDeps = {
    getMem0Config: () => null,
    mem0Search: async () => {
      throw new Error("should not run")
    },
    mem0Add: async () => {},
  }
  const r = await loadPersonalizationContext(
    fakeDb,
    { userId: "u1", sessionId: "s1", userMessage: "hi", memoryMode: "mem0" },
    [],
    deps
  )
  assert.equal(r.mem0Degraded, true)
  assert.equal(r.mem0DegradedReason, "no_api_key")
})

test("search failure sets degraded and does not throw", async () => {
  const deps: MemoryStackDeps = {
    getMem0Config: () => ({ apiKey: "k" }),
    mem0Search: async () => {
      throw new Error("network")
    },
    mem0Add: async () => {},
  }
  const r = await loadPersonalizationContext(
    fakeDb,
    { userId: "u1", sessionId: "s1", userMessage: "hi", memoryMode: "both" },
    [],
    deps
  )
  assert.equal(r.mem0Degraded, true)
  assert.equal(r.mem0DegradedReason, "search_failed")
})

test("add failure returns add_failed", async () => {
  const deps: MemoryStackDeps = {
    getMem0Config: () => ({ apiKey: "k" }),
    mem0Search: async () => [],
    mem0Add: async () => {
      throw new Error("add")
    },
  }
  const after = await afterAssistantTurn(
    fakeDb,
    minimalAgent,
    {
      userId: "u1",
      sessionId: "s1",
      userText: "a",
      assistantText: "b",
      memoryMode: "mem0",
    },
    deps
  )
  assert.equal(after.writebackRan, false)
  assert.equal(after.writebackSkipReason, "add_failed")
})

function fakePersonaDb(rows: Record<string, unknown>[]) {
  return {
    collection(collectionName: string) {
      assert.equal(collectionName, PA_COLLECTIONS.memoryFacts)
      const filters: { field: string; value: unknown }[] = []
      return {
        where(field: string, op: string, value: unknown) {
          assert.equal(op, "==")
          filters.push({ field, value })
          return this
        },
        limit() {
          return this
        },
        async get() {
          const docs = rows
            .filter((row) => filters.every((f) => row[f.field] === f.value))
            .map((row) => ({ id: String(row.id), data: () => row }))
          return { docs }
        },
      }
    },
  } as unknown as Firestore
}

test("firestore persona card includes confirmed non-sensitive facts deterministically", async () => {
  const db = fakePersonaDb([
    { id: "2", userId: "u1", key: "goal", value: "ship faster", status: "confirmed", sensitivity: "low", createdAt: "now" },
    { id: "1", userId: "u1", key: "boundary", value: "no spam", status: "confirmed", sensitivity: "low", createdAt: "now" },
    { id: "3", userId: "u1", key: "secret", value: "hidden", status: "confirmed", sensitivity: "high", createdAt: "now" },
    { id: "4", userId: "u1", key: "draft", value: "maybe", status: "proposed", sensitivity: "low", createdAt: "now" },
  ])

  const r = await loadPersonalizationContext(
    db,
    { userId: "u1", sessionId: "s1", userMessage: "hi", memoryMode: "firestore_only" },
    []
  )

  assert.equal(r.memoryBlock, "Confirmed persona facts:\n- boundary: no spam\n- goal: ship faster")
})

test("surprise protocol is opt-in, cooldown-bound, and sensitivity-aware", () => {
  assert.equal(isSurpriseEligible({ optedIn: false }), false)
  assert.equal(isSurpriseEligible({ optedIn: true, sensitivity: "high" }), false)
  assert.equal(
    isSurpriseEligible({
      optedIn: true,
      lastSurpriseAt: "2026-04-23T00:00:00.000Z",
      now: new Date("2026-04-24T00:00:00.000Z"),
    }),
    false
  )
  assert.equal(
    isSurpriseEligible({
      optedIn: true,
      lastSurpriseAt: "2026-04-01T00:00:00.000Z",
      now: new Date("2026-04-24T00:00:00.000Z"),
    }),
    true
  )
})

test("Mem0 OSS search normalizes results response shape", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer k")
    return {
      ok: true,
      json: async () => ({ results: [{ memory: "oss memory" }] }),
    } as Response
  }) as typeof fetch
  try {
    assert.deepEqual(await mem0Search({ apiKey: "k", apiMode: "oss", baseUrl: "http://mem0.local" }, "q", "u"), [
      "oss memory",
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})
