/**
 * v2.1 S2 task #12 — resolver wiring for orchestrator backend.
 *
 * `WEKRUIT_LLM_SHIM_BACKEND=fake` → echo fake.
 * `WEKRUIT_LLM_SHIM_BACKEND=orchestrator` → orchestrator-backend adapter.
 * Unknown / missing → fake (with warn).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { resolveRunAgentTurnStream } from "../runtime/resolve.js"

const silentLogger = { warn: () => {}, info: () => {} }

test("resolve: backend=fake returns a function", async () => {
  const fn = await resolveRunAgentTurnStream({
    backend: "fake",
    logger: silentLogger,
  })
  assert.equal(typeof fn, "function")
})

test("resolve: backend=fake echoes the last user message", async () => {
  const fn = await resolveRunAgentTurnStream({
    backend: "fake",
    logger: silentLogger,
  })
  const chunks: Array<{ delta: string; finishReason?: string | null }> = []
  for await (const c of fn({
    messages: [{ role: "user", content: "hi" }],
  })) {
    chunks.push(c)
  }
  // fake prepends "echo: " — concatenated deltas should match.
  const joined = chunks.map((c) => c.delta).join("")
  assert.match(joined, /echo: hi/)
  // last chunk has finishReason="stop"
  assert.equal(chunks[chunks.length - 1].finishReason, "stop")
})

test("resolve: backend=orchestrator returns a function (adapter wired)", async () => {
  const fn = await resolveRunAgentTurnStream({
    backend: "orchestrator",
    logger: silentLogger,
  })
  assert.equal(
    typeof fn,
    "function",
    "expected orchestrator backend to resolve to a function"
  )
  // We DO NOT invoke it — that would try to call the real
  // runAgentTurnStream which requires PA_AGENT_RUNTIME_STREAM_ENABLED=true
  // + provider keys. The adapter-internal seam test in
  // orchestrator-backend.test.ts covers behavior.
})

test("resolve: unknown backend → falls back to fake with warn", async () => {
  const warns: string[] = []
  const fn = await resolveRunAgentTurnStream({
    backend: "made-up",
    logger: {
      warn: (m: string) => warns.push(m),
      info: () => {},
    },
  })
  assert.equal(typeof fn, "function")
  assert.ok(
    warns.some((w) => w.includes('unknown backend "made-up"')),
    `expected unknown-backend warn; got: ${JSON.stringify(warns)}`
  )
})

test("resolve: env override via WEKRUIT_LLM_SHIM_BACKEND", async () => {
  const prev = process.env.WEKRUIT_LLM_SHIM_BACKEND
  process.env.WEKRUIT_LLM_SHIM_BACKEND = "orchestrator"
  try {
    const fn = await resolveRunAgentTurnStream({ logger: silentLogger })
    assert.equal(typeof fn, "function")
  } finally {
    if (prev === undefined) delete process.env.WEKRUIT_LLM_SHIM_BACKEND
    else process.env.WEKRUIT_LLM_SHIM_BACKEND = prev
  }
})
