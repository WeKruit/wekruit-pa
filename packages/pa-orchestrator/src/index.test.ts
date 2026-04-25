import assert from "node:assert/strict"
import test from "node:test"
import type { AgentDef, InboundEvent } from "@pa/core-types"
import { isInboundLeaseExpired, processInboundEvent, type OrchestratorStore } from "./index.js"

const agent: AgentDef = {
  id: "default",
  name: "Default",
  systemPrompt: "You are concise.",
  provider: "openai",
  model: "gpt-4o-mini",
  temperature: 0.7,
  memoryMode: "firestore_only",
  toolPolicy: "none",
  version: "1",
  isDefault: true,
}

function makeStore(overrides: Partial<OrchestratorStore> = {}): OrchestratorStore {
  const facts: { id: string; content: string }[] = []
  const calls: string[] = []
  return {
    markEventRunning: async () => {
      calls.push("markEventRunning")
    },
    markEventSucceeded: async () => {
      calls.push("markEventSucceeded")
    },
    markEventFailed: async () => {
      calls.push("markEventFailed")
    },
    createTurn: async () => "turn1",
    updateTurn: async () => undefined,
    appendMessage: async () => undefined,
    getAgentForUser: async () => agent,
    loadHistory: async () => [],
    enqueueOutbound: async () => undefined,
    listMemoryFacts: async () => facts,
    createMemoryFact: async (_userId, content) => {
      facts.push({ id: `f${facts.length + 1}`, content })
      return facts[facts.length - 1]!.id
    },
    deleteMemoryFacts: async (_userId, ids) => {
      for (const id of ids) {
        const idx = facts.findIndex((f) => f.id === id)
        if (idx >= 0) facts.splice(idx, 1)
      }
    },
    recordMemoryAction: async () => undefined,
    loadPersonalizationContext: async () => ({
      memoryBlock: null,
      mem0Degraded: false,
      mem0SearchResultCount: 0,
      mem0DegradedReason: null,
    }),
    runAgentTurn: async () => ({ text: "assistant reply" }),
    afterAssistantTurn: async () => ({ writebackRan: false, writebackSkipReason: "memory_mode" }),
    nowIso: () => "2026-04-25T12:00:00.000Z",
    log: () => undefined,
    ...overrides,
  }
}

const baseEvent: InboundEvent = {
  id: "evt1",
  userId: "u1",
  sessionId: "s1",
  channel: "imessage",
  externalChatId: "+13125550123",
  from: "+13125550123",
  body: "hi",
  status: "pending",
  createdAt: "2026-04-25T12:00:00.000Z",
  idempotencyKey: "imessage-in-1",
}

test("processInboundEvent handles remember command without calling LLM", async () => {
  let llmCalls = 0
  const store = makeStore({
    runAgentTurn: async () => {
      llmCalls++
      return { text: "bad" }
    },
  })
  await processInboundEvent({ ...baseEvent, body: "记住 我喜欢冰美式" }, store)

  const facts = await store.listMemoryFacts("u1")
  assert.equal(llmCalls, 0)
  assert.deepEqual(facts.map((f) => f.content), ["我喜欢冰美式"])
})

test("processInboundEvent does not duplicate an existing confirmed fact", async () => {
  const outbound: string[] = []
  const store = makeStore({
    enqueueOutbound: async (_userId, _to, body) => {
      outbound.push(body)
    },
  })
  await processInboundEvent({ ...baseEvent, id: "evt1", body: "记住 我喜欢冰美式" }, store)
  await processInboundEvent({ ...baseEvent, id: "evt2", idempotencyKey: "imessage-in-2", body: "记住  我喜欢冰美式 " }, store)

  const facts = await store.listMemoryFacts("u1")
  assert.deepEqual(facts.map((f) => f.content), ["我喜欢冰美式"])
  assert.equal(outbound[1], "已经记住了：我喜欢冰美式")
})

test("processInboundEvent rejects sensitive remember commands", async () => {
  const outbound: string[] = []
  const store = makeStore({
    enqueueOutbound: async (_userId, _to, body) => {
      outbound.push(body)
    },
  })
  await processInboundEvent({ ...baseEvent, body: "记住 我的 SSN 是 123-45-6789" }, store)
  assert.equal((await store.listMemoryFacts("u1")).length, 0)
  assert.match(outbound[0] ?? "", /不能保存/)
})

test("processInboundEvent runs agent for non-memory messages", async () => {
  let llmCalls = 0
  let outbound = ""
  const store = makeStore({
    runAgentTurn: async () => {
      llmCalls++
      return { text: "assistant reply" }
    },
    enqueueOutbound: async (_userId, _to, body) => {
      outbound = body
    },
  })
  await processInboundEvent(baseEvent, store)
  assert.equal(llmCalls, 1)
  assert.equal(outbound, "assistant reply")
})

test("isInboundLeaseExpired treats missing or stale leases as reclaimable", () => {
  const now = new Date("2026-04-25T12:00:00.000Z")
  assert.equal(isInboundLeaseExpired(undefined, now), true)
  assert.equal(isInboundLeaseExpired("2026-04-25T11:59:59.000Z", now), true)
  assert.equal(isInboundLeaseExpired("2026-04-25T12:00:30.000Z", now), false)
})
