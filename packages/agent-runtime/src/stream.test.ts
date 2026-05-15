import assert from "node:assert/strict"
import test from "node:test"
import type { AgentDef } from "@pa/core-types"
import { runAgentTurnStream } from "./stream.js"
import { __forTesting } from "./stream.js"
import type { AgentTurnContext, AgentTurnStreamChunk } from "./types.js"

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

function ctx(overrides: Partial<AgentTurnContext> = {}): AgentTurnContext {
  return {
    agent: agent(),
    systemPrompt: "hi",
    userMessage: "ping",
    ...overrides,
  }
}

function enableFlag(): void {
  process.env.PA_AGENT_RUNTIME_STREAM_ENABLED = "true"
  process.env.PA_OPENAI_AGENT_API_KEY = "test"
}

function disableFlag(): void {
  delete process.env.PA_AGENT_RUNTIME_STREAM_ENABLED
}

async function* mockChunks(
  chunks: AgentTurnStreamChunk[]
): AsyncGenerator<AgentTurnStreamChunk, void, void> {
  for (const c of chunks) {
    yield c
  }
}

test("runAgentTurnStream throws when flag disabled", async () => {
  disableFlag()
  process.env.PA_OPENAI_AGENT_API_KEY = "test"
  const iter = runAgentTurnStream(ctx())
  await assert.rejects(
    () => iter.next(),
    (err: Error) => err.message === "PA_AGENT_RUNTIME_STREAM_ENABLED=false"
  )
})

test("runAgentTurnStream emits chunked deltas (≥3 chunks for multi-token response)", async () => {
  enableFlag()
  __forTesting.override({
    chatCompletionsStream: () =>
      mockChunks([
        { delta: "Hello" },
        { delta: ", " },
        { delta: "world" },
        { delta: "!", finishReason: "stop" },
      ]),
  })

  try {
    const collected: AgentTurnStreamChunk[] = []
    for await (const chunk of runAgentTurnStream(ctx())) {
      collected.push(chunk)
    }
    assert.ok(collected.length >= 3, `expected ≥3 chunks, got ${collected.length}`)
    const text = collected.map((c) => c.delta).join("")
    assert.equal(text, "Hello, world!")
  } finally {
    __forTesting.reset()
    disableFlag()
  }
})

test("runAgentTurnStream finishReason populated on last chunk only", async () => {
  enableFlag()
  __forTesting.override({
    chatCompletionsStream: () =>
      mockChunks([
        { delta: "A" },
        { delta: "B" },
        { delta: "C", finishReason: "stop" },
      ]),
  })

  try {
    const collected: AgentTurnStreamChunk[] = []
    for await (const chunk of runAgentTurnStream(ctx())) {
      collected.push(chunk)
    }
    // Intermediate chunks: no finishReason
    assert.equal(collected[0]!.finishReason, undefined)
    assert.equal(collected[1]!.finishReason, undefined)
    // Terminal: finishReason set
    assert.equal(collected[collected.length - 1]!.finishReason, "stop")
  } finally {
    __forTesting.reset()
    disableFlag()
  }
})

test("runAgentTurnStream surfaces upstream errors as iterator rejection", async () => {
  enableFlag()
  async function* throwing(): AsyncGenerator<AgentTurnStreamChunk, void, void> {
    yield { delta: "partial" }
    throw new Error("simulated provider error")
  }
  __forTesting.override({ chatCompletionsStream: () => throwing() })

  try {
    await assert.rejects(
      (async () => {
        for await (const _ of runAgentTurnStream(ctx())) {
          // drain
        }
      })(),
      /simulated provider error/
    )
  } finally {
    __forTesting.reset()
    disableFlag()
  }
})

test("runAgentTurnStream propagates AbortSignal to provider", async () => {
  enableFlag()
  let observedSignal: AbortSignal | undefined
  __forTesting.override({
    chatCompletionsStream: (c: AgentTurnContext) => {
      observedSignal = c.signal
      return mockChunks([{ delta: "ok", finishReason: "stop" }])
    },
  })

  try {
    const controller = new AbortController()
    const iter = runAgentTurnStream(ctx({ signal: controller.signal }))
    for await (const _ of iter) {
      // drain
    }
    assert.ok(observedSignal, "provider received signal")
    assert.equal(observedSignal, controller.signal)
  } finally {
    __forTesting.reset()
    disableFlag()
  }
})

test("runAgentTurnStream surfaces usage on terminal chunk when provider emits it", async () => {
  enableFlag()
  __forTesting.override({
    chatCompletionsStream: () =>
      mockChunks([
        { delta: "hi" },
        {
          delta: "",
          finishReason: "stop",
          usage: {
            promptTokens: 12,
            completionTokens: 1,
            totalTokens: 13,
            provider: "openai",
            model: "gpt-5.4-nano",
          },
        },
      ]),
  })

  try {
    const collected: AgentTurnStreamChunk[] = []
    for await (const chunk of runAgentTurnStream(ctx())) {
      collected.push(chunk)
    }
    const terminal = collected[collected.length - 1]!
    assert.equal(terminal.finishReason, "stop")
    assert.equal(terminal.usage?.totalTokens, 13)
    assert.equal(terminal.usage?.provider, "openai")
  } finally {
    __forTesting.reset()
    disableFlag()
  }
})

test("runAgentTurnStream is import-stable when flag off (export exists, no throw at import)", () => {
  // Importing the module must not throw, regardless of flag state.
  // The function itself only throws on first `.next()` when flag off.
  // This test guards against future regressions where flag is read at
  // module load.
  assert.equal(typeof runAgentTurnStream, "function")
})
