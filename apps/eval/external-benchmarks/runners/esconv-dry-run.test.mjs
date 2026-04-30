import { test } from "node:test"
import assert from "node:assert/strict"

import {
  runESConv,
  BENCHMARK_NAME,
  DEFAULT_SUBSET,
  STRATEGIES,
} from "./esconv.mjs"

test("esconv dry-run returns valid plan", async () => {
  const plan = /** @type {any} */ (await runESConv({
    adapter: /** @type {any} */ (null),
    ledger: /** @type {any} */ (null),
    mode: "dry-run",
  }))
  assert.equal(plan.benchmark, BENCHMARK_NAME)
  assert.equal(plan.status, "dry-run")
  // 2 calls per conv (classify + respond)
  assert.equal(plan.planned_calls, DEFAULT_SUBSET * 2)
  assert.ok(plan.projected_cost_usd > 0)
  assert.ok(plan.projected_cost_usd <= 25, `projected ${plan.projected_cost_usd} > $25`)
  assert.ok(typeof plan.repo_path === "string" && plan.repo_path.length > 0)
  assert.ok(Array.isArray(plan.notes) && plan.notes.length > 0)
  assert.equal(STRATEGIES.length, 8)
})

test("esconv dry-run subset override", async () => {
  const plan = /** @type {any} */ (await runESConv({
    adapter: /** @type {any} */ (null),
    ledger: /** @type {any} */ (null),
    mode: "dry-run",
    subset: 30,
    arm: "qwen-72b-raw",
  }))
  assert.equal(plan.arm, "qwen-72b-raw")
  assert.equal(plan.planned_calls, 60)
})
