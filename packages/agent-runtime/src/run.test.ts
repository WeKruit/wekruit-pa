import assert from "node:assert/strict"
import test from "node:test"
import OpenAI from "openai"
import type { AgentDef } from "@pa/core-types"
import { runAgentTurn, __forTesting } from "./run.js"

function agent(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    id: "default",
    name: "Default",
    status: "published",
    provider: "openai",
    model: "gpt-5.4-nano",
    temperature: 0.7,
    systemPrompt: "Be useful.",
    version: "1",
    memoryMode: "firestore_only",
    toolPolicy: "none",
    ...overrides,
  }
}

test("runAgentTurn routes to chat.completions when an OpenAI client is injected (test door)", async () => {
  process.env.PA_OPENAI_AGENT_API_KEY = "test"
  let chatCalls = 0
  let agentsCalls = 0
  __forTesting.override({
    chatCompletions: async () => {
      chatCalls += 1
      return { text: "from chat.completions" }
    },
    agentsSdk: async () => {
      agentsCalls += 1
      return { text: "from agents sdk" }
    },
  })

  try {
    const fakeClient = {} as unknown as OpenAI
    const result = await runAgentTurn(
      { agent: agent(), systemPrompt: "hi", userMessage: "ping" },
      fakeClient
    )
    assert.equal(result.text, "from chat.completions")
    assert.equal(chatCalls, 1)
    assert.equal(agentsCalls, 0)
  } finally {
    __forTesting.reset()
  }
})

test("runAgentTurn routes to chat.completions on PA_AGENT_RUNTIME=chat_completions emergency flag", async () => {
  process.env.PA_OPENAI_AGENT_API_KEY = "test"
  process.env.PA_AGENT_RUNTIME = "chat_completions"
  let chatCalls = 0
  let agentsCalls = 0
  __forTesting.override({
    chatCompletions: async () => {
      chatCalls += 1
      return { text: "fallback" }
    },
    agentsSdk: async () => {
      agentsCalls += 1
      return { text: "agents" }
    },
  })

  try {
    const result = await runAgentTurn({ agent: agent(), systemPrompt: "hi", userMessage: "ping" })
    assert.equal(result.text, "fallback")
    assert.equal(chatCalls, 1)
    assert.equal(agentsCalls, 0)
  } finally {
    delete process.env.PA_AGENT_RUNTIME
    __forTesting.reset()
  }
})

test("runAgentTurn defaults to Agents SDK path when no client is injected and no rollback flag", async () => {
  process.env.PA_OPENAI_AGENT_API_KEY = "test"
  delete process.env.PA_AGENT_RUNTIME
  let chatCalls = 0
  let agentsCalls = 0
  __forTesting.override({
    chatCompletions: async () => {
      chatCalls += 1
      return { text: "chat" }
    },
    agentsSdk: async () => {
      agentsCalls += 1
      return { text: "agents" }
    },
  })

  try {
    const result = await runAgentTurn({ agent: agent(), systemPrompt: "hi", userMessage: "ping" })
    assert.equal(result.text, "agents")
    assert.equal(agentsCalls, 1)
    assert.equal(chatCalls, 0)
  } finally {
    __forTesting.reset()
  }
})

test("runAgentTurn does NOT mutate process.env.OPENAI_BASE_URL on the default Agents SDK path", async () => {
  process.env.PA_OPENAI_AGENT_API_KEY = "test"
  delete process.env.PA_AGENT_RUNTIME
  const before = process.env.OPENAI_BASE_URL
  let agentsCalls = 0
  __forTesting.override({
    agentsSdk: async () => {
      agentsCalls += 1
      return { text: "ok" }
    },
  })

  try {
    await runAgentTurn({ agent: agent(), systemPrompt: "hi", userMessage: "ping" })
    assert.equal(agentsCalls, 1)
    assert.equal(process.env.OPENAI_BASE_URL, before)
  } finally {
    __forTesting.reset()
  }
})
