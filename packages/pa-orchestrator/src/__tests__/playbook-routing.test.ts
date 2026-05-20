import assert from "node:assert/strict"
import test from "node:test"
import type { AgentTurnTool } from "@pa/agent-runtime"
import {
  filterTurnToolsForSkillAllowlist,
  type PlaybookRoutingResult,
} from "../playbook-routing.js"

const stubParams = {} as AgentTurnTool["parameters"]
const tools: AgentTurnTool[] = [
  { name: "find-match", description: "a", parameters: stubParams, execute: async () => "{}" },
  {
    name: "match-against-collab-jobs",
    description: "b",
    parameters: stubParams,
    execute: async () => "{}",
  },
]

test("filterTurnToolsForSkillAllowlist passes through on v1 cache path", () => {
  const routing: PlaybookRoutingResult = {
    addendum: "",
    allowedTools: ["find-match"],
    activeSkillKeys: ["x"],
    source: "v1_cache",
  }
  assert.equal(filterTurnToolsForSkillAllowlist(tools, routing).length, 2)
})

test("filterTurnToolsForSkillAllowlist filters on v2 path", () => {
  const routing: PlaybookRoutingResult = {
    addendum: "skill",
    allowedTools: ["match-against-collab-jobs"],
    activeSkillKeys: ["collab"],
    source: "skill_router_v2",
  }
  const filtered = filterTurnToolsForSkillAllowlist(tools, routing)
  assert.deepEqual(
    filtered.map((t) => t.name),
    ["match-against-collab-jobs"]
  )
})

test("filterTurnToolsForSkillAllowlist returns empty when v2 allowlist empty", () => {
  const routing: PlaybookRoutingResult = {
    addendum: "skill",
    allowedTools: [],
    activeSkillKeys: ["collab"],
    source: "skill_router_v2",
  }
  assert.equal(filterTurnToolsForSkillAllowlist(tools, routing).length, 0)
})
