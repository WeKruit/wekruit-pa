import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import type { AgentDef } from "@pa/core-types"
import { afterAssistantTurn, loadPersonalizationContext, type MemoryStackDeps } from "./stacked.js"

const fakeDb = null as unknown as Firestore

const minimalAgent: AgentDef = {
  id: "ag1",
  name: "t",
  systemPrompt: "s",
  provider: "openai",
  model: "m",
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
