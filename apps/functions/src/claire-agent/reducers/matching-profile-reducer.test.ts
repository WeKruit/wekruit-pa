/**
 * L1 reducer code-asserts for the keystone matching reducer (no LLM).
 *
 * These pin the RC1 canary fix: "avoid SWE, only product" must REMOVE SWE from
 * the positive set, write negativeRoleFunction, and switch jobType.
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/reducers/matching-profile-reducer.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { reduceMatchingPreferences } from "./matching-profile-reducer.js"

test("RC1: 'done with SWE, only product, full-time' replaces + writes negative + drops internship", () => {
  const current = {
    targetRoleFunction: ["software_engineering"],
    targetJobType: ["internship"],
  }
  const { next } = reduceMatchingPreferences(current, {
    onlyRoleFunctions: ["product_management"],
    avoidRoleFunctions: ["software_engineering"],
    jobType: ["full_time"],
  })
  assert.deepEqual(next.targetRoleFunction, ["product_management"], "SWE removed, product present")
  assert.ok(
    (next.negativeRoleFunction ?? []).includes("software_engineering"),
    "negativeRoleFunction has SWE",
  )
  assert.deepEqual(next.targetJobType, ["full_time"], "jobType switched to full_time")
})

test("'only X' REPLACES the positive set (not append)", () => {
  const { next } = reduceMatchingPreferences(
    { targetRoleFunction: ["software_engineering", "data_analysis"] },
    { onlyRoleFunctions: ["product_management"] },
  )
  assert.deepEqual(next.targetRoleFunction, ["product_management"])
})

test("'avoid Y' subtracts from positive even without an 'only'", () => {
  const { next, removedFromPositive } = reduceMatchingPreferences(
    { targetRoleFunction: ["software_engineering", "product_management"] },
    { avoidRoleFunctions: ["software_engineering"] },
  )
  assert.deepEqual(next.targetRoleFunction, ["product_management"])
  assert.deepEqual(next.negativeRoleFunction, ["software_engineering"])
  assert.deepEqual(removedFromPositive, ["software_engineering"])
})

test("negatives ACCUMULATE across turns (durable, not replaced)", () => {
  const afterFirst = reduceMatchingPreferences(
    { targetRoleFunction: ["software_engineering", "sales", "product_management"] },
    { avoidRoleFunctions: ["software_engineering"] },
  ).next
  const afterSecond = reduceMatchingPreferences(afterFirst, {
    avoidRoleFunctions: ["sales"],
  }).next
  assert.deepEqual(afterSecond.negativeRoleFunction?.sort(), ["sales", "software_engineering"])
  assert.deepEqual(afterSecond.targetRoleFunction, ["product_management"])
})

test("'only X' un-avoids X if it was previously on the negative axis", () => {
  const start = { targetRoleFunction: ["product_management"], negativeRoleFunction: ["software_engineering"] }
  const { next } = reduceMatchingPreferences(start, { onlyRoleFunctions: ["software_engineering"] })
  assert.deepEqual(next.targetRoleFunction, ["software_engineering"])
  assert.deepEqual(next.negativeRoleFunction ?? [], [], "SWE removed from negative axis when now wanted")
})

test("empty/absent proposal fields are no-ops (no accidental clobber)", () => {
  const start = {
    targetRoleFunction: ["product_management"],
    targetJobType: ["full_time"],
    targetLocations: ["san_francisco_bay_area"],
  }
  const { next, changed } = reduceMatchingPreferences(start, {
    onlyRoleFunctions: null,
    avoidRoleFunctions: [],
    jobType: null,
    locations: undefined,
  })
  assert.deepEqual(next.targetRoleFunction, ["product_management"])
  assert.deepEqual(next.targetJobType, ["full_time"])
  assert.deepEqual(next.targetLocations, ["san_francisco_bay_area"])
  assert.deepEqual(changed, {}, "nothing changed")
})

test("'only' then 'avoid' in one proposal: avoid wins the subtraction", () => {
  const { next } = reduceMatchingPreferences(
    { targetRoleFunction: ["sales"] },
    { onlyRoleFunctions: ["product_management", "sales"], avoidRoleFunctions: ["sales"] },
  )
  assert.deepEqual(next.targetRoleFunction, ["product_management"])
  assert.deepEqual(next.negativeRoleFunction, ["sales"])
})
