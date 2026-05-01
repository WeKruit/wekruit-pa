import assert from "node:assert/strict"
import test from "node:test"
import { loadSeedAgents } from "./seed.js"

// Phase 10.5 cleanup C3 — seed.json must match the post-Phase-10.5
// production target so fresh installs do not diverge from the running
// `pa-agents/default` document. Carry-over #6 in 10.5-VERIFICATION.md.
//
// The fields below are the contract that ensureSeedAgents writes into
// pa_agents on first boot. T8's idempotent migration keeps live docs in
// sync; the seed must be the same shape so migrations remain idempotent
// no-ops on a fresh install.

test("loadSeedAgents parses cleanly through AgentDefSchema (no zod errors)", () => {
  const agents = loadSeedAgents()
  assert.equal(agents.length, 1)
  assert.equal(agents[0]!.id, "default")
})

test("default seed agent matches Phase 10.5 production target (provider/model/toolPolicy/allowedConnectors/toolBudgetPerTurn)", () => {
  const [agent] = loadSeedAgents()
  assert.ok(agent)
  assert.equal(agent.provider, "openai")
  assert.equal(agent.model, "gpt-5.4-nano")
  assert.equal(agent.toolPolicy, "allowlist")
  assert.deepEqual(agent.allowedConnectors, ["current-info", "remember-fact", "wekruit-matching", "save-job-profile"])
  assert.equal(agent.toolBudgetPerTurn, 3)
  assert.equal(agent.isDefault, true)
  assert.equal(agent.memoryMode, "firestore_only")
})
