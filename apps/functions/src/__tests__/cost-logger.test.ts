/**
 * Backlog #23/#24/#25 — cost-logger helper unit tests.
 *
 * Covers the new multi-kind shape (chat / embedding / mem0). Mocks the
 * firebase-functions logger so we can assert the emitted payload shape
 * without touching Cloud Logging.
 */
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { logger } from "firebase-functions/v2"

import { estimateUsdCost, logTokenSpend, type CostLogInput } from "../instrumentation/cost-logger.js"

type LogCall = { event: string; payload: Record<string, unknown> }

function captureLogger(): { calls: LogCall[]; restore: () => void } {
  const calls: LogCall[] = []
  const orig = logger.info
  ;(logger as unknown as { info: (...args: unknown[]) => void }).info = (event: unknown, payload: unknown) => {
    calls.push({ event: String(event), payload: (payload ?? {}) as Record<string, unknown> })
  }
  return {
    calls,
    restore: () => {
      ;(logger as unknown as { info: typeof orig }).info = orig
    },
  }
}

describe("cost-logger / chat (backward-compat)", () => {
  it("computes usd from token counts using the gpt-4o-mini default table", () => {
    const inp: CostLogInput = { model: "gpt-4o-mini", inputTokens: 1_000_000, outputTokens: 500_000 }
    const usd = estimateUsdCost(inp)
    // 1M * 0.15 + 0.5M * 0.6 = 0.15 + 0.30 = 0.45 (binary-fp tolerant)
    assert.ok(Math.abs(usd - 0.45) < 1e-9, `expected ~0.45, got ${usd}`)
  })

  it("emits pa.spend.daily with kind=chat and usd field", () => {
    const cap = captureLogger()
    try {
      logTokenSpend({ model: "gpt-4o-mini", inputTokens: 100, outputTokens: 200, labels: { turnId: "t1" } })
      assert.equal(cap.calls.length, 1)
      const c = cap.calls[0]!
      assert.equal(c.event, "pa.spend.daily")
      assert.equal(c.payload["pa.metric"], "pa.spend.daily")
      assert.equal(c.payload.kind, "chat")
      assert.equal(c.payload.model, "gpt-4o-mini")
      assert.equal(c.payload.inputTokens, 100)
      assert.equal(c.payload.outputTokens, 200)
      assert.equal(c.payload.turnId, "t1")
      assert.equal(typeof c.payload.usd, "number")
    } finally {
      cap.restore()
    }
  })
})

describe("cost-logger / embedding (Backlog #23 — job-rec-daily + paReverseMatch)", () => {
  it("prices text-embedding-3-small at $0.02 / 1M input tokens", () => {
    const usd = estimateUsdCost({
      kind: "embedding",
      model: "text-embedding-3-small",
      inputTokens: 1_000_000,
    })
    assert.equal(usd, 0.02)
  })

  it("emits with kind=embedding, count=1, service tag passed through", () => {
    const cap = captureLogger()
    try {
      logTokenSpend({
        kind: "embedding",
        service: "openai",
        model: "text-embedding-3-small",
        inputTokens: 2000,
        count: 1,
        labels: { caller: "job-rec-daily", userId: "u-test" },
      })
      assert.equal(cap.calls.length, 1)
      const c = cap.calls[0]!
      assert.equal(c.payload.kind, "embedding")
      assert.equal(c.payload.service, "openai")
      assert.equal(c.payload.model, "text-embedding-3-small")
      assert.equal(c.payload.inputTokens, 2000)
      assert.equal(c.payload.count, 1)
      assert.equal(c.payload.caller, "job-rec-daily")
      assert.equal(c.payload.userId, "u-test")
      // 2000 / 1M * 0.02 = 0.00004 (logger rounds to 6 dp; tolerant compare)
      const usdVal = Number(c.payload.usd)
      assert.ok(Math.abs(usdVal - 0.00004) < 1e-9, `expected ~0.00004 got ${usdVal}`)
    } finally {
      cap.restore()
    }
  })

  it("respects pre-computed costUsd when caller provides it", () => {
    const usd = estimateUsdCost({
      kind: "embedding",
      model: "text-embedding-3-small",
      inputTokens: 999999,
      costUsd: 0.123,
    })
    assert.equal(usd, 0.123)
  })
})

describe("cost-logger / mem0 (Backlog #24 — internal extractor)", () => {
  it("returns usd=0 for kind=mem0 (no client-visible token counts)", () => {
    const usd = estimateUsdCost({ kind: "mem0", model: "Qwen/Qwen2.5-72B-Instruct" })
    assert.equal(usd, 0)
  })

  it("emits with kind=mem0 and count=1 even when input/output tokens are zero", () => {
    const cap = captureLogger()
    try {
      logTokenSpend({
        kind: "mem0",
        service: "mem0",
        model: "qwen-extractor",
        count: 1,
        labels: { operation: "add", userId: "u-mem0" },
      })
      assert.equal(cap.calls.length, 1)
      const c = cap.calls[0]!
      assert.equal(c.payload.kind, "mem0")
      assert.equal(c.payload.count, 1)
      assert.equal(c.payload.usd, 0)
      assert.equal(c.payload.operation, "add")
    } finally {
      cap.restore()
    }
  })
})

describe("cost-logger / fail-open guard", () => {
  it("does not throw when the underlying logger throws", () => {
    const orig = logger.info
    ;(logger as unknown as { info: (...args: unknown[]) => void }).info = () => {
      throw new Error("simulated transport failure")
    }
    try {
      // Must not throw — production path tolerates telemetry failures.
      assert.doesNotThrow(() =>
        logTokenSpend({ kind: "embedding", model: "text-embedding-3-small", inputTokens: 100 })
      )
    } finally {
      ;(logger as unknown as { info: typeof orig }).info = orig
    }
  })
})
