import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  DEFAULT_PRICE_TABLE,
  BudgetExceededError,
  computeChargeUsd,
  createLedger,
  loadLedgerSnapshot,
  resolveMaxBudgetUsd,
  resolvePriceTable,
} from "./cost-ledger.mjs"

test("DEFAULT_PRICE_TABLE has Qwen + BGE entries", () => {
  assert.equal(DEFAULT_PRICE_TABLE["Qwen/Qwen2.5-7B-Instruct"].inputPerM, 0.07)
  assert.equal(DEFAULT_PRICE_TABLE["Qwen/Qwen2.5-7B-Instruct"].outputPerM, 0.14)
  assert.equal(DEFAULT_PRICE_TABLE["Qwen/Qwen2.5-72B-Instruct"].inputPerM, 0.5)
  assert.equal(DEFAULT_PRICE_TABLE["Qwen/Qwen2.5-72B-Instruct"].outputPerM, 1.5)
  assert.equal(DEFAULT_PRICE_TABLE["BAAI/bge-m3"].inputPerM, 0)
})

test("computeChargeUsd: 1M+1M Qwen-7B = $0.21", () => {
  const cost = computeChargeUsd(
    { model: "Qwen/Qwen2.5-7B-Instruct", inputTokens: 1_000_000, outputTokens: 1_000_000 },
    DEFAULT_PRICE_TABLE
  )
  assert.equal(cost, 0.07 + 0.14)
})

test("computeChargeUsd: 1M+1M Qwen-72B = $2.00", () => {
  const cost = computeChargeUsd(
    { model: "Qwen/Qwen2.5-72B-Instruct", inputTokens: 1_000_000, outputTokens: 1_000_000 },
    DEFAULT_PRICE_TABLE
  )
  assert.equal(cost, 0.5 + 1.5)
})

test("computeChargeUsd: BGE = $0", () => {
  const cost = computeChargeUsd(
    { model: "BAAI/bge-m3", inputTokens: 5_000_000, outputTokens: 0 },
    DEFAULT_PRICE_TABLE
  )
  assert.equal(cost, 0)
})

test("computeChargeUsd: unknown model = $0 (graceful)", () => {
  const cost = computeChargeUsd(
    { model: "MysteryModel-XL", inputTokens: 1000, outputTokens: 1000 },
    DEFAULT_PRICE_TABLE
  )
  assert.equal(cost, 0)
})

test("createLedger: charge accumulates total", () => {
  const ledger = createLedger({ maxBudgetUsd: 10 })
  const r1 = ledger.charge({
    model: "Qwen/Qwen2.5-7B-Instruct",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  })
  assert.ok(Math.abs(r1.totalUsd - 0.21) < 1e-9)
  assert.equal(r1.callCount, 1)

  const r2 = ledger.charge({
    model: "Qwen/Qwen2.5-7B-Instruct",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  })
  assert.ok(Math.abs(r2.totalUsd - 0.42) < 1e-9)
  assert.equal(r2.callCount, 2)
})

test("createLedger: 25 charges of 1M+1M Qwen-7B does NOT abort (5.25 < 25)", () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  for (let i = 0; i < 25; i++) {
    ledger.charge({
      model: "Qwen/Qwen2.5-7B-Instruct",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
  }
  assert.ok(ledger.totalUsd <= 25)
  assert.ok(Math.abs(ledger.totalUsd - 5.25) < 1e-9)
})

test("createLedger: charge that would exceed budget throws BudgetExceededError", () => {
  const ledger = createLedger({ maxBudgetUsd: 1 })
  // Each charge = $0.21
  for (let i = 0; i < 4; i++) {
    ledger.charge({
      model: "Qwen/Qwen2.5-7B-Instruct",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
  }
  // Total = $0.84. Next $0.21 → $1.05 > $1.0 → throw.
  assert.throws(
    () =>
      ledger.charge({
        model: "Qwen/Qwen2.5-7B-Instruct",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    (err) => err instanceof BudgetExceededError
  )
})

test("BudgetExceededError carries totalUsd, attemptedUsd, maxBudgetUsd", () => {
  const ledger = createLedger({ maxBudgetUsd: 0.1 })
  try {
    ledger.charge({
      model: "Qwen/Qwen2.5-7B-Instruct",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
    assert.fail("expected throw")
  } catch (err) {
    assert.ok(err instanceof BudgetExceededError)
    assert.equal(err.maxBudgetUsd, 0.1)
    assert.equal(err.totalUsd, 0)
    assert.ok(Math.abs(err.attemptedUsd - 0.21) < 1e-9)
  }
})

test("project does not mutate", () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  const projected = ledger.project({
    model: "Qwen/Qwen2.5-7B-Instruct",
    inputTokens: 500_000,
    outputTokens: 500_000,
  })
  assert.ok(Math.abs(projected - 0.105) < 1e-9)
  assert.equal(ledger.totalUsd, 0)
  assert.equal(ledger.callCount, 0)
})

test("snapshot has expected shape", () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  ledger.charge({
    model: "Qwen/Qwen2.5-7B-Instruct",
    inputTokens: 1000,
    outputTokens: 1000,
    benchmark: "botchat",
    arm: "claire-stack",
  })
  const snap = ledger.snapshot()
  assert.equal(snap.maxBudgetUsd, 25)
  assert.ok(snap.totalUsd > 0)
  assert.equal(snap.callCount, 1)
  assert.ok(snap.byModel["Qwen/Qwen2.5-7B-Instruct"])
  assert.equal(snap.byModel["Qwen/Qwen2.5-7B-Instruct"].calls, 1)
  assert.ok(snap.byBenchmark.botchat)
  assert.ok(snap.byArm["claire-stack"])
})

test("persistPath round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"))
  const path = join(dir, "cost-ledger.json")
  try {
    const ledger = createLedger({ maxBudgetUsd: 25, persistPath: path })
    ledger.charge({
      model: "Qwen/Qwen2.5-7B-Instruct",
      inputTokens: 1000,
      outputTokens: 1000,
      benchmark: "esconv",
      arm: "qwen-7b-raw",
    })
    assert.ok(existsSync(path), "persist file written")
    const loaded = loadLedgerSnapshot(path)
    assert.equal(loaded.callCount, 1)
    assert.equal(loaded.byBenchmark.esconv.calls, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("resolveMaxBudgetUsd: env override wins when no opt", () => {
  const prev = process.env.PA_BENCH_MAX_BUDGET_USD
  process.env.PA_BENCH_MAX_BUDGET_USD = "13"
  try {
    assert.equal(resolveMaxBudgetUsd(), 13)
    assert.equal(resolveMaxBudgetUsd(7), 7) // explicit opt wins
  } finally {
    if (prev === undefined) delete process.env.PA_BENCH_MAX_BUDGET_USD
    else process.env.PA_BENCH_MAX_BUDGET_USD = prev
  }
})

test("resolveMaxBudgetUsd: defaults to 25 when nothing set", () => {
  const prev = process.env.PA_BENCH_MAX_BUDGET_USD
  delete process.env.PA_BENCH_MAX_BUDGET_USD
  try {
    assert.equal(resolveMaxBudgetUsd(), 25)
  } finally {
    if (prev !== undefined) process.env.PA_BENCH_MAX_BUDGET_USD = prev
  }
})

test("resolvePriceTable: env JSON override", () => {
  const prev = process.env.PA_BENCH_PRICE_TABLE_JSON
  process.env.PA_BENCH_PRICE_TABLE_JSON = JSON.stringify({
    "Custom/Model": { inputPerM: 1, outputPerM: 2 },
  })
  try {
    const t = resolvePriceTable()
    assert.equal(t["Custom/Model"].inputPerM, 1)
  } finally {
    if (prev === undefined) delete process.env.PA_BENCH_PRICE_TABLE_JSON
    else process.env.PA_BENCH_PRICE_TABLE_JSON = prev
  }
})

test("loadLedgerSnapshot: returns null on missing file", () => {
  assert.equal(loadLedgerSnapshot("/no/such/path/cost.json"), null)
})

test("reset clears ledger", () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  ledger.charge({
    model: "Qwen/Qwen2.5-7B-Instruct",
    inputTokens: 1000,
    outputTokens: 1000,
  })
  assert.ok(ledger.totalUsd > 0)
  ledger.reset()
  assert.equal(ledger.totalUsd, 0)
  assert.equal(ledger.callCount, 0)
})
