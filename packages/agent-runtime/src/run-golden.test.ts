import assert from "node:assert/strict"
import test from "node:test"
import type { AgentDef } from "@pa/core-types"
import { runAgentTurn, __forTesting } from "./run.js"
import type { RunAgentTurnResult } from "./types.js"

/**
 * v2.1 S1A — golden snapshot regression for `runAgentTurn`.
 *
 * Goal: prove `runAgentTurn` returns byte-identical shape after the S1A
 * additive streaming work. We stub both dispatch targets (chat.completions
 * and agents-sdk) with fixed canned `RunAgentTurnResult`s and assert the
 * function returns the canned shape unchanged for each dispatch path.
 *
 * If a future change to `run.ts` mutates the result (extra fields, reshape,
 * accidental JSON stringification, etc.), one of these snapshots will fail
 * loudly. The snapshots are inlined here so they survive `git diff` review
 * and require an explicit owner update if the contract changes.
 */

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

const GOLDEN_AGENTS_SDK: RunAgentTurnResult = {
  text: "Hello from agents SDK",
  usage: {
    inputTokens: 42,
    outputTokens: 7,
    totalTokens: 49,
    provider: "openai",
    model: "gpt-5.4-nano",
  },
}

const GOLDEN_CHAT_COMPLETIONS: RunAgentTurnResult = {
  text: "Hello from chat completions",
  usage: {
    promptTokens: 30,
    completionTokens: 5,
  },
}

test("runAgentTurn returns byte-identical RunAgentTurnResult on Agents SDK path", async () => {
  process.env.PA_OPENAI_AGENT_API_KEY = "test"
  delete process.env.PA_AGENT_RUNTIME

  __forTesting.override({
    agentsSdk: async () => GOLDEN_AGENTS_SDK,
  })

  try {
    const result = await runAgentTurn({
      agent: agent(),
      systemPrompt: "hi",
      userMessage: "ping",
    })
    // Stringify both sides for a strict byte-by-byte deep-equal check.
    // node:assert/strict already does deep equality, but JSON.stringify
    // catches accidental field reordering / extra properties too.
    assert.equal(JSON.stringify(result), JSON.stringify(GOLDEN_AGENTS_SDK))
    assert.deepEqual(result, GOLDEN_AGENTS_SDK)
  } finally {
    __forTesting.reset()
  }
})

test("runAgentTurn returns byte-identical RunAgentTurnResult on chat.completions emergency path", async () => {
  process.env.PA_OPENAI_AGENT_API_KEY = "test"
  process.env.PA_AGENT_RUNTIME = "chat_completions"

  __forTesting.override({
    chatCompletions: async () => GOLDEN_CHAT_COMPLETIONS,
  })

  try {
    const result = await runAgentTurn({
      agent: agent(),
      systemPrompt: "hi",
      userMessage: "ping",
    })
    assert.equal(JSON.stringify(result), JSON.stringify(GOLDEN_CHAT_COMPLETIONS))
    assert.deepEqual(result, GOLDEN_CHAT_COMPLETIONS)
  } finally {
    delete process.env.PA_AGENT_RUNTIME
    __forTesting.reset()
  }
})

test("runAgentTurn keys present on result match the documented contract (text + optional usage only)", async () => {
  process.env.PA_OPENAI_AGENT_API_KEY = "test"
  delete process.env.PA_AGENT_RUNTIME

  __forTesting.override({
    agentsSdk: async () => GOLDEN_AGENTS_SDK,
  })

  try {
    const result = await runAgentTurn({
      agent: agent(),
      systemPrompt: "hi",
      userMessage: "ping",
    })
    const keys = Object.keys(result).sort()
    assert.deepEqual(keys, ["text", "usage"], `unexpected result keys: ${keys.join(",")}`)
  } finally {
    __forTesting.reset()
  }
})
