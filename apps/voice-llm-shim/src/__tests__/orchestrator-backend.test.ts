/**
 * v2.1 S2 task #12 — orchestrator-backend adapter tests.
 *
 * We do NOT exercise the real `@pa/agent-runtime` provider here (that requires
 * an OpenAI API key + env). The adapter exposes `__runAgentTurnStream` as a
 * test seam; we inject a fake generator that asserts the AgentTurnContext
 * shape it received and replays scripted chunks.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  createOrchestratorBackend,
  mapMessagesToAgentTurnContext,
} from "../runtime/orchestrator-backend.js"
import type { AgentTurnChatMessage } from "../runtime/contract.js"
import type { AgentDef } from "@pa/core-types"

const stubAgent: AgentDef = {
  id: "test-agent",
  name: "test",
  systemPrompt: "ignored — adapter rebuilds from messages",
  provider: "openai",
  model: "gpt-4o-mini",
  temperature: 0.7,
  version: "1",
  memoryMode: "firestore_only",
  toolPolicy: "none",
} as AgentDef

const FALLBACK_SP = "FALLBACK_SYSTEM_PROMPT"

test("mapMessagesToAgentTurnContext: joins leading system messages", () => {
  const msgs: AgentTurnChatMessage[] = [
    { role: "system", content: "you are A" },
    { role: "system", content: "and B" },
    { role: "user", content: "hello" },
  ]
  const ctx = mapMessagesToAgentTurnContext(msgs, stubAgent, FALLBACK_SP)
  assert.equal(ctx.systemPrompt, "you are A\n\nand B")
  assert.equal(ctx.userMessage, "hello")
  assert.deepEqual(ctx.history, [])
})

test("mapMessagesToAgentTurnContext: missing system message → fallback", () => {
  const msgs: AgentTurnChatMessage[] = [
    { role: "user", content: "ping" },
  ]
  const ctx = mapMessagesToAgentTurnContext(msgs, stubAgent, FALLBACK_SP)
  assert.equal(ctx.systemPrompt, FALLBACK_SP)
  assert.equal(ctx.userMessage, "ping")
})

test("mapMessagesToAgentTurnContext: last user wins, prior turns go to history", () => {
  const msgs: AgentTurnChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "first user" },
    { role: "assistant", content: "first reply" },
    { role: "user", content: "second user" },
    { role: "assistant", content: "second reply" },
    { role: "user", content: "current user" },
  ]
  const ctx = mapMessagesToAgentTurnContext(msgs, stubAgent, FALLBACK_SP)
  assert.equal(ctx.userMessage, "current user")
  assert.equal(ctx.history?.length, 4)
  assert.equal(ctx.history?.[0].role, "user")
  assert.equal(ctx.history?.[0].body, "first user")
  assert.equal(ctx.history?.[3].role, "assistant")
  assert.equal(ctx.history?.[3].body, "second reply")
})

test("mapMessagesToAgentTurnContext: empty messages → empty userMessage + fallback", () => {
  const ctx = mapMessagesToAgentTurnContext([], stubAgent, FALLBACK_SP)
  assert.equal(ctx.systemPrompt, FALLBACK_SP)
  assert.equal(ctx.userMessage, "")
  assert.deepEqual(ctx.history, [])
})

test("mapMessagesToAgentTurnContext: tool role mapped to assistant in history", () => {
  const msgs: AgentTurnChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "first" },
    { role: "tool", content: "tool-output" },
    { role: "user", content: "second" },
  ]
  const ctx = mapMessagesToAgentTurnContext(msgs, stubAgent, FALLBACK_SP)
  assert.equal(ctx.userMessage, "second")
  assert.equal(ctx.history?.length, 2)
  assert.equal(ctx.history?.[1].role, "assistant")
  assert.equal(ctx.history?.[1].body, "tool-output")
})

test("createOrchestratorBackend: streams chunks through unchanged", async () => {
  const captured: { ctx?: unknown } = {}
  const fakeStream = async function* (ctx: unknown) {
    captured.ctx = ctx
    yield { delta: "Hello", finishReason: undefined }
    yield { delta: ", ", finishReason: undefined }
    yield { delta: "world.", finishReason: "stop" as const }
  }

  const backend = createOrchestratorBackend({
    __runAgentTurnStream: fakeStream as unknown as typeof import("@pa/agent-runtime").runAgentTurnStream,
    agent: stubAgent,
  })

  const chunks: Array<{ delta: string; finishReason?: string | null }> = []
  for await (const c of backend({
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ],
    model: "test-model",
  })) {
    chunks.push(c)
  }

  // 3 chunks: 2 mid + terminal `stop`.
  assert.equal(chunks.length, 3)
  assert.equal(chunks[0].delta, "Hello")
  assert.equal(chunks[0].finishReason, null)
  assert.equal(chunks[1].delta, ", ")
  assert.equal(chunks[1].finishReason, null)
  assert.equal(chunks[2].delta, "world.")
  assert.equal(chunks[2].finishReason, "stop")

  // Verify ctx mapped correctly.
  const ctx = captured.ctx as {
    systemPrompt: string
    userMessage: string
    agent: AgentDef
  }
  assert.equal(ctx.systemPrompt, "s")
  assert.equal(ctx.userMessage, "hi")
  assert.equal(ctx.agent.id, "test-agent")
})

test("createOrchestratorBackend: finishReason='error' → terminal null + warn", async () => {
  const warns: string[] = []
  const logger = {
    warn: (m: string) => warns.push(m),
    info: () => {},
  }
  const fakeStream = async function* () {
    yield { delta: "partial", finishReason: undefined }
    yield { delta: "boom", finishReason: "error" as const }
  }
  const backend = createOrchestratorBackend({
    __runAgentTurnStream: fakeStream as unknown as typeof import("@pa/agent-runtime").runAgentTurnStream,
    logger,
  })

  const chunks: Array<{ delta: string; finishReason?: string | null }> = []
  for await (const c of backend({
    messages: [{ role: "user", content: "x" }],
  })) {
    chunks.push(c)
  }

  // partial (null) + "boom" (null) + sentinel "" (null)
  assert.equal(chunks.length, 3)
  assert.equal(chunks[0].delta, "partial")
  assert.equal(chunks[0].finishReason, null)
  assert.equal(chunks[1].delta, "boom")
  assert.equal(chunks[1].finishReason, null)
  assert.equal(chunks[2].delta, "")
  assert.equal(chunks[2].finishReason, null)
  assert.ok(
    warns.some((w) => w.includes("upstream finishReason=error")),
    "expected error warn"
  )
})

test("createOrchestratorBackend: missing terminal → synthetic stop", async () => {
  const fakeStream = async function* () {
    yield { delta: "a", finishReason: undefined }
    yield { delta: "b", finishReason: undefined }
    // generator ends with no terminal chunk
  }
  const backend = createOrchestratorBackend({
    __runAgentTurnStream: fakeStream as unknown as typeof import("@pa/agent-runtime").runAgentTurnStream,
  })

  const chunks: Array<{ delta: string; finishReason?: string | null }> = []
  for await (const c of backend({
    messages: [{ role: "user", content: "x" }],
  })) {
    chunks.push(c)
  }
  assert.equal(chunks.length, 3)
  assert.equal(chunks[2].delta, "")
  assert.equal(chunks[2].finishReason, "stop")
})

test("createOrchestratorBackend: rethrows when upstream throws", async () => {
  const fakeStream = async function* () {
    throw new Error("PA_AGENT_RUNTIME_STREAM_ENABLED=false")
    // eslint-disable-next-line no-unreachable
    yield { delta: "", finishReason: "stop" as const }
  }
  const backend = createOrchestratorBackend({
    __runAgentTurnStream: fakeStream as unknown as typeof import("@pa/agent-runtime").runAgentTurnStream,
    logger: { warn: () => {}, info: () => {} },
  })

  let caught: Error | undefined
  try {
    for await (const _c of backend({
      messages: [{ role: "user", content: "x" }],
    })) {
      // consume
    }
  } catch (err) {
    caught = err as Error
  }
  assert.ok(caught, "expected throw")
  assert.match(caught!.message, /PA_AGENT_RUNTIME_STREAM_ENABLED/)
})

test("createOrchestratorBackend: forwards 'length' finishReason", async () => {
  const fakeStream = async function* () {
    yield { delta: "trunc", finishReason: "length" as const }
  }
  const backend = createOrchestratorBackend({
    __runAgentTurnStream: fakeStream as unknown as typeof import("@pa/agent-runtime").runAgentTurnStream,
  })
  const chunks: Array<{ delta: string; finishReason?: string | null }> = []
  for await (const c of backend({
    messages: [{ role: "user", content: "x" }],
  })) {
    chunks.push(c)
  }
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].finishReason, "length")
})
