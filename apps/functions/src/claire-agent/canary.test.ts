import { test } from "node:test"
import assert from "node:assert/strict"
import { isCanaryUser, CANARY_UIDS } from "./canary.js"

test("isCanaryUser — dev phones are in the cohort", () => {
  assert.equal(isCanaryUser("8fEwIduUrzxZsblHHsNz"), true) // Adam
  assert.equal(isCanaryUser("UKFaKdsMzzfPW2CDl5ve"), true) // Noah
})

test("isCanaryUser — everyone else is NOT (keeps existing behavior)", () => {
  for (const u of ["JA0ZkGfkfQqw7OrtXNcK", "random-uid", "", null, undefined]) {
    assert.equal(isCanaryUser(u as string), false)
  }
})

test("CANARY_UIDS — exactly the two dev phones (widen here to ramp)", () => {
  assert.equal(CANARY_UIDS.size, 2)
})
