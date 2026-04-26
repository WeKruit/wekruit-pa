/**
 * Phase 10.5 T8 — pure-logic tests for the default-agent migration.
 *
 * Hermetic: no Firestore. Imports `computePlan` + targets and exercises
 * idempotency, forward, and rollback semantics. Run via:
 *
 *   node --test scripts/pa-set-default-tool-policy.test.mjs
 */
import test from "node:test"
import assert from "node:assert/strict"
import {
  FORWARD_TARGET,
  ROLLBACK_TARGET,
  computePlan,
} from "./pa-set-default-tool-policy.mjs"

const baseAgent = Object.freeze({
  id: "default",
  name: "Default assistant",
  isDefault: true,
  provider: "openai",
  model: "gpt-5.4-nano",
  systemPrompt: "...",
  version: "1",
})

test("computePlan: forward write when current is the pre-Deploy-2 'none' shape", () => {
  const plan = computePlan(
    { ...baseAgent, toolPolicy: "none", allowedConnectors: [] },
    "forward"
  )
  assert.equal(plan.action, "update")
  assert.equal(plan.patch.toolPolicy, "allowlist")
  assert.deepEqual(plan.patch.allowedConnectors, ["current-info", "remember-fact"])
  assert.equal(plan.patch.toolBudgetPerTurn, 3)
  assert.equal(typeof plan.patch.updatedAt, "string")
  // The patch MUST NOT contain any field this script does not own.
  assert.deepEqual(
    Object.keys(plan.patch).sort(),
    ["allowedConnectors", "toolBudgetPerTurn", "toolPolicy", "updatedAt"]
  )
})

test("computePlan: forward is idempotent — already-migrated state returns noop", () => {
  const plan = computePlan(
    {
      ...baseAgent,
      toolPolicy: "allowlist",
      allowedConnectors: ["current-info", "remember-fact"],
      toolBudgetPerTurn: 3,
    },
    "forward"
  )
  assert.equal(plan.action, "noop")
  assert.equal(plan.patch, undefined)
})

test("computePlan: forward treats allowedConnectors order as insignificant (set-equal)", () => {
  // Operator may have flipped the order via dashboard. We must not
  // re-write the doc just because order differs.
  const plan = computePlan(
    {
      ...baseAgent,
      toolPolicy: "allowlist",
      allowedConnectors: ["remember-fact", "current-info"],
      toolBudgetPerTurn: 3,
    },
    "forward"
  )
  assert.equal(plan.action, "noop")
})

test("computePlan: forward writes when toolBudgetPerTurn drifted (e.g. 1 instead of 3)", () => {
  const plan = computePlan(
    {
      ...baseAgent,
      toolPolicy: "allowlist",
      allowedConnectors: ["current-info", "remember-fact"],
      toolBudgetPerTurn: 1,
    },
    "forward"
  )
  assert.equal(plan.action, "update")
  assert.equal(plan.patch.toolBudgetPerTurn, 3)
})

test("computePlan: rollback writes when current is allowlist", () => {
  const plan = computePlan(
    {
      ...baseAgent,
      toolPolicy: "allowlist",
      allowedConnectors: ["current-info", "remember-fact"],
      toolBudgetPerTurn: 3,
    },
    "rollback"
  )
  assert.equal(plan.action, "update")
  assert.equal(plan.patch.toolPolicy, "none")
  assert.deepEqual(plan.patch.allowedConnectors, [])
  // Rollback must NOT touch toolBudgetPerTurn (see ROLLBACK_TARGET docblock).
  assert.equal("toolBudgetPerTurn" in plan.patch, false)
})

test("computePlan: rollback is idempotent — already 'none' returns noop", () => {
  const plan = computePlan(
    { ...baseAgent, toolPolicy: "none", allowedConnectors: [] },
    "rollback"
  )
  assert.equal(plan.action, "noop")
})

test("computePlan: tolerates missing managed fields (defensive)", () => {
  // E.g. an old doc from before the toolPolicy schema landed.
  const plan = computePlan({ ...baseAgent }, "forward")
  assert.equal(plan.action, "update")
  assert.equal(plan.currentManaged.toolPolicy, null)
  assert.deepEqual(plan.currentManaged.allowedConnectors, [])
  assert.equal(plan.currentManaged.toolBudgetPerTurn, null)
})

test("computePlan: rejects invalid mode argument loudly", () => {
  assert.throws(() => computePlan({ ...baseAgent }, "sideways"))
})

test("FORWARD_TARGET and ROLLBACK_TARGET are frozen so callers can't mutate the constants", () => {
  assert.throws(() => {
    FORWARD_TARGET.allowedConnectors.push("rogue")
  })
  assert.throws(() => {
    ROLLBACK_TARGET.toolPolicy = "allowlist"
  })
})

// ---------- end-to-end CLI shape (apply→re-apply idempotency) ----------

test("computePlan: simulated apply→re-apply sequence is a no-op on the second pass", () => {
  // First call from baseline.
  let doc = { ...baseAgent, toolPolicy: "none", allowedConnectors: [] }
  const first = computePlan(doc, "forward")
  assert.equal(first.action, "update")
  // Apply the patch (in-process simulation of Firestore update()).
  doc = { ...doc, ...first.patch }
  // Second call — must be no-op.
  const second = computePlan(doc, "forward")
  assert.equal(second.action, "noop")
})

test("computePlan: simulated rollback after apply is a clean revert", () => {
  let doc = { ...baseAgent, toolPolicy: "none", allowedConnectors: [] }
  doc = { ...doc, ...computePlan(doc, "forward").patch }
  const rollbackPlan = computePlan(doc, "rollback")
  assert.equal(rollbackPlan.action, "update")
  doc = { ...doc, ...rollbackPlan.patch }
  assert.equal(doc.toolPolicy, "none")
  assert.deepEqual(doc.allowedConnectors, [])
  // toolBudgetPerTurn was 3 from the forward apply; rollback leaves it.
  assert.equal(doc.toolBudgetPerTurn, 3)
  // Re-rolling back is a no-op.
  const rollbackAgain = computePlan(doc, "rollback")
  assert.equal(rollbackAgain.action, "noop")
})
