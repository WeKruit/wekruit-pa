import { test } from "node:test"
import assert from "node:assert/strict"
import { isCanaryUser, isPrescreenNudgeCanary, CANARY_UIDS } from "./canary.js"

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

// 2026-06-10 trust audit (fix 10) — the stalled-screen nudge gate keys ONLY on
// the static dev cohort and DELIBERATELY ignores PA_ONBOARDING_RAMP_ALL (which
// makes isCanaryUser true for everyone in prod — a fresh proactive sender must
// not mass-send on first deploy). Dedicated ramp: PA_PRESCREEN_NUDGE_RAMP_ALL.
test("isPrescreenNudgeCanary — dev cohort only; IGNORES the onboarding ramp", () => {
  const savedOnboarding = process.env.PA_ONBOARDING_RAMP_ALL
  const savedNudge = process.env.PA_PRESCREEN_NUDGE_RAMP_ALL
  try {
    delete process.env.PA_PRESCREEN_NUDGE_RAMP_ALL
    process.env.PA_ONBOARDING_RAMP_ALL = "1"
    assert.equal(isCanaryUser("random-uid"), true, "(precondition) the onboarding ramp opens isCanaryUser")
    assert.equal(isPrescreenNudgeCanary("random-uid"), false, "the nudge gate stays dev-cohort-only")
    assert.equal(isPrescreenNudgeCanary("8fEwIduUrzxZsblHHsNz"), true)
    assert.equal(isPrescreenNudgeCanary("UKFaKdsMzzfPW2CDl5ve"), true)
    // Its OWN ramp switch widens it.
    process.env.PA_PRESCREEN_NUDGE_RAMP_ALL = "1"
    assert.equal(isPrescreenNudgeCanary("random-uid"), true)
  } finally {
    if (savedOnboarding === undefined) delete process.env.PA_ONBOARDING_RAMP_ALL
    else process.env.PA_ONBOARDING_RAMP_ALL = savedOnboarding
    if (savedNudge === undefined) delete process.env.PA_PRESCREEN_NUDGE_RAMP_ALL
    else process.env.PA_PRESCREEN_NUDGE_RAMP_ALL = savedNudge
  }
})
