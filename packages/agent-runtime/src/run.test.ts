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

// -------- Phase 10.5 T10: baseURL pollution 3-call regression --------
//
// Phase 10 bug #3 root cause: the SiliconFlow path mutated
// `process.env.OPENAI_BASE_URL` and a subsequent default OpenAI Agents SDK
// turn read the poisoned env, POSTing /responses to api.siliconflow.cn → 404.
// The fix lives in `withSiliconFlowFallback`'s try/finally, plus
// `configureDefaultOpenAIClient` which builds an explicit pinned `OpenAI`
// client instead of reading process.env. These tests fail loudly if a
// future change re-introduces env mutation on the default path.

import { __forTesting as adapterForTesting } from "./openai-agents-adapter.js"
import type { AgentTurnContext } from "./types.js"

function makeCtx(overrides: Partial<AgentTurnContext> = {}): AgentTurnContext {
  return {
    agent: agent({ provider: "siliconflow" }),
    systemPrompt: "Be useful.",
    userMessage: "ping",
    ...overrides,
  }
}

test("configureDefaultOpenAIClient does NOT mutate process.env.OPENAI_BASE_URL across two consecutive calls", () => {
  process.env.PA_OPENAI_AGENT_API_KEY = "test"
  const stale = "https://stale.example/v1"
  const before = process.env.OPENAI_BASE_URL
  process.env.OPENAI_BASE_URL = stale

  try {
    adapterForTesting.configureDefaultOpenAIClient()
    assert.equal(process.env.OPENAI_BASE_URL, stale, "first call did not mutate env")
    adapterForTesting.configureDefaultOpenAIClient()
    assert.equal(process.env.OPENAI_BASE_URL, stale, "second call did not mutate env")
  } finally {
    if (before === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = before
  }
})

test("withSiliconFlowFallback temporarily mutates OPENAI_BASE_URL inside fn but restores in finally (default→fallback→default sequence)", async () => {
  process.env.SILICONFLOW_API_KEY = "sf-test-key"
  process.env.SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1"
  process.env.PA_OPENAI_AGENT_API_KEY = "openai-test-key"

  // Snapshot env before the 3-call sequence.
  const snapshot = process.env.OPENAI_BASE_URL

  // Call 1 — default OpenAI configure (no mutation).
  adapterForTesting.configureDefaultOpenAIClient()
  assert.equal(process.env.OPENAI_BASE_URL, snapshot, "call 1 did not mutate")

  // Call 2 — fallback. Inside the wrapped fn, env is mutated to SF baseURL.
  let observedDuringFallback: string | undefined
  await adapterForTesting.withSiliconFlowFallback(makeCtx(), async () => {
    observedDuringFallback = process.env.OPENAI_BASE_URL
    return { text: "from fallback", usage: { provider: "siliconflow", model: "x" } }
  })
  assert.equal(observedDuringFallback, "https://api.siliconflow.cn/v1", "fallback fn saw SF baseURL")
  // After the fallback returns, env is restored to the snapshot.
  assert.equal(process.env.OPENAI_BASE_URL, snapshot, "fallback restored env in finally")

  // Call 3 — default OpenAI configure again. Must not have inherited SF baseURL.
  adapterForTesting.configureDefaultOpenAIClient()
  assert.equal(process.env.OPENAI_BASE_URL, snapshot, "call 3 did not see fallback leak")

  delete process.env.SILICONFLOW_API_KEY
  delete process.env.SILICONFLOW_BASE_URL
  delete process.env.PA_OPENAI_AGENT_API_KEY
})

test("withSiliconFlowFallback restores OPENAI_BASE_URL even if fn throws", async () => {
  process.env.SILICONFLOW_API_KEY = "sf-key"
  process.env.SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1"
  const snapshot = process.env.OPENAI_BASE_URL

  await assert.rejects(
    () =>
      adapterForTesting.withSiliconFlowFallback(makeCtx(), async () => {
        throw new Error("simulated SF failure")
      }),
    /simulated SF failure/
  )
  assert.equal(process.env.OPENAI_BASE_URL, snapshot, "env restored even after throw")

  delete process.env.SILICONFLOW_API_KEY
  delete process.env.SILICONFLOW_BASE_URL
})

test("runAgentTurn 3-call sequence (default→default→default) never poisons process.env.OPENAI_BASE_URL", async () => {
  process.env.PA_OPENAI_AGENT_API_KEY = "test"
  delete process.env.PA_AGENT_RUNTIME
  process.env.OPENAI_BASE_URL = "https://stale.example/v1"
  const snapshot = process.env.OPENAI_BASE_URL

  let agentsCalls = 0
  __forTesting.override({
    agentsSdk: async () => {
      agentsCalls += 1
      // Probe — capture env at SDK call time. Production code path
      // (runOpenAIAgentsTurn → configureDefaultOpenAIClient) must not
      // have mutated env before we get here.
      assert.equal(
        process.env.OPENAI_BASE_URL,
        snapshot,
        "env must equal snapshot when SDK is invoked"
      )
      return { text: "ok", usage: { provider: "openai", model: "gpt-5.4-nano" } }
    },
  })

  try {
    await runAgentTurn({ agent: agent(), systemPrompt: "hi", userMessage: "ping 1" })
    await runAgentTurn({ agent: agent(), systemPrompt: "hi", userMessage: "ping 2" })
    await runAgentTurn({ agent: agent(), systemPrompt: "hi", userMessage: "ping 3" })
    assert.equal(agentsCalls, 3)
    assert.equal(process.env.OPENAI_BASE_URL, snapshot, "env unchanged across 3 default calls")
  } finally {
    __forTesting.reset()
    delete process.env.OPENAI_BASE_URL
  }
})
