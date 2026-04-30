import { test } from "node:test"
import assert from "node:assert/strict"

import { createLedger, BudgetExceededError } from "./cost-ledger.mjs"
import {
  createQwen7bAdapter,
  QWEN_7B_ARM,
  QWEN_7B_MODEL,
} from "./qwen-7b-adapter.mjs"

function makeMockChat({ text = "mock reply", inputTokens = 100, outputTokens = 50 } = {}) {
  let calls = 0
  /** @type {any} */
  const fn = async ({ messages, opts }) => {
    calls += 1
    void messages
    return {
      text,
      usage: { inputTokens, outputTokens },
      model: (opts && opts.model) || "Qwen/Qwen2.5-7B-Instruct",
    }
  }
  fn.callCount = () => calls
  return fn
}

test("createQwen7bAdapter: throws without ledger", () => {
  assert.throws(() => createQwen7bAdapter(/** @type {any} */ ({})), /ledger required/i)
})

test("chat returns text + usage + meta with arm + model", async () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  const mockChat = makeMockChat({ text: "hi back", inputTokens: 200, outputTokens: 100 })
  const adapter = createQwen7bAdapter({ ledger, chatImpl: mockChat })

  const result = await adapter.chat({
    messages: [{ role: "user", content: "hi" }],
    opts: { benchmark: "botchat" },
  })

  assert.equal(result.text, "hi back")
  assert.equal(result.usage.inputTokens, 200)
  assert.equal(result.usage.outputTokens, 100)
  assert.ok(typeof result.usage.costUSD === "number")
  assert.ok(result.usage.costUSD > 0)
  assert.equal(result.meta.arm, QWEN_7B_ARM)
  assert.equal(result.meta.model, QWEN_7B_MODEL)
})

test("chat charges ledger on each call", async () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  const mockChat = makeMockChat({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
  const adapter = createQwen7bAdapter({ ledger, chatImpl: mockChat })

  await adapter.chat({ messages: [{ role: "user", content: "1" }] })
  assert.ok(Math.abs(ledger.totalUsd - 0.21) < 1e-9)
  assert.equal(ledger.callCount, 1)

  await adapter.chat({ messages: [{ role: "user", content: "2" }] })
  assert.ok(Math.abs(ledger.totalUsd - 0.42) < 1e-9)
  assert.equal(ledger.callCount, 2)
})

test("ledger budget exceeded bubbles up", async () => {
  const ledger = createLedger({ maxBudgetUsd: 0.1 })
  const mockChat = makeMockChat({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
  const adapter = createQwen7bAdapter({ ledger, chatImpl: mockChat })
  await assert.rejects(
    () => adapter.chat({ messages: [{ role: "user", content: "1" }] }),
    (err) => err instanceof BudgetExceededError
  )
})

test("adapter exposes arm + model", () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  const adapter = createQwen7bAdapter({ ledger, chatImpl: makeMockChat() })
  assert.equal(adapter.arm, "qwen-7b-raw")
  assert.equal(adapter.model, "Qwen/Qwen2.5-7B-Instruct")
})

test("ledger snapshot reflects benchmark + arm tagging", async () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  const mockChat = makeMockChat({ inputTokens: 100, outputTokens: 50 })
  const adapter = createQwen7bAdapter({ ledger, chatImpl: mockChat })
  await adapter.chat({
    messages: [{ role: "user", content: "1" }],
    opts: { benchmark: "esconv" },
  })
  const snap = ledger.snapshot()
  assert.equal(snap.byBenchmark.esconv.calls, 1)
  assert.equal(snap.byArm["qwen-7b-raw"].calls, 1)
})
