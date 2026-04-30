import { test } from "node:test"
import assert from "node:assert/strict"

import {
  runRoleLLM,
  BENCHMARK_NAME,
  DEFAULT_SUBSET,
  PROMPTS_PER_CHAR,
} from "./role-llm.mjs"

test("role-llm dry-run returns valid plan", async () => {
  const plan = /** @type {any} */ (await runRoleLLM({
    adapter: /** @type {any} */ (null),
    ledger: /** @type {any} */ (null),
    mode: "dry-run",
  }))
  assert.equal(plan.benchmark, BENCHMARK_NAME)
  assert.equal(plan.status, "dry-run")
  assert.equal(plan.planned_calls, DEFAULT_SUBSET * PROMPTS_PER_CHAR)
  assert.ok(plan.projected_cost_usd > 0)
  assert.ok(plan.projected_cost_usd <= 25, `projected ${plan.projected_cost_usd} > $25`)
  assert.ok(typeof plan.repo_path === "string" && plan.repo_path.length > 0)
  assert.ok(Array.isArray(plan.notes) && plan.notes.length > 0)
})

test("role-llm dry-run subset override", async () => {
  const plan = /** @type {any} */ (await runRoleLLM({
    adapter: /** @type {any} */ (null),
    ledger: /** @type {any} */ (null),
    mode: "dry-run",
    subset: 12,
    arm: "claire-stack",
  }))
  assert.equal(plan.arm, "claire-stack")
  assert.equal(plan.planned_calls, 12 * PROMPTS_PER_CHAR)
})
