/**
 * iter30 WS1 — `mem0Add` metadata + agentId pass-through.
 *
 * We mock the Mem0 OSS Memory class via `__test__setMemoryCtor` so we never
 * touch SiliconFlow / Qdrant. The fake Memory ctor records every `add()` call
 * and exposes them for assertion. This guards three contracts:
 *
 *   1. 3-arg legacy calls (`mem0Add(config, msgs, userId)`) still pass exactly
 *      `{ userId }` to the SDK — backward-compat for all 8 existing callers.
 *   2. 4-arg metadata path forwards `metadata` verbatim to the SDK.
 *   3. 4-arg agentId path forwards `agentId` verbatim and (optional) `infer`.
 *
 * Round-trip into the actual Qdrant payload is verified separately by
 * `packages/memory/scripts/verify-mem0-metadata-roundtrip.mjs` (live infra).
 */
import assert from "node:assert/strict"
import test, { afterEach } from "node:test"
import {
  mem0Add,
  _resetMem0Client,
  __test__setMemoryCtor,
  type Mem0Config,
} from "../mem0.js"

const baseConfig: Mem0Config = {
  apiKey: "sk-test",
  qdrantUrl: "https://qdrant.example",
  qdrantApiKey: "q",
}

type AddCall = {
  messages: Array<{ role: "user" | "assistant"; content: string }>
  options: Record<string, unknown>
}

function installFakeMemory(): { calls: AddCall[] } {
  const calls: AddCall[] = []
  class FakeMemory {
    constructor(_cfg: Record<string, unknown>) {
      // no-op: production path normalizes config; we just want the shim
    }
    async add(messages: AddCall["messages"], options: Record<string, unknown>) {
      calls.push({ messages, options })
      return { results: [] }
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async search(_q: string, _opts: unknown) {
      return { results: [] }
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __test__setMemoryCtor(FakeMemory as any)
  return { calls }
}

afterEach(() => {
  __test__setMemoryCtor(null)
  _resetMem0Client()
})

test("mem0Add 3-arg legacy: forwards { userId } only — no metadata, no agentId", async () => {
  const { calls } = installFakeMemory()
  await mem0Add(
    baseConfig,
    [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ],
    "user-legacy"
  )
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.options, { userId: "user-legacy" })
  assert.equal(calls[0]!.messages.length, 2)
})

test("mem0Add 4-arg metadata: forwards metadata verbatim alongside userId", async () => {
  const { calls } = installFakeMemory()
  const metadata = { intentTag: "preference", source: "iter30-test", testRun: 12345 }
  await mem0Add(
    baseConfig,
    [{ role: "user", content: "I prefer evening interviews" }],
    "user-meta",
    { metadata }
  )
  assert.equal(calls.length, 1)
  const opts = calls[0]!.options
  assert.equal(opts.userId, "user-meta")
  assert.deepEqual(opts.metadata, metadata)
  assert.equal(opts.agentId, undefined, "agentId must NOT be set when caller omits it")
  assert.equal(opts.infer, undefined, "infer must NOT be set when caller omits it")
})

test("mem0Add 4-arg agentId: forwards agentId verbatim alongside userId", async () => {
  const { calls } = installFakeMemory()
  await mem0Add(
    baseConfig,
    [{ role: "user", content: "Send my CV to the recruiter" }],
    "user-agent",
    { agentId: "pa-orchestrator-v2" }
  )
  assert.equal(calls.length, 1)
  const opts = calls[0]!.options
  assert.equal(opts.userId, "user-agent")
  assert.equal(opts.agentId, "pa-orchestrator-v2")
  assert.equal(opts.metadata, undefined)
})

test("mem0Add 4-arg combined: metadata + agentId + infer:false all forwarded", async () => {
  const { calls } = installFakeMemory()
  const metadata = { intentTag: "fact", topic: "career" }
  await mem0Add(
    baseConfig,
    [{ role: "user", content: "I work at WeKruit" }],
    "user-combined",
    { metadata, agentId: "agent-x", infer: false }
  )
  assert.equal(calls.length, 1)
  const opts = calls[0]!.options
  assert.equal(opts.userId, "user-combined")
  assert.deepEqual(opts.metadata, metadata)
  assert.equal(opts.agentId, "agent-x")
  assert.equal(opts.infer, false)
})

test("mem0Add 4-arg crisis-scrub: skip applies regardless of metadata being set", async () => {
  const { calls } = installFakeMemory()
  await mem0Add(
    baseConfig,
    [{ role: "user", content: "我想自杀，活不下去了" }],
    "user-crisis",
    { metadata: { intentTag: "preference" } }
  )
  // The crisis-scrub gate MUST short-circuit BEFORE the SDK is invoked,
  // even when iter30 metadata is supplied. Otherwise crisis content lands
  // in Qdrant payload despite the safety check.
  assert.equal(calls.length, 0, "crisis content must not reach the SDK even with metadata")
})

test("mem0Add 4-arg empty options object: equivalent to 3-arg call", async () => {
  const { calls } = installFakeMemory()
  await mem0Add(
    baseConfig,
    [{ role: "user", content: "ping" }],
    "user-empty-opts",
    {}
  )
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.options, { userId: "user-empty-opts" })
})
