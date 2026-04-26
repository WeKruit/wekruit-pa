import assert from "node:assert/strict"
import test from "node:test"
import type { AgentDef, ChatMessage } from "@pa/core-types"
import { buildAgentsInput } from "./openai-agents-adapter.js"

const agent: AgentDef = {
  id: "default",
  name: "Default PA",
  status: "published",
  provider: "openai",
  model: "pa-fast",
  temperature: 0.7,
  maxTokens: 500,
  systemPrompt: "Be useful.",
  version: "1",
  memoryMode: "firestore_only",
  toolPolicy: "none",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

test("buildAgentsInput includes memory, transcript, and latest message (legacy fallback)", () => {
  const history: ChatMessage[] = [
    {
      id: "m1",
      sessionId: "s1",
      userId: "u1",
      role: "user",
      body: "old request",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "m2",
      sessionId: "s1",
      userId: "u1",
      role: "assistant",
      body: "old answer",
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  ]
  const input = buildAgentsInput({
    agent,
    systemPrompt: agent.systemPrompt,
    memoryBlock: "User likes concise answers.",
    history,
    userMessage: "what is next?",
  })

  assert.match(input, /Memory context:\nUser likes concise answers\./)
  assert.match(
    input,
    /Recent transcript:\n\[2026-01-01T00:00:00.000Z\] user: old request\n\[2026-01-01T00:00:01.000Z\] assistant: old answer/
  )
  assert.match(input, /Latest user message:\nwhat is next\?/)
})

test("buildAgentsInput accepts undefined history/memoryBlock and renders systemInputs first", () => {
  const input = buildAgentsInput({
    agent,
    systemPrompt: agent.systemPrompt,
    userMessage: "hello",
    systemInputs: ["Confirmed user facts:\n- prefers tea"],
  })

  // systemInputs come before the latest message; no transcript or memory block.
  assert.match(input, /^Confirmed user facts:\n- prefers tea\n\nLatest user message:\nhello$/)
})

test("buildAgentsInput drops empty systemInputs entries", () => {
  const input = buildAgentsInput({
    agent,
    systemPrompt: agent.systemPrompt,
    userMessage: "hi",
    systemInputs: ["", "   ", "real entry"],
  })
  assert.match(input, /^real entry\n\nLatest user message:\nhi$/)
})


test("buildAgentsInputItems returns SystemMessageItems followed by a UserMessageItem (default Session path)", async () => {
  const { buildAgentsInputItems } = await import("./openai-agents-adapter.js")
  const items = buildAgentsInputItems({
    agent,
    systemPrompt: agent.systemPrompt,
    userMessage: "what is next?",
    systemInputs: ["Memory context:\n- prefers tea", "  ", "Confirmed user facts:\n- has a dog"],
  })
  assert.equal(items.length, 3)
  // Order: confirmed facts first... wait, we just preserve caller order.
  // The orchestrator ALWAYS supplies a single combined block today, but the
  // adapter must preserve whatever order the caller picks.
  const first = items[0] as { role: string; content: unknown }
  const second = items[1] as { role: string; content: unknown }
  const third = items[2] as { role: string; content: unknown }
  assert.equal(first.role, "system")
  assert.match(String(first.content), /Memory context:/)
  assert.equal(second.role, "system")
  assert.match(String(second.content), /Confirmed user facts:/)
  assert.equal(third.role, "user")
  assert.equal(third.content, "what is next?")
})

test("buildAgentsInputItems drops blank systemInputs entries", async () => {
  const { buildAgentsInputItems } = await import("./openai-agents-adapter.js")
  const items = buildAgentsInputItems({
    agent,
    systemPrompt: agent.systemPrompt,
    userMessage: "hi",
    systemInputs: ["", "   ", "real"],
  })
  assert.equal(items.length, 2)
  const sys = items[0] as { role: string; content: unknown }
  assert.equal(sys.role, "system")
  assert.equal(sys.content, "real")
})

// -------- Phase 10.5 T9: extractUsage tests --------


import { __forTesting as t9ForTesting } from "./openai-agents-adapter.js"

test("extractUsage sums tokens across rawResponses[].usage and counts web_search calls", () => {
  const fakeResult = {
    rawResponses: [
      {
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        output: [
          { type: "web_search_call" },
          { type: "message" },
        ],
      },
      {
        usage: { inputTokens: 20, outputTokens: 7, totalTokens: 27 },
        output: [{ type: "web_search_call" }],
      },
    ],
  }
  const usage = t9ForTesting.extractUsage(fakeResult, "openai", "gpt-5.4-nano")
  assert.equal(usage.provider, "openai")
  assert.equal(usage.model, "gpt-5.4-nano")
  assert.equal(usage.inputTokens, 30)
  assert.equal(usage.outputTokens, 12)
  assert.equal(usage.totalTokens, 42)
  assert.deepEqual(usage.hostedToolCalls, [{ name: "web_search", count: 2 }])
})

test("extractUsage returns provider+model only when SDK omits usage and tools", () => {
  const usage = t9ForTesting.extractUsage({ rawResponses: [] }, "siliconflow", "deepseek-chat")
  assert.equal(usage.provider, "siliconflow")
  assert.equal(usage.model, "deepseek-chat")
  assert.equal(usage.inputTokens, undefined)
  assert.equal(usage.hostedToolCalls, undefined)
})

test("extractUsage tolerates missing rawResponses field entirely (defensive)", () => {
  const usage = t9ForTesting.extractUsage({}, "openai", "gpt-5.4-nano")
  assert.equal(usage.provider, "openai")
  assert.equal(usage.inputTokens, undefined)
  assert.equal(usage.hostedToolCalls, undefined)
})
