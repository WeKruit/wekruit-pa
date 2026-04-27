import assert from "node:assert/strict"
import test from "node:test"
import type { AgentDef, InboundEvent, MemoryFact } from "@pa/core-types"
import {
  buildRecallSystemInput,
  isInboundLeaseExpired,
  memoryBlockWithFacts,
  processInboundEvent,
  type OrchestratorStore,
} from "./index.js"

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

// Phase 11.1 cleanup D1 — listMemoryFacts now returns MemoryFact[] (no
// lite-shape union). Tests construct full MemoryFact rows via this helper
// so mock shapes match the production contract.
function mf(input: { id: string; content: string; userId?: string; createdAt?: string; status?: "confirmed" | "deleted"; source?: "explicit_user" | "operator" | "proposal" }): MemoryFact {
  return {
    id: input.id,
    userId: input.userId ?? "u1",
    content: input.content,
    status: input.status ?? "confirmed",
    source: input.source ?? "explicit_user",
    createdAt: input.createdAt ?? "2026-04-25T12:00:00.000Z",
  }
}

function makeStore(overrides: Partial<OrchestratorStore> = {}): OrchestratorStore {
  const facts: MemoryFact[] = []
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
    getMem0UserId: async () => undefined,
    loadHistory: async () => [],
    enqueueOutbound: async () => undefined,
    listMemoryFacts: async () => facts,
    createMemoryFact: async (_userId, content) => {
      facts.push(mf({ id: `f${facts.length + 1}`, content }))
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
    checkInboundSafety: async () => ({ allow: true }),
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

test("processInboundEvent blocks when checkInboundSafety denies", async () => {
  let llmCalls = 0
  const store = makeStore({
    checkInboundSafety: async () => ({ allow: false, reason: "prompt_injection_signal" }),
    runAgentTurn: async () => {
      llmCalls++
      return { text: "nope" }
    },
    enqueueOutbound: async () => undefined,
  })
  await processInboundEvent(baseEvent, store)
  assert.equal(llmCalls, 0)
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
  // Phase 19 ADAPT-02: systemInputs grew from 2 to 3 on the default path
  // (recall + Phase 18 voice reminder + Phase 19 mirror snippet).
  assert.equal(seen.systemInputs!.length, 3)
  assert.match(seen.systemInputs![0]!, /Memory context:/)
  assert.match(seen.systemInputs![0]!, /User likes concise answers\./)
  assert.match(seen.systemInputs![1]!, /Reminder: you're Claire/)
  // D-04 ordering: mirror snippet sits AFTER the voice reminder.
  assert.match(seen.systemInputs![2]!, /^User is currently/)
  // Legacy fields still passed for chat.completions emergency rollback.
  assert.ok(Array.isArray(seen.history))
  assert.match(String(seen.memoryBlock), /User likes concise answers\./)
})

test("processInboundEvent omits mirror snippet when PA_VOICE_MIRROR_DISABLED=true (Phase 19 D-07)", async () => {
  const prev = process.env.PA_VOICE_MIRROR_DISABLED
  process.env.PA_VOICE_MIRROR_DISABLED = "true"
  try {
    let captured: { systemInputs?: string[] } | null = null
    const store = makeStore({
      runAgentTurn: async (input) => {
        captured = { systemInputs: input.systemInputs }
        return { text: "ok" }
      },
    })
    await processInboundEvent(baseEvent, store)
    if (!captured) throw new Error("runAgentTurn was not called")
    const seen = captured as { systemInputs?: string[] }
    assert.ok(Array.isArray(seen.systemInputs))
    // Only the Phase 18 voice reminder (no recall block in this fake, no mirror).
    assert.equal(seen.systemInputs!.length, 1)
    assert.match(seen.systemInputs![0]!, /Reminder: you're Claire/)
    for (const entry of seen.systemInputs!) {
      assert.doesNotMatch(entry, /^User is currently/, "mirror snippet must NOT appear under kill switch")
    }
  } finally {
    if (prev === undefined) delete process.env.PA_VOICE_MIRROR_DISABLED
    else process.env.PA_VOICE_MIRROR_DISABLED = prev
  }
})

test("processInboundEvent writes long-term style preference via mirror.snapshot (Phase 19 ADAPT-03)", async () => {
  const { setVoiceStyleStore, createInMemoryVoiceStyleStore, readStylePreference } = await import(
    "@pa/memory"
  )
  const fakeStore = createInMemoryVoiceStyleStore()
  setVoiceStyleStore(fakeStore)
  try {
    const store = makeStore({})
    await processInboundEvent(
      { ...baseEvent, body: "lowkey emo了 fr fr 🍋☕" },
      store
    )
    const pref = await readStylePreference("u1")
    assert.ok(pref, "expected preference to be written after turn")
    assert.equal(pref!.preferred_register, "slangy")
  } finally {
    setVoiceStyleStore(null)
  }
})

test("processInboundEvent does NOT write style preference when PA_VOICE_MIRROR_DISABLED=true (Phase 19 D-07)", async () => {
  const { setVoiceStyleStore, createInMemoryVoiceStyleStore, readStylePreference } = await import(
    "@pa/memory"
  )
  const fakeStore = createInMemoryVoiceStyleStore()
  setVoiceStyleStore(fakeStore)
  const prev = process.env.PA_VOICE_MIRROR_DISABLED
  process.env.PA_VOICE_MIRROR_DISABLED = "true"
  try {
    const store = makeStore({})
    await processInboundEvent(
      { ...baseEvent, body: "lowkey emo了 fr fr 🍋" },
      store
    )
    assert.equal(await readStylePreference("u1"), null, "kill switch must skip mem0 write")
  } finally {
    if (prev === undefined) delete process.env.PA_VOICE_MIRROR_DISABLED
    else process.env.PA_VOICE_MIRROR_DISABLED = prev
    setVoiceStyleStore(null)
  }
})

test("processInboundEvent injects mirror snippet AFTER Phase 18 voice reminder (Phase 19 D-04 ordering)", async () => {
  let captured: { systemInputs?: string[] } | null = null
  const store = makeStore({
    loadHistory: async () => [
      {
        id: "h1",
        sessionId: "s1",
        userId: "u1",
        role: "user" as const,
        body: "lowkey emo了 fr 🍋",
        createdAt: "2026-04-25T11:59:00.000Z",
      },
    ],
    runAgentTurn: async (input) => {
      captured = { systemInputs: input.systemInputs }
      return { text: "ok" }
    },
  })
  await processInboundEvent(baseEvent, store)
  if (!captured) throw new Error("runAgentTurn was not called")
  const seen = captured as { systemInputs?: string[] }
  assert.ok(Array.isArray(seen.systemInputs))
  // Voice reminder is first; mirror snippet is last.
  const mirrorIdx = seen.systemInputs!.findIndex((s) => s.startsWith("User is currently"))
  const reminderIdx = seen.systemInputs!.findIndex((s) => /Reminder: you're Claire/.test(s))
  assert.notEqual(mirrorIdx, -1, "mirror snippet should be present")
  assert.notEqual(reminderIdx, -1, "voice reminder should be present")
  assert.ok(mirrorIdx > reminderIdx, "mirror must come after voice reminder (D-04)")
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

// -------- Phase 10.5 T5: regex pre-router removal --------

test("processInboundEvent T5: 'remember' command falls through to LLM (no short-circuit)", async () => {
  let llmCalls = 0
  let createCalls = 0
  let outbound = ""
  const store = makeStore({
    runAgentTurn: async (input) => {
      llmCalls++
      // The LLM sees the raw user message — no orchestrator-level rewriting.
      assert.equal(input.userMessage, "记住 我喜欢冰美式")
      return { text: "好的，我会记住的。" }
    },
    createMemoryFact: async () => {
      createCalls++
      return "should-not-be-called"
    },
    enqueueOutbound: async (_u, _t, body) => {
      outbound = body
    },
  })
  await processInboundEvent({ ...baseEvent, body: "记住 我喜欢冰美式" }, store)
  // The LLM is invoked; the regex pre-router did NOT write a fact directly.
  assert.equal(llmCalls, 1)
  assert.equal(createCalls, 0)
  assert.equal(outbound, "好的，我会记住的。")
})

test("processInboundEvent T5: current-info-shaped query falls through to LLM", async () => {
  // Phase 10.5 cleanup C6 — runCurrentInfoConnector store hook was removed;
  // the LLM owns current-info via the SDK webSearchTool on the default path.
  // The invariant that the LLM is invoked for "最近 X" turns (instead of an
  // orchestrator-level pre-router) is preserved by the absence of any
  // shortcut in processInboundEvent.
  let llmCalls = 0
  let outbound = ""
  const store = makeStore({
    runAgentTurn: async (input) => {
      llmCalls++
      assert.match(input.userMessage, /最近有啥电影/)
      return { text: "最近院线有几部新片，我用 web_search 给你查到了 X、Y、Z。" }
    },
    enqueueOutbound: async (_u, _t, body) => {
      outbound = body
    },
  })
  await processInboundEvent({ ...baseEvent, body: "最近有啥电影" }, store)
  assert.equal(llmCalls, 1)
  assert.match(outbound, /最近院线/)
})

test("processInboundEvent T5: parseMemoryCommand 'list' still routes through orchestrator (admin command)", async () => {
  let llmCalls = 0
  let outbound = ""
  const store = makeStore({
    listMemoryFacts: async () => [
      mf({ id: "f1", content: "我喜欢冰美式" }),
      mf({ id: "f2", content: "我住在上海" }),
    ],
    runAgentTurn: async () => {
      llmCalls++
      return { text: "should-not-be-called" }
    },
    enqueueOutbound: async (_u, _t, body) => {
      outbound = body
    },
  })
  await processInboundEvent({ ...baseEvent, body: "我的记忆" }, store)
  assert.equal(llmCalls, 0, "list command must not reach the LLM")
  assert.match(outbound, /我喜欢冰美式/)
  assert.match(outbound, /我住在上海/)
})

test("processInboundEvent T5: parseMemoryCommand 'forget' still routes through orchestrator (admin command)", async () => {
  let llmCalls = 0
  let outbound = ""
  const facts: MemoryFact[] = [mf({ id: "f1", content: "我喜欢冰美式" })]
  const deletes: string[][] = []
  const store = makeStore({
    listMemoryFacts: async () => facts,
    deleteMemoryFacts: async (_u, ids) => {
      deletes.push(ids)
    },
    runAgentTurn: async () => {
      llmCalls++
      return { text: "should-not-be-called" }
    },
    enqueueOutbound: async (_u, _t, body) => {
      outbound = body
    },
  })
  await processInboundEvent({ ...baseEvent, body: "忘记 冰美式" }, store)
  assert.equal(llmCalls, 0, "forget command must not reach the LLM")
  assert.deepEqual(deletes, [["f1"]])
  assert.match(outbound, /已忘记：我喜欢冰美式/)
})

test("processInboundEvent T5: parseMemoryCommand 'clear_request' still routes through orchestrator (admin command)", async () => {
  let llmCalls = 0
  let outbound = ""
  const store = makeStore({
    runAgentTurn: async () => {
      llmCalls++
      return { text: "should-not-be-called" }
    },
    enqueueOutbound: async (_u, _t, body) => {
      outbound = body
    },
  })
  await processInboundEvent({ ...baseEvent, body: "清空记忆" }, store)
  assert.equal(llmCalls, 0, "clear_request must not reach the LLM")
  assert.match(outbound, /确认清空记忆/)
})

test("processInboundEvent T5: parseMemoryCommand 'clear_confirm' still routes through orchestrator (admin command)", async () => {
  let llmCalls = 0
  let outbound = ""
  const facts: MemoryFact[] = [
    mf({ id: "f1", content: "fact one" }),
    mf({ id: "f2", content: "fact two" }),
  ]
  const deletes: string[][] = []
  const store = makeStore({
    listMemoryFacts: async () => facts,
    deleteMemoryFacts: async (_u, ids) => {
      deletes.push(ids)
    },
    runAgentTurn: async () => {
      llmCalls++
      return { text: "should-not-be-called" }
    },
    enqueueOutbound: async (_u, _t, body) => {
      outbound = body
    },
  })
  await processInboundEvent({ ...baseEvent, body: "确认清空记忆" }, store)
  assert.equal(llmCalls, 0, "clear_confirm must not reach the LLM")
  assert.deepEqual(deletes, [["f1", "f2"]])
  assert.match(outbound, /已清空 2 条/)
})

test("processInboundEvent T5: __PA_RESET__ still short-circuits BEFORE the LLM (A6 lock)", async () => {
  let llmCalls = 0
  let resetCalls = 0
  const store = makeStore({
    runAgentTurn: async () => {
      llmCalls++
      return { text: "should-not-be-called" }
    },
    maybeHandleResetCommand: async (event) => {
      resetCalls++
      assert.equal(event.body, "__PA_RESET__")
      return { handled: true, summary: "✓ 测试记忆已清空" }
    },
  })
  await processInboundEvent({ ...baseEvent, body: "__PA_RESET__" }, store)
  assert.equal(resetCalls, 1)
  assert.equal(llmCalls, 0)
})

test("processInboundEvent T5: suppressOutbound flag still suppresses pa_outbound writes for harness events", async () => {
  let llmCalls = 0
  let outboundCalls = 0
  const store = makeStore({
    runAgentTurn: async () => {
      llmCalls++
      return { text: "assistant reply" }
    },
    enqueueOutbound: async () => {
      outboundCalls++
    },
  })
  await processInboundEvent(
    {
      ...baseEvent,
      body: "最近有啥电影",
      rawMeta: {
        source: "imessage_broker",
        harness: { runner: "tests/scenarios/runner.mjs", suppressOutbound: true },
      },
    },
    store
  )
  assert.equal(llmCalls, 1)
  assert.equal(outboundCalls, 0)
})

test("isInboundLeaseExpired treats missing or stale leases as reclaimable", () => {
  const now = new Date("2026-04-25T12:00:00.000Z")
  assert.equal(isInboundLeaseExpired(undefined, now), true)
  assert.equal(isInboundLeaseExpired("2026-04-25T11:59:59.000Z", now), true)
  assert.equal(isInboundLeaseExpired("2026-04-25T12:00:30.000Z", now), false)
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

// -------- Phase 10.5 T9: per-turn usage persistence tests --------

test("processInboundEvent writes pa_turns.usage when runAgentTurn returns usage", async () => {
  const updates: Record<string, unknown>[] = []
  const store = makeStore({
    runAgentTurn: async () => ({
      text: "ok",
      usage: {
        provider: "openai",
        model: "gpt-5.4-nano",
        inputTokens: 50,
        outputTokens: 12,
        totalTokens: 62,
      },
    }),
    updateTurn: async (_turnId, patch) => {
      updates.push(patch)
    },
  })
  await processInboundEvent({ ...baseEvent, body: "hello there" }, store)
  // One of the updateTurn calls carries the usage subfield.
  const usagePatch = updates.find((p) => "usage" in p)
  assert.ok(usagePatch, "usage patch was set")
  const usage = (usagePatch as { usage: Record<string, unknown> }).usage
  assert.equal(usage.provider, "openai")
  assert.equal(usage.model, "gpt-5.4-nano")
  assert.equal(usage.inputTokens, 50)
  assert.equal(usage.outputTokens, 12)
  assert.equal(usage.totalTokens, 62)
})

test("processInboundEvent emits hosted tool call rows via recordHostedToolCalls", async () => {
  const recorded: { calls: { name: string; count: number }[] }[] = []
  const store = makeStore({
    runAgentTurn: async () => ({
      text: "ok",
      usage: {
        provider: "openai",
        model: "gpt-5.4-nano",
        hostedToolCalls: [{ name: "web_search", count: 2 }],
      },
    }),
    recordHostedToolCalls: async (input) => {
      recorded.push(input)
    },
  })
  // Phase 10.5 T5: current-info-shaped queries no longer short-circuit; the
  // LLM owns web_search via the SDK hosted tool. Use one such query here so
  // the trace exercises the post-T5 path end-to-end.
  await processInboundEvent({ ...baseEvent, body: "最近有啥电影" }, store)
  assert.equal(recorded.length, 1)
  assert.deepEqual(recorded[0]!.calls, [{ name: "web_search", count: 2 }])
})

test("processInboundEvent filters undefined fields out of pa_turns.usage payload", async () => {
  const updates: Record<string, unknown>[] = []
  const store = makeStore({
    runAgentTurn: async () => ({
      text: "ok",
      usage: {
        provider: "openai",
        model: "gpt-5.4-nano",
        inputTokens: undefined,
        outputTokens: undefined,
      },
    }),
    updateTurn: async (_turnId, patch) => {
      updates.push(patch)
    },
  })
  await processInboundEvent({ ...baseEvent, body: "hi" }, store)
  const usagePatch = updates.find((p) => "usage" in p) as { usage: Record<string, unknown> } | undefined
  assert.ok(usagePatch)
  // Phase 10 bug #2 pattern: undefined fields filtered out, not persisted as undefined.
  assert.equal("inputTokens" in usagePatch.usage, false)
  assert.equal("outputTokens" in usagePatch.usage, false)
  assert.equal(usagePatch.usage.provider, "openai")
})

// -------- Phase 11.1.2: persona card wiring into systemInputs --------

test("Phase 11.1.2: persona + Mem0 → systemInputs[0]=persona, [1]=recall", async () => {
  const facts: MemoryFact[] = [
    mf({ id: "f1", userId: "u1", content: "我喜欢冰美式", createdAt: "2026-01-01T00:00:00Z" }),
    mf({ id: "f2", userId: "u1", content: "我住在上海", createdAt: "2026-01-02T00:00:00Z" }),
  ]
  let captured: string[] | undefined
  const store = makeStore({
    listMemoryFacts: async () => facts,
    loadPersonalizationContext: async () => ({
      memoryBlock: "User likes brevity.",
      mem0Degraded: false,
      mem0SearchResultCount: 1,
      mem0DegradedReason: null,
    }),
    runAgentTurn: async (input) => {
      captured = input.systemInputs
      return { text: "ok" }
    },
  })
  const prev = process.env.PA_PERSONA_CARD_DISABLED
  delete process.env.PA_PERSONA_CARD_DISABLED
  try {
    await processInboundEvent(baseEvent, store)
  } finally {
    if (prev === undefined) delete process.env.PA_PERSONA_CARD_DISABLED
    else process.env.PA_PERSONA_CARD_DISABLED = prev
  }

  if (!captured) throw new Error("runAgentTurn was not called")
  // Phase 19 ADAPT-02: appended adaptive-mirror snippet last (D-04 ordering).
  assert.equal(captured.length, 4, "persona + recall + voice reminder + mirror")
  assert.match(captured[0]!, /^Persona facts \(confirmed\):/)
  assert.match(captured[0]!, /我喜欢冰美式/)
  assert.match(captured[0]!, /我住在上海/)
  // Phase 11.1 cleanup D2 — recall channel is Mem0-only on the default
  // path; facts no longer double-write into "Confirmed user facts:" here.
  assert.equal(captured[1]!, "Memory context:\nUser likes brevity.")
  assert.equal(captured[1]!.startsWith("Memory context:\nConfirmed user facts:"), false)
  assert.match(captured[2]!, /Reminder: you're Claire/)
  assert.match(captured[3]!, /^User is currently/)
})

test("Phase 11.1.2: zero facts + non-null Mem0 → systemInputs has only recall", async () => {
  let captured: string[] | undefined
  const store = makeStore({
    listMemoryFacts: async () => [],
    loadPersonalizationContext: async () => ({
      memoryBlock: "User prefers terse answers.",
      mem0Degraded: false,
      mem0SearchResultCount: 1,
      mem0DegradedReason: null,
    }),
    runAgentTurn: async (input) => {
      captured = input.systemInputs
      return { text: "ok" }
    },
  })
  const prev = process.env.PA_PERSONA_CARD_DISABLED
  delete process.env.PA_PERSONA_CARD_DISABLED
  try {
    await processInboundEvent(baseEvent, store)
  } finally {
    if (prev === undefined) delete process.env.PA_PERSONA_CARD_DISABLED
    else process.env.PA_PERSONA_CARD_DISABLED = prev
  }

  if (!captured) throw new Error("runAgentTurn was not called")
  // Phase 19: + mirror snippet at tail.
  assert.equal(captured.length, 3, "recall + voice reminder + mirror")
  assert.match(captured[0]!, /^Memory context:/)
  assert.match(captured[0]!, /User prefers terse answers\./)
  assert.match(captured[1]!, /Reminder: you're Claire/)
  assert.match(captured[2]!, /^User is currently/)
})

test("Phase 11.1.2: persona present + null Mem0 → systemInputs has only persona", async () => {
  const facts: MemoryFact[] = [
    mf({ id: "f1", userId: "u1", content: "我喜欢冰美式", createdAt: "2026-01-01T00:00:00Z" }),
  ]
  let captured: string[] | undefined
  const store = makeStore({
    listMemoryFacts: async () => facts,
    loadPersonalizationContext: async () => ({
      memoryBlock: null,
      mem0Degraded: false,
      mem0SearchResultCount: 0,
      mem0DegradedReason: null,
    }),
    runAgentTurn: async (input) => {
      captured = input.systemInputs
      return { text: "ok" }
    },
  })
  const prev = process.env.PA_PERSONA_CARD_DISABLED
  delete process.env.PA_PERSONA_CARD_DISABLED
  try {
    await processInboundEvent(baseEvent, store)
  } finally {
    if (prev === undefined) delete process.env.PA_PERSONA_CARD_DISABLED
    else process.env.PA_PERSONA_CARD_DISABLED = prev
  }

  if (!captured) throw new Error("runAgentTurn was not called")
  // Phase 11.1 cleanup D2 — facts no longer double-write into the recall
  // channel; when mem.memoryBlock is null, recall is null and systemInputs
  // contains the persona card, post-history voice reminder, and Phase 19
  // adaptive-mirror snippet.
  assert.equal(captured.length, 3)
  assert.match(captured[0]!, /^Persona facts \(confirmed\):/)
  assert.match(captured[1]!, /Reminder: you're Claire/)
  assert.match(captured[2]!, /^User is currently/)
  for (const entry of captured.slice(0, 1)) {
    assert.equal(entry.includes("Confirmed user facts:"), false, "facts must not leak into recall")
  }
})

test("Phase 11.1.2: zero facts + null Mem0 → systemInputs is empty", async () => {
  let captured: string[] | undefined
  const store = makeStore({
    listMemoryFacts: async () => [],
    loadPersonalizationContext: async () => ({
      memoryBlock: null,
      mem0Degraded: false,
      mem0SearchResultCount: 0,
      mem0DegradedReason: null,
    }),
    runAgentTurn: async (input) => {
      captured = input.systemInputs
      return { text: "ok" }
    },
  })
  const prev = process.env.PA_PERSONA_CARD_DISABLED
  delete process.env.PA_PERSONA_CARD_DISABLED
  try {
    await processInboundEvent(baseEvent, store)
  } finally {
    if (prev === undefined) delete process.env.PA_PERSONA_CARD_DISABLED
    else process.env.PA_PERSONA_CARD_DISABLED = prev
  }

  if (!captured) throw new Error("runAgentTurn was not called")
  // No persona / no recall — voice reminder (Phase 18) + adaptive mirror (Phase 19).
  assert.equal(captured.length, 2)
  assert.match(captured[0]!, /Reminder: you're Claire/)
  assert.match(captured[1]!, /^User is currently/)
})

test("Phase 11.1.2: PA_PERSONA_CARD_DISABLED=true → persona absent even when facts exist", async () => {
  const facts: MemoryFact[] = [
    mf({ id: "f1", userId: "u1", content: "我喜欢冰美式", createdAt: "2026-01-01T00:00:00Z" }),
  ]
  let captured: string[] | undefined
  const store = makeStore({
    listMemoryFacts: async () => facts,
    loadPersonalizationContext: async () => ({
      memoryBlock: "Mem0 says hi.",
      mem0Degraded: false,
      mem0SearchResultCount: 1,
      mem0DegradedReason: null,
    }),
    runAgentTurn: async (input) => {
      captured = input.systemInputs
      return { text: "ok" }
    },
  })
  const prev = process.env.PA_PERSONA_CARD_DISABLED
  process.env.PA_PERSONA_CARD_DISABLED = "true"
  try {
    await processInboundEvent(baseEvent, store)
  } finally {
    if (prev === undefined) delete process.env.PA_PERSONA_CARD_DISABLED
    else process.env.PA_PERSONA_CARD_DISABLED = prev
  }

  if (!captured) throw new Error("runAgentTurn was not called")
  // Persona suppressed; recall remains; voice reminder + Phase 19 mirror trail.
  assert.equal(captured.length, 3)
  assert.match(captured[0]!, /^Memory context:/)
  assert.equal(captured[0]!.startsWith("Persona facts"), false)
  assert.match(captured[1]!, /Reminder: you're Claire/)
  assert.match(captured[2]!, /^User is currently/)
})

// -------- Phase 11.1 cleanup D2: buildRecallSystemInput unit tests --------

test("D2 buildRecallSystemInput: null memoryBlock → null (no bare heading injected)", () => {
  assert.equal(buildRecallSystemInput(null), null)
})

test("D2 buildRecallSystemInput: empty-string memoryBlock → null (treated as no recall)", () => {
  assert.equal(buildRecallSystemInput(""), null)
})

test("D2 buildRecallSystemInput: non-empty memoryBlock → wraps with 'Memory context:' header", () => {
  const out = buildRecallSystemInput("User prefers terse answers.")
  assert.equal(out, "Memory context:\nUser prefers terse answers.")
})

test("D2 buildRecallSystemInput: does NOT prepend facts/persona (decoupled from memoryBlockWithFacts)", () => {
  const out = buildRecallSystemInput("Mem0 says hi.")
  // No facts heading should ever appear via this helper.
  assert.equal(out!.includes("Confirmed user facts:"), false)
  assert.equal(out!.includes("Persona facts"), false)
})

test("D2 memoryBlockWithFacts (legacy fallback) shape unchanged for chat.completions kill-switch", () => {
  // Both halves present → keep "Confirmed user facts:" + "Relevant memory:" wire shape.
  const both = memoryBlockWithFacts("Mem0 says hi.", [{ content: "我喜欢冰美式" }])
  assert.equal(both, "Confirmed user facts:\n- 我喜欢冰美式\n\nRelevant memory:\nMem0 says hi.")
  // Facts only → "Confirmed user facts:" alone.
  assert.equal(memoryBlockWithFacts(null, [{ content: "fact one" }]), "Confirmed user facts:\n- fact one")
  // Mem0 only → bare memoryBlock string.
  assert.equal(memoryBlockWithFacts("Mem0 alone", []), "Mem0 alone")
  // Neither → null.
  assert.equal(memoryBlockWithFacts(null, []), null)
})
