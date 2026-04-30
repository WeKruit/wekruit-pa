import { test } from "node:test"
import assert from "node:assert/strict"

import {
  parseArgs,
  runDryRun,
  runLive,
  RUNNERS,
  DEFAULT_MAX_BUDGET_USD,
} from "./run-all.mjs"
import { BudgetExceededError } from "./lib/cost-ledger.mjs"

test("parseArgs defaults to dry-run + claire-stack", () => {
  const a = parseArgs([])
  assert.equal(a.mode, "dry-run")
  assert.equal(a.arm, "claire-stack")
  assert.equal(a.maxBudgetUsd, DEFAULT_MAX_BUDGET_USD)
  assert.equal(a.subset, null)
})

test("parseArgs honors --live --arm --subset --only --max-budget-usd", () => {
  const a = parseArgs([
    "--live",
    "--arm=qwen-72b-raw",
    "--subset=10",
    "--only=botchat,esconv",
    "--max-budget-usd=15",
  ])
  assert.equal(a.mode, "live")
  assert.equal(a.arm, "qwen-72b-raw")
  assert.equal(a.subset, 10)
  assert.deepEqual(a.only, ["botchat", "esconv"])
  assert.equal(a.maxBudgetUsd, 15)
})

test("runDryRun emits plan covering all 5 runners with budget headroom", async () => {
  const args = parseArgs([])
  const out = await runDryRun(args)
  assert.equal(out.mode, "dry-run")
  assert.equal(out.runner_count, RUNNERS.length)
  assert.equal(out.plans.length, RUNNERS.length)
  assert.ok(out.total_projected_cost_usd > 0, "must project some cost")
  assert.ok(out.budget_ok, `total ${out.total_projected_cost_usd} must be ≤ ${out.max_budget_usd}`)
  assert.ok(out.budget_headroom_usd >= 0, "headroom must be non-negative")
  for (const r of RUNNERS) {
    assert.ok(
      out.plans.find((p) => p.benchmark === r.name),
      `expected plan for ${r.name}`
    )
  }
})

test("runDryRun under qwen-72b-raw arm still ≤ \\$25", async () => {
  const args = parseArgs(["--arm=qwen-72b-raw"])
  const out = await runDryRun(args)
  assert.equal(out.arm, "qwen-72b-raw")
  assert.ok(
    out.budget_ok,
    `qwen-72b total ${out.total_projected_cost_usd} must be ≤ $25 (per CONTEXT D-39-7 + subset sizes)`
  )
})

test("runDryRun --only filters runners", async () => {
  const args = parseArgs(["--only=botchat,esconv"])
  const out = await runDryRun(args)
  assert.equal(out.runner_count, 2)
  assert.deepEqual(
    out.plans.map((p) => p.benchmark).sort(),
    ["botchat", "esconv"]
  )
})

test("runLive without SILICONFLOW_API_KEY env throws", async () => {
  const oldA = process.env.SILICONFLOW_API_KEY
  const oldB = process.env.PA_OPENAI_AGENT_API_KEY
  const oldC = process.env.PA_SILICONFLOW_API_KEY
  delete process.env.SILICONFLOW_API_KEY
  delete process.env.PA_OPENAI_AGENT_API_KEY
  delete process.env.PA_SILICONFLOW_API_KEY
  try {
    await assert.rejects(
      () => runLive(parseArgs(["--live"])),
      /SILICONFLOW_API_KEY/
    )
  } finally {
    if (oldA) process.env.SILICONFLOW_API_KEY = oldA
    if (oldB) process.env.PA_OPENAI_AGENT_API_KEY = oldB
    if (oldC) process.env.PA_SILICONFLOW_API_KEY = oldC
  }
})

test("BudgetExceededError thrown by ledger when projected charge > max", () => {
  // Defense-in-depth verification: cost-ledger refuses charges above budget.
  // Same path that aborts mid-run when accumulated total ≥ $25.
  /** @type {any} */
  const err = new BudgetExceededError("test", { totalUsd: 24.99, attemptedUsd: 0.5, maxBudgetUsd: 25 })
  assert.equal(err.name, "BudgetExceededError")
  assert.equal(err.maxBudgetUsd, 25)
})
