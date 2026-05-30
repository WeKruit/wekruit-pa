/**
 * L1 reducer code-asserts for the onboarding FSM (no LLM).
 *
 * Pins the process-integrity invariants: earliest-pending ordering, no-skip
 * (out-of-order rejection), complete-once. The reducer is the sole authority on
 * which slot is next — the LLM (in the tool) can only PROPOSE an answer.
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/reducers/onboarding-fsm.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_ONBOARDING_SLOTS,
  nextOnboardingSlot,
  recordOnboardingAnswer,
  type OnboardingState,
} from "./onboarding-fsm.js"

function freshState(slots: string[]): OnboardingState {
  return { slots, answers: {}, complete: false }
}

test("nextOnboardingSlot hands the earliest pending slot + a prompt", () => {
  const s = freshState(["main_goal", "industry_interest", "location_relocation"])
  const next = nextOnboardingSlot(s)
  assert.equal(next.pending, "main_goal", "first slot is pending")
  assert.equal(next.complete, false)
  assert.ok(typeof next.prompt === "string" && next.prompt.length > 0, "prompt provided")
})

test("default slots fall back to SHARED_ONBOARDING_QUESTIONS ids (6 slots)", () => {
  // empty slots[] → reducer uses the canonical default set.
  // 6 slots after adding seniority_comp (intern/seniority + expected salary +
  // negotiable-or-firm) before special_context — Adam 2026-05-30.
  const s: OnboardingState = { slots: [], answers: {}, complete: false }
  const next = nextOnboardingSlot(s)
  assert.equal(next.pending, DEFAULT_ONBOARDING_SLOTS[0])
  assert.equal(DEFAULT_ONBOARDING_SLOTS.length, 6, "6 canonical onboarding slots")
  assert.deepEqual(
    [...DEFAULT_ONBOARDING_SLOTS],
    [
      "main_goal",
      "culture_stage",
      "industry_interest",
      "location_relocation",
      "seniority_comp",
      "special_context",
    ],
  )
})

test("no-skip: recording a non-earliest slot is rejected (out_of_order)", () => {
  const s = freshState(["main_goal", "industry_interest", "location_relocation"])
  const r = recordOnboardingAnswer(s, "location_relocation", "SF or remote")
  assert.equal(r.ok, false, "skip rejected")
  assert.equal(r.reason, "out_of_order: expected main_goal, not location_relocation")
  assert.equal(r.pending, "main_goal", "still points at the earliest pending")
  assert.deepEqual(s.answers, {}, "nothing recorded on a rejected skip")
})

test("walks all slots in order, advancing the pending pointer each turn", () => {
  const s = freshState(["main_goal", "industry_interest", "location_relocation"])

  let r = recordOnboardingAnswer(s, "main_goal", "growth and learning")
  assert.equal(r.ok, true)
  assert.equal(r.pending, "industry_interest", "advanced to slot 2")
  assert.equal(r.complete, false)

  r = recordOnboardingAnswer(s, "industry_interest", "fintech and AI")
  assert.equal(r.ok, true)
  assert.equal(r.pending, "location_relocation", "advanced to slot 3")

  r = recordOnboardingAnswer(s, "location_relocation", "SF or remote")
  assert.equal(r.ok, true)
  assert.equal(r.pending, null, "no slots left")
  assert.equal(r.complete, true, "complete after the final slot")
  assert.equal(s.complete, true, "complete flag set on state")
  assert.deepEqual(Object.keys(s.answers), ["main_goal", "industry_interest", "location_relocation"])
})

test("complete-once: after completion, nextOnboardingSlot reports complete and further records are rejected", () => {
  const s = freshState(["main_goal", "industry_interest"])
  recordOnboardingAnswer(s, "main_goal", "growth")
  recordOnboardingAnswer(s, "industry_interest", "fintech")
  assert.equal(s.complete, true)

  const next = nextOnboardingSlot(s)
  assert.equal(next.pending, null)
  assert.equal(next.complete, true)

  // a stray late record cannot un-complete or append a phantom slot.
  const r = recordOnboardingAnswer(s, "industry_interest", "changed my mind")
  assert.equal(r.ok, false, "post-complete record rejected")
  assert.equal(r.reason, "already_complete")
  assert.equal(s.answers["industry_interest"], "fintech", "original answer untouched")
})
