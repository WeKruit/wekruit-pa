import assert from "node:assert/strict"
import test from "node:test"
import type { AgentDef, InboundEvent } from "@pa/core-types"
import {
  buildCurrentInfoBoundaryReply,
  isInboundLeaseExpired,
  processInboundEvent,
  type OrchestratorStore,
} from "./index.js"

type TestCurrentInfoResult = {
  ok: boolean
  source: "openai-web-search"
  summary: string
  asOf: string
  sources: { title?: string; url: string }[]
}

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
    runCurrentInfoConnector: async (_agent, input) => ({
      ok: false,
      source: "openai-web-search",
      summary: "PA_OPENAI_AGENT_API_KEY is not configured; OpenAI Agents hosted web search unavailable.",
      asOf: input.nowIso,
      sources: [],
    }),
    createSession: () => ({
      async getSessionId() {
        return "fake-session"
      },
      async getItems() {
        return []
      },
      async addItems() {
        /* no-op */
      },
      async popItem() {
        return undefined
      },
      async clearSession() {
        /* no-op */
      },
    }),
    runAgentTurn: async () => ({ text: "assistant reply" }),
    afterAssistantTurn: async () => ({ writebackRan: false, writebackSkipReason: "memory_mode" }),
    maybeHandleResetCommand: async () => ({ handled: false }),
    buildTurnTools: async () => [],
    recordHostedToolCalls: async () => undefined,
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

test("processInboundEvent passes a Session and systemInputs into the default agent turn", async () => {
  type Captured = {
    session?: unknown
    systemInputs?: string[]
    history?: unknown
    memoryBlock?: unknown
  }
  let captured: Captured | null = null
  let createSessionCalls = 0
  const fakeSession = {
    async getSessionId() {
      return "s1"
    },
    async getItems() {
      return []
    },
    async addItems() {
      /* no-op */
    },
    async popItem() {
      return undefined
    },
    async clearSession() {
      /* no-op */
    },
  }
  const store = makeStore({
    createSession: ({ sessionId, userId }) => {
      createSessionCalls++
      assert.equal(sessionId, "s1")
      assert.equal(userId, "u1")
      return fakeSession
    },
    loadPersonalizationContext: async () => ({
      memoryBlock: "User likes concise answers.",
      mem0Degraded: false,
      mem0SearchResultCount: 1,
      mem0DegradedReason: null,
    }),
    runAgentTurn: async (input) => {
      captured = {
        session: input.session,
        systemInputs: input.systemInputs,
        history: input.history,
        memoryBlock: input.memoryBlock,
      }
      return { text: "ok" }
    },
  })

  await processInboundEvent(baseEvent, store)

  assert.equal(createSessionCalls, 1)
  if (!captured) throw new Error("runAgentTurn was not called")
  const seen: Captured = captured
  assert.strictEqual(seen.session, fakeSession)
  assert.ok(Array.isArray(seen.systemInputs))
  assert.equal(seen.systemInputs!.length, 1)
  assert.match(seen.systemInputs![0]!, /Memory context:/)
  assert.match(seen.systemInputs![0]!, /User likes concise answers\./)
  // Legacy fields still passed for chat.completions emergency rollback.
  assert.ok(Array.isArray(seen.history))
  assert.match(String(seen.memoryBlock), /User likes concise answers\./)
})

test("processInboundEvent answers current-info with connector result before LLM", async () => {
  let connectorCalls = 0
  let llmCalls = 0
  let afterCalls = 0
  let outbound = ""
  const appended: string[] = []
  const store = makeStore({
    runCurrentInfoConnector: async (_agent, input): Promise<TestCurrentInfoResult> => {
      connectorCalls++
      assert.equal(input.query, "不需要，我还想去看看电影，最近有啥电影")
      assert.equal(input.nowIso, "2026-04-25T12:00:00.000Z")
      return {
        ok: true,
        source: "openai-web-search",
        summary: "最近院线片包括 A、B、C；以本地影院排片为准。",
        asOf: "2026-04-25T12:00:00.000Z",
        sources: [{ title: "Movie source", url: "https://example.com/movies" }],
      }
    },
    runAgentTurn: async () => {
      llmCalls++
      return { text: "最近有《速度与激情10》和《银河护卫队3》" }
    },
    appendMessage: async (message) => {
      appended.push(message.body)
    },
    enqueueOutbound: async (_userId, _to, body) => {
      outbound = body
    },
    afterAssistantTurn: async (_agent, input) => {
      afterCalls++
      assert.match(input.userText, /最近有啥电影/)
      assert.match(input.assistantText, /最近院线片/)
      return { writebackRan: true, writebackSkipReason: null }
    },
  })

  await processInboundEvent({ ...baseEvent, body: "不需要，我还想去看看电影，最近有啥电影" }, store)

  assert.equal(connectorCalls, 1)
  assert.equal(llmCalls, 0)
  assert.equal(afterCalls, 1)
  assert.match(outbound, /最近院线片/)
  assert.match(outbound, /来源/)
  assert.match(outbound, /https:\/\/example\.com\/movies/)
  assert.doesNotMatch(outbound, /速度与激情10|银河护卫队3/)
  assert.deepEqual(appended, ["不需要，我还想去看看电影，最近有啥电影", outbound])
})

test("processInboundEvent falls back to boundary reply when current-info connector is unavailable", async () => {
  let llmCalls = 0
  let connectorCalls = 0
  let afterCalls = 0
  let outbound = ""
  const appended: string[] = []
  const store = makeStore({
    runCurrentInfoConnector: async (_agent, input): Promise<TestCurrentInfoResult> => {
      connectorCalls++
      return {
        ok: false,
        source: "openai-web-search",
        summary: "PA_OPENAI_AGENT_API_KEY is not configured; OpenAI Agents hosted web search unavailable.",
        asOf: input.nowIso,
        sources: [],
      }
    },
    runAgentTurn: async () => {
      llmCalls++
      return { text: "最近有《速度与激情10》和《银河护卫队3》" }
    },
    appendMessage: async (message) => {
      appended.push(message.body)
    },
    enqueueOutbound: async (_userId, _to, body) => {
      outbound = body
    },
    afterAssistantTurn: async (_agent, input) => {
      afterCalls++
      assert.match(input.userText, /最近有啥电影/)
      assert.match(input.assistantText, /实时检索/)
      return { writebackRan: true, writebackSkipReason: null }
    },
  })

  await processInboundEvent({ ...baseEvent, body: "不需要，我还想去看看电影，最近有啥电影" }, store)

  assert.equal(connectorCalls, 1)
  assert.equal(llmCalls, 0)
  assert.equal(afterCalls, 1)
  assert.match(outbound, /今天是 2026-04-25/)
  assert.match(outbound, /不能可靠回答/)
  assert.doesNotMatch(outbound, /速度与激情10|银河护卫队3/)
  assert.deepEqual(appended, ["不需要，我还想去看看电影，最近有啥电影", outbound])
})

test("processInboundEvent falls back to boundary reply when current-info connector throws", async () => {
  let outbound = ""
  const store = makeStore({
    runCurrentInfoConnector: async () => {
      throw new Error("Connector current-info denied: connector_not_allowlisted")
    },
    enqueueOutbound: async (_userId, _to, body) => {
      outbound = body
    },
  })

  await processInboundEvent({ ...baseEvent, body: "latest AI news today" }, store)

  assert.match(outbound, /live data source/)
})

test("processInboundEvent suppresses outbound for harness broker events", async () => {
  let llmCalls = 0
  let outboundCalls = 0
  const messages: string[] = []
  const store = makeStore({
    runAgentTurn: async () => {
      llmCalls++
      return { text: "assistant reply" }
    },
    appendMessage: async (message) => {
      messages.push(message.body)
    },
    enqueueOutbound: async () => {
      outboundCalls++
    },
  })
  await processInboundEvent(
    {
      ...baseEvent,
      rawMeta: {
        source: "imessage_broker",
        harness: { runner: "tests/scenarios/runner.mjs", suppressOutbound: true },
      },
    },
    store
  )
  assert.equal(llmCalls, 1)
  assert.equal(outboundCalls, 0)
  assert.deepEqual(messages, ["hi", "assistant reply"])
})

test("processInboundEvent suppresses outbound for current-info connector replies", async () => {
  let outboundCalls = 0
  const messages: string[] = []
  const store = makeStore({
    runCurrentInfoConnector: async (_agent, input): Promise<TestCurrentInfoResult> => ({
      ok: true,
      source: "openai-web-search",
      summary: "Today has current movie results.",
      asOf: input.nowIso,
      sources: [{ title: "Movies", url: "https://example.com/current" }],
    }),
    appendMessage: async (message) => {
      messages.push(message.body)
    },
    enqueueOutbound: async () => {
      outboundCalls++
    },
  })
  await processInboundEvent(
    {
      ...baseEvent,
      body: "what movies are playing today?",
      rawMeta: {
        source: "imessage_broker",
        harness: { runner: "tests/scenarios/runner.mjs", suppressOutbound: true },
      },
    },
    store
  )

  assert.equal(outboundCalls, 0)
  assert.equal(messages.length, 2)
  assert.match(messages[1] ?? "", /Today has current movie results/)
})

test("processInboundEvent does not intercept pure memory recall as current-info", async () => {
  let connectorCalls = 0
  let llmCalls = 0
  let outbound = ""
  const store = makeStore({
    runCurrentInfoConnector: async (_agent, input): Promise<TestCurrentInfoResult> => {
      connectorCalls++
      return {
        ok: true,
        source: "openai-web-search",
        summary: input.query,
        asOf: input.nowIso,
        sources: [],
      }
    },
    runAgentTurn: async () => {
      llmCalls++
      return { text: "你最近想去看电影。" }
    },
    enqueueOutbound: async (_userId, _to, body) => {
      outbound = body
    },
  })

  await processInboundEvent({ ...baseEvent, body: "你还记得我最近想干嘛吗？" }, store)

  assert.equal(connectorCalls, 0)
  assert.equal(llmCalls, 1)
  assert.equal(outbound, "你最近想去看电影。")
})

test("processInboundEvent short-circuits to maybeHandleResetCommand when handled", async () => {
  let llmCalls = 0
  let outbound = ""
  let resetCalls = 0
  const store = makeStore({
    runAgentTurn: async () => {
      llmCalls++
      return { text: "should not be called" }
    },
    enqueueOutbound: async (_userId, _to, body) => {
      outbound = body
    },
    maybeHandleResetCommand: async (event) => {
      resetCalls++
      assert.equal(event.body, "__PA_RESET__")
      return { handled: true, summary: "✓ 测试记忆已清空 — qdrant pa_memory=3; firestore pa_memory_facts=2" }
    },
  })
  await processInboundEvent({ ...baseEvent, body: "__PA_RESET__" }, store)
  assert.equal(resetCalls, 1)
  assert.equal(llmCalls, 0)
  assert.match(outbound, /测试记忆已清空/)
})

test("processInboundEvent ignores reset command for non-test users (handled=false)", async () => {
  let llmCalls = 0
  const store = makeStore({
    runAgentTurn: async () => {
      llmCalls++
      return { text: "normal reply" }
    },
    maybeHandleResetCommand: async () => ({ handled: false }),
  })
  // body matches RESET_PATTERNS but maybeHandleResetCommand returns handled=false
  // (e.g. testMode unset on the user) — orchestrator must fall through to LLM.
  await processInboundEvent({ ...baseEvent, body: "__PA_RESET__" }, store)
  assert.equal(llmCalls, 1)
})

test("isInboundLeaseExpired treats missing or stale leases as reclaimable", () => {
  const now = new Date("2026-04-25T12:00:00.000Z")
  assert.equal(isInboundLeaseExpired(undefined, now), true)
  assert.equal(isInboundLeaseExpired("2026-04-25T11:59:59.000Z", now), true)
  assert.equal(isInboundLeaseExpired("2026-04-25T12:00:30.000Z", now), false)
})

test("buildCurrentInfoBoundaryReply catches current external facts without blocking memory recall", () => {
  assert.match(
    buildCurrentInfoBoundaryReply("最近有什么电影可以看", "2026-04-26T05:00:00.000Z") ?? "",
    /今天是 2026-04-26/
  )
  assert.match(
    buildCurrentInfoBoundaryReply("what is the latest AI news?", "2026-04-26T05:00:00.000Z") ?? "",
    /live data source/
  )
  assert.equal(buildCurrentInfoBoundaryReply("你还记得我最近想干嘛吗？", "2026-04-26T05:00:00.000Z"), null)
})

// -------- Phase 10.5 T7: buildTurnTools tests --------

import { buildTurnTools } from "./index.js"

type T7Doc = Record<string, unknown>

function fakeFirestoreT7() {
  const store = new Map<string, T7Doc>()
  const db = {
    collection(name: string) {
      return {
        doc(id: string) {
          return {
            async set(data: T7Doc, opts?: { merge?: boolean }) {
              const path = `${name}/${id}`
              const cur = store.get(path) ?? {}
              store.set(path, opts?.merge ? { ...cur, ...data } : data)
            },
          }
        },
        where() {
          return {
            where() {
              return this
            },
            limit() {
              return this
            },
            async get() {
              return { docs: [] as { data(): T7Doc }[] }
            },
          }
        },
      }
    },
  }
  return { db: db as unknown as Parameters<typeof buildTurnTools>[0], store }
}

const t7AgentBase: AgentDef = {
  id: "default",
  name: "Default",
  systemPrompt: "Be useful.",
  provider: "openai",
  model: "gpt-5.4-nano",
  temperature: 0.7,
  memoryMode: "firestore_only",
  toolPolicy: "none",
  version: "1",
  isDefault: true,
}

test("buildTurnTools returns [] when toolPolicy is 'none'", () => {
  const { db } = fakeFirestoreT7()
  const tools = buildTurnTools(db, t7AgentBase, { turnId: "t1", userId: "u1", sessionId: "s1" })
  assert.deepEqual(tools, [])
})

test("buildTurnTools skips current-info (hosted by SDK) and includes remember-fact", () => {
  const { db } = fakeFirestoreT7()
  const agent: AgentDef = {
    ...t7AgentBase,
    toolPolicy: "allowlist",
    allowedConnectors: ["current-info", "remember-fact"],
    toolBudgetPerTurn: 3,
  }
  const tools = buildTurnTools(db, agent, { turnId: "t1", userId: "u1", sessionId: "s1" })
  assert.equal(tools.length, 1)
  assert.equal(tools[0]!.name, "remember-fact")
})

test("buildTurnTools.execute calls runConnector and returns stringified result", async () => {
  const { db, store } = fakeFirestoreT7()
  const agent: AgentDef = {
    ...t7AgentBase,
    toolPolicy: "allowlist",
    allowedConnectors: ["remember-fact"],
    toolBudgetPerTurn: 3,
  }
  const tools = buildTurnTools(db, agent, { turnId: "T7-turn", userId: "u1", sessionId: "s1" })
  const out = await tools[0]!.execute({ content: "我喜欢冰美式" })
  assert.equal(typeof out, "string")
  const parsed = JSON.parse(out) as { ok: boolean; factId: string }
  assert.equal(parsed.ok, true)
  assert.ok(parsed.factId, "factId returned")
  // pa_tool_calls row exists with completed status (proof runConnector ran)
  const toolCallEntries = [...store.entries()].filter(([k]) => k.startsWith("pa_tool_calls/"))
  assert.equal(toolCallEntries.length, 1)
  const row = toolCallEntries[0]![1] as Record<string, unknown>
  assert.equal(row.connectorName, "remember-fact")
  assert.equal(row.policyDecision, "allow")
  assert.equal(row.status, "completed")
})

test("buildTurnTools enforces toolBudgetPerTurn via shared monotonic counter", async () => {
  const { db } = fakeFirestoreT7()
  const agent: AgentDef = {
    ...t7AgentBase,
    toolPolicy: "allowlist",
    allowedConnectors: ["remember-fact"],
    toolBudgetPerTurn: 3,
  }
  const tools = buildTurnTools(db, agent, { turnId: "T7-budget", userId: "u-budget", sessionId: "s1" })
  const exec = tools[0]!.execute
  // Calls 1,2,3 below budget. 4th call should hit canUseConnector deny path,
  // which throws inside runConnector with message containing the policy reason.
  const r1 = await exec({ content: "fact 1" })
  const r2 = await exec({ content: "fact 2" })
  const r3 = await exec({ content: "fact 3" })
  assert.ok(r1 && r2 && r3, "first three succeed")
  // 4th must throw the budget-exhausted policy reason.
  await assert.rejects(
    async () => exec({ content: "fact 4" }),
    /tool_budget_exhausted/
  )
})

test("buildTurnTools parallel calls each see unique snapshots (no double-spend)", async () => {
  const { db } = fakeFirestoreT7()
  const agent: AgentDef = {
    ...t7AgentBase,
    toolPolicy: "allowlist",
    allowedConnectors: ["remember-fact"],
    toolBudgetPerTurn: 2,
  }
  const tools = buildTurnTools(db, agent, { turnId: "T7-parallel", userId: "u-par", sessionId: "s1" })
  const exec = tools[0]!.execute
  // Fire 3 in parallel under budget=2: exactly two must resolve, one must throw.
  const settled = await Promise.allSettled([
    exec({ content: "p1" }),
    exec({ content: "p2" }),
    exec({ content: "p3" }),
  ])
  const fulfilled = settled.filter((s) => s.status === "fulfilled").length
  const rejected = settled.filter((s) => s.status === "rejected").length
  assert.equal(fulfilled, 2)
  assert.equal(rejected, 1)
})
