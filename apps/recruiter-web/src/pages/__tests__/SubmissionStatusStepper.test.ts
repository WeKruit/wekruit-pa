import assert from "node:assert/strict"
import test from "node:test"

import { buildSubmissionStatusStepper } from "../../components/SubmissionStatusStepper.js"

test("stepper labels follow the pinned 4-step pipeline", () => {
  const model = buildSubmissionStatusStepper("submitted")
  assert.deepEqual(
    model.steps.map((step) => step.label),
    ["Submitted", "WeKruit interview", "With client", "In progress"],
  )
})

test("pending-triage statuses map to step 1 (Submitted)", () => {
  for (const status of ["submitted", "new", "reviewing", undefined]) {
    const model = buildSubmissionStatusStepper(status)
    assert.equal(model.currentStep, 0, `status=${status}`)
    assert.equal(model.terminal, false)
    assert.equal(model.steps[0]?.state, "current")
    assert.equal(model.outcome.label, "In progress")
  }
})

test("wekruit_interview and legacy advanced map to step 2 (WeKruit interview)", () => {
  for (const status of ["wekruit_interview", "advanced"]) {
    const model = buildSubmissionStatusStepper(status)
    assert.equal(model.currentStep, 1, `status=${status}`)
    assert.equal(model.steps[1]?.label, "WeKruit interview")
    assert.equal(model.steps[1]?.state, "current")
    assert.equal(model.steps[0]?.state, "done")
  }
})

test("client_review maps to step 3 (With client)", () => {
  const model = buildSubmissionStatusStepper("client_review")
  assert.equal(model.currentStep, 2)
  assert.equal(model.steps[2]?.label, "With client")
  assert.equal(model.steps[2]?.state, "current")
})

test("hired is a green terminal outcome", () => {
  const model = buildSubmissionStatusStepper("hired")
  assert.equal(model.currentStep, 3)
  assert.equal(model.terminal, true)
  assert.deepEqual(model.outcome, { label: "Hired 🎉", tone: "ok" })
  assert.equal(model.steps[3]?.label, "Hired 🎉")
})

test("rejected is a danger terminal outcome", () => {
  const model = buildSubmissionStatusStepper("rejected")
  assert.equal(model.currentStep, 3)
  assert.equal(model.terminal, true)
  assert.deepEqual(model.outcome, { label: "Not moving forward", tone: "danger" })
})

test("rejected right after Submitted does NOT mark later stages done", () => {
  // Bug: a candidate rejected before any interview must not show checkmarks on
  // WeKruit interview / With client — stages they never reached.
  const model = buildSubmissionStatusStepper("rejected", [], [
    { status: "submitted" },
    { status: "rejected" },
  ])
  assert.equal(model.steps[0]?.state, "done") // Submitted — reached
  assert.equal(model.steps[1]?.state, "todo") // WeKruit interview — never reached
  assert.equal(model.steps[2]?.state, "todo") // With client — never reached
  assert.equal(model.steps[3]?.state, "current") // outcome carries the ✕
})

test("rejected after the WeKruit interview marks Submitted + WeKruit interview done", () => {
  const model = buildSubmissionStatusStepper("rejected", [], [
    { status: "submitted" },
    { status: "wekruit_interview" },
    { status: "rejected" },
  ])
  assert.equal(model.steps[0]?.state, "done")
  assert.equal(model.steps[1]?.state, "done") // reached WeKruit interview
  assert.equal(model.steps[2]?.state, "todo") // never reached With client
  assert.equal(model.steps[3]?.state, "current")
})

test("hired through all stages marks every stage done", () => {
  const model = buildSubmissionStatusStepper("hired", [], [
    { status: "submitted" },
    { status: "wekruit_interview" },
    { status: "client_review" },
    { status: "hired" },
  ])
  assert.equal(model.steps[0]?.state, "done")
  assert.equal(model.steps[1]?.state, "done")
  assert.equal(model.steps[2]?.state, "done")
  assert.equal(model.steps[3]?.state, "current")
})

test("duplicate is a muted terminal outcome", () => {
  const model = buildSubmissionStatusStepper("duplicate")
  assert.equal(model.terminal, true)
  assert.deepEqual(model.outcome, { label: "Duplicate", tone: "muted" })
})

test("needs-more-info pill shows only while reviewing with requestedInfo entries", () => {
  const requested = [
    { message: "Send the portfolio URL", at: "2026-06-08T00:00:00.000Z", by: "ops" },
    { message: "Confirm visa status", at: "2026-06-09T00:00:00.000Z", by: "ops" },
  ]
  const reviewing = buildSubmissionStatusStepper("reviewing", requested)
  assert.equal(reviewing.needsInfo, true)
  assert.equal(reviewing.needsInfoMessage, "Confirm visa status")

  assert.equal(buildSubmissionStatusStepper("submitted", requested).needsInfo, false)
  assert.equal(buildSubmissionStatusStepper("reviewing", []).needsInfo, false)
  assert.equal(buildSubmissionStatusStepper("reviewing").needsInfo, false)
})
