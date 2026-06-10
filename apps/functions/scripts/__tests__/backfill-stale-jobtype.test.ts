/**
 * backfill-stale-jobtype — selection-logic unit tests (no Firestore, no writes).
 *
 * The script clears stale intern/new-grad `targetJobType` hard filters for
 * users whose seniority profile contradicts them (the 2026-06-09 live victim
 * class: "I am not looking for an internship" was inexpressible, so
 * targetJobType=["internship"] kept exact-match filtering to intern jobs).
 * These tests pin the PURE candidate-selection + proposal function; the
 * apply path is `applyPartialUserTags` (already covered by sole-writer tests).
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import {
  proposeStaleJobTypeClear,
  ESTABLISHED_CAREER_STAGES,
} from "../backfill-stale-jobtype.mjs"

test("flags internship filter on a senior careerStage — proposes the [] clear", () => {
  const p = proposeStaleJobTypeClear("u1", {
    targetJobType: ["internship"],
    careerStage: "senior",
  })
  assert.ok(p)
  assert.deepEqual(p.proposedTargetJobType, [], "pure-stale set clears to []")
  assert.deepEqual(p.staleTokens, ["internship"])
  assert.match(p.reason, /careerStage=senior/)
})

test("flags new_graduate filter on yoeRange max >= 3; keeps non-stale tokens", () => {
  const p = proposeStaleJobTypeClear("u2", {
    targetJobType: ["new_graduate", "full_time"],
    yoeRange: [3, 5],
  })
  assert.ok(p)
  assert.deepEqual(p.proposedTargetJobType, ["full_time"], "full_time survives the subtraction")
  assert.match(p.reason, /yoeRange/)
})

test("does NOT flag a genuinely junior profile (yoe < 3, student/entry stage)", () => {
  for (const tags of [
    { targetJobType: ["internship"], yoeRange: [0, 1], careerStage: "student" },
    { targetJobType: ["internship"], careerStage: "entry_level" },
    { targetJobType: ["internship"] }, // no seniority evidence at all
  ]) {
    assert.equal(proposeStaleJobTypeClear("u3", tags), null)
  }
})

test("does NOT flag users without intern/new-grad tokens, even when senior", () => {
  assert.equal(
    proposeStaleJobTypeClear("u4", { targetJobType: ["full_time"], careerStage: "senior" }),
    null,
  )
  assert.equal(proposeStaleJobTypeClear("u5", { careerStage: "senior" }), null)
  assert.equal(proposeStaleJobTypeClear("u6", undefined), null)
})

test("established-stage set matches the spec (mid_level..founder)", () => {
  assert.deepEqual(
    [...ESTABLISHED_CAREER_STAGES].sort(),
    ["c_level", "director", "founder", "manager", "mid_level", "principal", "senior", "staff", "vp"],
  )
})
