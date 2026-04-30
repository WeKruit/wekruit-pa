import { test } from "node:test"
import assert from "node:assert/strict"

import {
  runCharacterEval,
  BENCHMARK_NAME,
  DEFAULT_SUBSET,
  PROMPTS_PER_CHAR,
} from "./character-eval.mjs"

test("character-eval dry-run returns valid plan", async () => {
  const plan = /** @type {any} */ (await runCharacterEval({
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
  // Subprocess command spec must appear in notes (Adam runs Python in own env).
  assert.ok(
    plan.notes.some((n) => n.includes("python -m characterval")),
    "expected subprocess command in notes"
  )
})

test("character-eval dry-run subset override", async () => {
  const plan = /** @type {any} */ (await runCharacterEval({
    adapter: /** @type {any} */ (null),
    ledger: /** @type {any} */ (null),
    mode: "dry-run",
    subset: 10,
    arm: "qwen-7b-raw",
  }))
  assert.equal(plan.arm, "qwen-7b-raw")
  assert.equal(plan.planned_calls, 10 * PROMPTS_PER_CHAR)
})
