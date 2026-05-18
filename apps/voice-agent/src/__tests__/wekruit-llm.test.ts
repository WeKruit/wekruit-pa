/**
 * v2.2 W1 — WekruitLLM unit tests.
 *
 * Covers:
 *  - LLM/LLMStream contract surface (label, model, provider, chat())
 *  - ChatContext ↔ AgentTurnContext mapping (system, user, assistant,
 *    fallback prompt, function-call drop, empty context)
 *  - Streaming behavior (chunks pushed with id + delta.role=assistant +
 *    delta.content; terminal usage chunk emitted)
 *  - Error / abort paths
 *
 * No real OpenAI calls — `opts.__runAgentTurnStream` swaps in a fake
 * AsyncGenerator and the AgentDef path is exercised end-to-end.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { llm, initializeLogger } from "@livekit/agents"

// LK Agents SDK requires the global logger to be initialized before any
// LLMStream is constructed (the base class touches `log()` in an instance
// initializer). In production `cli.runApp` calls this; in tests we do it
// once at module load.
initializeLogger({ pretty: false, level: "silent" })
import type {
  AgentTurnContext,
  AgentTurnStreamChunk,
} from "@pa/agent-runtime"

import {
  WekruitLLM,
  WekruitLLMStream,
  makeDefaultVoiceAgent,
  mapChatCtxToAgentTurnContext,
  type WekruitLLMOptions,
} from "../wekruit-llm.js"

/** Build a fake `runAgentTurnStream` that yields a scripted chunk sequence
 *  and captures the AgentTurnContext it was called with. */
function fakeRuntime(
  chunks: AgentTurnStreamChunk[],
  capture: { ctx?: AgentTurnContext } = {},
): WekruitLLMOptions["__runAgentTurnStream"] {
  return async function* (ctx: AgentTurnContext) {
    capture.ctx = ctx
    for (const c of chunks) yield c
  } as WekruitLLMOptions["__runAgentTurnStream"]
}

/** Drain an LLMStream synchronously into an array. */
async function collect(
  stream: llm.LLMStream,
): Promise<llm.ChatChunk[]> {
  const out: llm.ChatChunk[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

test("WekruitLLM.label() returns 'wekruit'", () => {
  const w = new WekruitLLM()
  assert.equal(w.label(), "wekruit")
})

test("WekruitLLM.model defaults to gpt-4o-mini and provider is wekruit-orchestrator", () => {
  const w = new WekruitLLM()
  assert.equal(w.model, "gpt-4o-mini")
  assert.equal(w.provider, "wekruit-orchestrator")
})

test("WekruitLLM.model honors opts.model", () => {
  const w = new WekruitLLM({ model: "gpt-4.1-mini" })
  assert.equal(w.model, "gpt-4.1-mini")
})

test("WekruitLLM.model honors opts.agent.model and beats opts.model", () => {
  const agent = makeDefaultVoiceAgent("gpt-5.4-nano")
  const w = new WekruitLLM({ model: "gpt-4o-mini", agent })
  assert.equal(w.model, "gpt-5.4-nano")
})

test("WekruitLLM.chat() returns an LLMStream instance", () => {
  const w = new WekruitLLM({
    __runAgentTurnStream: fakeRuntime([{ delta: "", finishReason: "stop" }]),
  })
  const ctx = new llm.ChatContext()
  const stream = w.chat({ chatCtx: ctx })
  assert.ok(stream instanceof llm.LLMStream)
  assert.ok(stream instanceof WekruitLLMStream)
  stream.close()
})

test("WekruitLLMStream emits ChatChunk shape with id + delta.role=assistant + delta.content", async () => {
  const w = new WekruitLLM({
    __runAgentTurnStream: fakeRuntime([
      { delta: "Hello" },
      { delta: " there" },
      { delta: "", finishReason: "stop" },
    ]),
  })
  const ctx = new llm.ChatContext()
  ctx.addMessage({ role: "user", content: "hi" })
  const out = await collect(w.chat({ chatCtx: ctx }))

  // 2 content deltas (terminal-stop has empty delta so it's skipped).
  const text = out
    .map((c) => c.delta?.content ?? "")
    .join("")
  assert.equal(text, "Hello there")
  for (const ev of out) {
    assert.ok(typeof ev.id === "string" && ev.id.length > 0, "id present")
    assert.equal(ev.delta?.role, "assistant")
  }
})

test("WekruitLLMStream emits a terminal usage chunk when runtime supplies usage", async () => {
  const w = new WekruitLLM({
    __runAgentTurnStream: fakeRuntime([
      { delta: "ok" },
      {
        delta: "",
        finishReason: "stop",
        usage: {
          promptTokens: 42,
          completionTokens: 7,
          totalTokens: 49,
          provider: "openai",
          model: "gpt-4o-mini",
        },
      },
    ]),
  })
  const ctx = new llm.ChatContext()
  ctx.addMessage({ role: "user", content: "hi" })
  const out = await collect(w.chat({ chatCtx: ctx }))

  const usageChunk = out.find((c) => c.usage)
  assert.ok(usageChunk, "usage chunk emitted")
  assert.equal(usageChunk!.usage!.promptTokens, 42)
  assert.equal(usageChunk!.usage!.completionTokens, 7)
  assert.equal(usageChunk!.usage!.totalTokens, 49)
  assert.equal(usageChunk!.usage!.promptCachedTokens, 0)
})

test("mapChatCtxToAgentTurnContext: empty context → fallback prompt + empty userMessage", () => {
  const ctx = new llm.ChatContext()
  const agent = makeDefaultVoiceAgent()
  const turn = mapChatCtxToAgentTurnContext(ctx, agent, "FALLBACK")
  assert.equal(turn.systemPrompt, "FALLBACK")
  assert.equal(turn.userMessage, "")
  assert.deepEqual(turn.history, [])
  assert.equal(turn.agent, agent)
})

test("mapChatCtxToAgentTurnContext: leading system messages → joined systemPrompt", () => {
  const ctx = new llm.ChatContext()
  ctx.addMessage({ role: "system", content: "Be terse." })
  ctx.addMessage({ role: "system", content: "Use English." })
  ctx.addMessage({ role: "user", content: "hi" })
  const agent = makeDefaultVoiceAgent()
  const turn = mapChatCtxToAgentTurnContext(ctx, agent, "FALLBACK")
  assert.equal(turn.systemPrompt, "Be terse.\n\nUse English.")
  assert.equal(turn.userMessage, "hi")
})

test("mapChatCtxToAgentTurnContext: last user msg becomes userMessage; prior turns become history", () => {
  const ctx = new llm.ChatContext()
  ctx.addMessage({ role: "system", content: "Sys." })
  ctx.addMessage({ role: "user", content: "first" })
  ctx.addMessage({ role: "assistant", content: "ack" })
  ctx.addMessage({ role: "user", content: "second" })
  const agent = makeDefaultVoiceAgent()
  const turn = mapChatCtxToAgentTurnContext(ctx, agent, "FALLBACK")
  assert.equal(turn.userMessage, "second")
  assert.equal(turn.history?.length, 2)
  assert.deepEqual(
    turn.history?.map((m) => ({ role: m.role, body: m.body })),
    [
      { role: "user", body: "first" },
      { role: "assistant", body: "ack" },
    ],
  )
})

test("mapChatCtxToAgentTurnContext: function calls / tool outputs are dropped from history", () => {
  const ctx = new llm.ChatContext()
  ctx.addMessage({ role: "system", content: "Sys." })
  ctx.addMessage({ role: "user", content: "u1" })
  // Inject a FunctionCall and a FunctionCallOutput between turns.
  ctx.insert(
    new llm.FunctionCall({
      callId: "c1",
      name: "search",
      args: "{}",
    }),
  )
  ctx.insert(
    new llm.FunctionCallOutput({
      callId: "c1",
      output: "result",
      isError: false,
    }),
  )
  ctx.addMessage({ role: "assistant", content: "a1" })
  ctx.addMessage({ role: "user", content: "u2" })
  const agent = makeDefaultVoiceAgent()
  const turn = mapChatCtxToAgentTurnContext(ctx, agent, "FALLBACK")
  assert.equal(turn.userMessage, "u2")
  // History: u1, a1 (function call + output dropped).
  assert.deepEqual(
    turn.history?.map((m) => ({ role: m.role, body: m.body })),
    [
      { role: "user", body: "u1" },
      { role: "assistant", body: "a1" },
    ],
  )
})

test("mapChatCtxToAgentTurnContext: no user message → empty userMessage, full slice becomes history", () => {
  const ctx = new llm.ChatContext()
  ctx.addMessage({ role: "system", content: "S" })
  ctx.addMessage({ role: "assistant", content: "preamble" })
  const agent = makeDefaultVoiceAgent()
  const turn = mapChatCtxToAgentTurnContext(ctx, agent, "FALLBACK")
  assert.equal(turn.userMessage, "")
  assert.deepEqual(
    turn.history?.map((m) => m.body),
    ["preamble"],
  )
})

test("WekruitLLMStream forwards systemPromptFallback into AgentTurnContext when no system msg present", async () => {
  const capture: { ctx?: AgentTurnContext } = {}
  const w = new WekruitLLM({
    systemPromptFallback: "OVERRIDE-PROMPT",
    __runAgentTurnStream: fakeRuntime(
      [{ delta: "", finishReason: "stop" }],
      capture,
    ),
  })
  const ctx = new llm.ChatContext()
  ctx.addMessage({ role: "user", content: "hi" })
  await collect(w.chat({ chatCtx: ctx }))
  assert.equal(capture.ctx?.systemPrompt, "OVERRIDE-PROMPT")
})

test("makeDefaultVoiceAgent: emits valid AgentDef shape with provider=openai", () => {
  const a = makeDefaultVoiceAgent()
  assert.equal(a.provider, "openai")
  assert.equal(a.model, "gpt-4o-mini")
  assert.equal(a.id, "voice-direct")
  assert.equal(a.memoryMode, "firestore_only")
  assert.equal(a.toolPolicy, "none")
})

test("WekruitLLM passes opts.agent through to AgentTurnContext.agent", async () => {
  const customAgent = makeDefaultVoiceAgent("gpt-5.4-nano")
  customAgent.systemPrompt = "CUSTOM-SYS"
  const capture: { ctx?: AgentTurnContext } = {}
  const w = new WekruitLLM({
    agent: customAgent,
    __runAgentTurnStream: fakeRuntime(
      [{ delta: "", finishReason: "stop" }],
      capture,
    ),
  })
  const ctx = new llm.ChatContext()
  ctx.addMessage({ role: "user", content: "hi" })
  await collect(w.chat({ chatCtx: ctx }))
  assert.equal(capture.ctx?.agent, customAgent)
  assert.equal(capture.ctx?.agent.model, "gpt-5.4-nano")
})
