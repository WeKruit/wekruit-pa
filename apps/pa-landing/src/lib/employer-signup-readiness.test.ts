// @ts-nocheck - source-contract model test runs with node --test via tsx.
import assert from "node:assert/strict"
import test from "node:test"

import {
  deriveEmployerSignupReadiness,
  type EmployerSignupReadinessSummary,
} from "./employer-signup-readiness.js"
import type { EmployerSignupFormState } from "./employer-signup-model.js"

const EMPTY_FORM: EmployerSignupFormState = {
  companyName: "",
  companyLinkedin: "",
  workEmail: "",
  contactName: "",
  roleAtCompany: "",
  stage: "",
  rolesHiring: "",
  hardFilters: "",
  screeningQuestions: "",
  calibrationExamples: "",
  feedbackLoop: "",
  introHandoff: "",
  notes: "",
}

const COMPLETE_FORM: EmployerSignupFormState = {
  ...EMPTY_FORM,
  rolesHiring: "Founding infra engineer",
  hardFilters: "Requires US work authorization",
  screeningQuestions: "Describe a platform tradeoff you owned",
  calibrationExamples: "Strong pass and false positive examples",
  notes: "API product depth and SF hybrid",
  feedbackLoop: "Post accepted or rejected intro feedback in the WeKruit thread",
  introHandoff: "Route accepted intros to Alex within two business days",
}

function labels(summary: EmployerSignupReadinessSummary) {
  return summary.items.map((item) => item.label)
}

test("deriveEmployerSignupReadiness exposes the Claire role packet in form order", () => {
  const summary = deriveEmployerSignupReadiness(EMPTY_FORM)

  assert.deepEqual(labels(summary), [
    "Role brief",
    "Hard filters",
    "Evidence probes",
    "Calibration",
    "Must-haves",
    "Feedback loop",
    "Intro handoff",
  ])
  assert.equal(summary.completedCount, 0)
  assert.equal(summary.totalCount, 7)
  assert.equal(summary.ready, false)
  assert.deepEqual(summary.items.map((item) => item.complete), [
    false,
    false,
    false,
    false,
    false,
    false,
    false,
  ])
})

test("deriveEmployerSignupReadiness marks partial employer packet evidence without inventing readiness", () => {
  const summary = deriveEmployerSignupReadiness({
    ...EMPTY_FORM,
    rolesHiring: "Founding infra engineer",
    hardFilters: "US work authorization",
    screeningQuestions: "What tradeoff did they own?",
    feedbackLoop: "Post pass/no-pass feedback in the WeKruit thread",
  })

  assert.equal(summary.completedCount, 4)
  assert.equal(summary.totalCount, 7)
  assert.equal(summary.ready, false)
  assert.deepEqual(
    summary.items.map((item) => [item.id, item.complete]),
    [
      ["role_brief", true],
      ["hard_filters", true],
      ["evidence_probes", true],
      ["calibration", false],
      ["must_haves", false],
      ["feedback_loop", true],
      ["intro_handoff", false],
    ],
  )
})

test("deriveEmployerSignupReadiness only marks the packet ready when every Claire prerequisite exists", () => {
  const summary = deriveEmployerSignupReadiness(COMPLETE_FORM)

  assert.equal(summary.completedCount, 7)
  assert.equal(summary.totalCount, 7)
  assert.equal(summary.ready, true)
  assert.equal(summary.items.every((item) => item.complete), true)
})
