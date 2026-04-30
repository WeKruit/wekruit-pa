import { test } from "node:test"
import assert from "node:assert/strict"

import {
  runBotChat,
  BENCHMARK_NAME,
  DEFAULT_SUBSET,
  TURNS_PER_DIALOGUE,
} from "./botchat.mjs"

test("botchat dry-run returns valid plan", async () => {
  const plan = /** @type {any} */ (await runBotChat({
    adapter: /** @type {any} */ (null),
    ledger: /** @type {any} */ (null),
    mode: "dry-run",
  }))
  assert.equal(plan.benchmark, BENCHMARK_NAME)
  assert.equal(plan.status, "dry-run")
  assert.equal(plan.planned_calls, DEFAULT_SUBSET * TURNS_PER_DIALOGUE)
  assert.ok(plan.projected_cost_usd > 0)
  // Each runner must individually fit comfortably within budget.
  assert.ok(plan.projected_cost_usd <= 25, `projected ${plan.projected_cost_usd} > $25`)
  assert.ok(typeof plan.repo_path === "string" && plan.repo_path.length > 0)
  assert.ok(Array.isArray(plan.notes) && plan.notes.length > 0)
})

test("botchat dry-run honors --arm and --subset overrides", async () => {
  const plan = /** @type {any} */ (await runBotChat({
    adapter: /** @type {any} */ (null),
    ledger: /** @type {any} */ (null),
    mode: "dry-run",
    subset: 5,
    arm: "qwen-72b-raw",
  }))
  assert.equal(plan.arm, "qwen-72b-raw")
  assert.equal(plan.planned_calls, 5 * TURNS_PER_DIALOGUE)
  // 72B is more expensive — sanity check projection scales with smaller subset.
  assert.ok(plan.projected_cost_usd > 0)
  assert.ok(plan.projected_cost_usd < 5)
})
