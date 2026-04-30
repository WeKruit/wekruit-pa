import { test } from "node:test"
import assert from "node:assert/strict"

import { createLedger } from "./cost-ledger.mjs"
import {
  createQwen72bAdapter,
  QWEN_72B_ARM,
  QWEN_72B_MODEL,
} from "./qwen-72b-adapter.mjs"

function makeMockChat({ text = "mock", inputTokens = 100, outputTokens = 50 } = {}) {
  /** @type {any} */
  const fn = async ({ opts }) => ({
    text,
    usage: { inputTokens, outputTokens },
    model: (opts && opts.model) || "Qwen/Qwen2.5-72B-Instruct",
  })
  return fn
}

test("createQwen72bAdapter: throws without ledger", () => {
  assert.throws(() => createQwen72bAdapter(/** @type {any} */ ({})), /ledger required/i)
})

test("chat returns expected shape with 72B arm tag", async () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  const adapter = createQwen72bAdapter({ ledger, chatImpl: makeMockChat() })
  const result = await adapter.chat({ messages: [{ role: "user", content: "x" }] })
  assert.equal(result.meta.arm, QWEN_72B_ARM)
  assert.equal(result.meta.model, QWEN_72B_MODEL)
})

test("72B pricing: 1M+1M = $2.00", async () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  const mockChat = makeMockChat({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
  const adapter = createQwen72bAdapter({ ledger, chatImpl: mockChat })
  const result = await adapter.chat({ messages: [{ role: "user", content: "1" }] })
  assert.ok(Math.abs(result.usage.costUSD - 2.0) < 1e-9)
  assert.ok(Math.abs(ledger.totalUsd - 2.0) < 1e-9)
})

test("adapter exposes arm + model constants", () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  const adapter = createQwen72bAdapter({ ledger, chatImpl: makeMockChat() })
  assert.equal(adapter.arm, "qwen-72b-raw")
  assert.equal(adapter.model, "Qwen/Qwen2.5-72B-Instruct")
})
