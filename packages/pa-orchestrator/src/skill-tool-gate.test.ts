/**
 * iter30 WS4-A — SkillToolGate contract tests.
 *
 * Test gates:
 *   - no active skill → allowed (fall through)
 *   - active skill, empty union → DENY (no silent escalation)
 *   - active skill, union includes tool → ALLOW
 *   - active skill, union excludes tool → DENY
 *   - setActiveSkillsAllowedTools dedupes
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  checkToolAgainstSkills,
  setActiveSkillsAllowedTools,
} from "./skill-tool-gate.js"
import { createMockContext } from "./run-context.js"

test("no active skill → allowed", () => {
  const ctx = createMockContext({ activeSkills: [] })
  const r = checkToolAgainstSkills({ toolName: "saveJobProfile", ctx })
  assert.equal(r.allowed, true)
  assert.equal(r.reason, "no-active-skill")
})

test("active skill, empty union → DENY (no silent escalation)", () => {
  const ctx = createMockContext({ activeSkills: ["vent_support"] })
  // No activeSkillsAllowedTools set → empty union
  const r = checkToolAgainstSkills({ toolName: "saveJobProfile", ctx })
  assert.equal(r.allowed, false)
  assert.match(r.reason, /no-skill-allow-for:saveJobProfile/)
})

test("active skill, union includes tool → ALLOW", () => {
  const ctx = createMockContext({ activeSkills: ["headhunter"] })
  setActiveSkillsAllowedTools(ctx, ["saveJobProfile", "resumeParse"])
  const r = checkToolAgainstSkills({ toolName: "saveJobProfile", ctx })
  assert.equal(r.allowed, true)
  assert.equal(r.reason, "skill-stack-allows")
  assert.deepEqual(r.activeSkills, ["headhunter"])
})

test("active skill, union excludes tool → DENY", () => {
  const ctx = createMockContext({ activeSkills: ["headhunter"] })
  setActiveSkillsAllowedTools(ctx, ["saveJobProfile"])
  const r = checkToolAgainstSkills({ toolName: "deletePiiTool", ctx })
  assert.equal(r.allowed, false)
  assert.match(r.reason, /no-skill-allow-for:deletePiiTool/)
})

test("setActiveSkillsAllowedTools dedupes union", () => {
  const ctx = createMockContext({ activeSkills: ["headhunter", "jd_roast"] })
  setActiveSkillsAllowedTools(ctx, ["a", "b", "a", "c", "b"])
  const ctxExt = ctx as unknown as { activeSkillsAllowedTools: string[] }
  assert.deepEqual(ctxExt.activeSkillsAllowedTools.sort(), ["a", "b", "c"])
})
