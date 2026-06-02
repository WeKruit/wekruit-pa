// @ts-nocheck - source-contract model test runs with node --test via tsx.
import assert from "node:assert/strict"
import test from "node:test"

import {
  buildEmployerSignupPayload,
  validateEmployerSignupForm,
  type EmployerSignupFormState,
} from "./employer-signup-model.js"

const VALID_FORM: EmployerSignupFormState = {
  companyName: "Example Systems",
  companyLinkedin: "https://www.linkedin.com/company/example-systems",
  workEmail: "TALENT@EXAMPLE.COM",
  contactName: "Alex Rivera",
  roleAtCompany: "Founder",
  stage: "seed",
  rolesHiring: "Founding infra engineer\nDeveloper platform PM",
  notes: "Must have shipped infrastructure products, can explain tradeoffs, and is SF hybrid.",
  hardFilters: "Requires US work authorization\nSF hybrid three days per week",
  screeningQuestions:
    "Describe a platform tradeoff you owned\nWhat evidence proves they can handle infra ambiguity?",
  calibrationExamples:
    "Strong pass: shipped a developer platform pricing migration under real customer load.\nFalse positive: only owned internal tooling without external developer users.",
  introHandoff:
    "After a passed profile, route accepted intros to Alex for a 30-minute hiring-manager screen within two business days.",
}

test("validateEmployerSignupForm requires a real primary role brief before Claire screens", () => {
  assert.equal(
    validateEmployerSignupForm({ ...VALID_FORM, rolesHiring: " \n " }),
    "Primary role brief is required before Claire can screen candidates.",
  )
})

test("validateEmployerSignupForm requires must-have evidence for Claire's probes", () => {
  assert.equal(
    validateEmployerSignupForm({ ...VALID_FORM, notes: " " }),
    "Must-haves are required so Claire can probe the right evidence.",
  )
})

test("validateEmployerSignupForm requires hard filters before Claire screens", () => {
  assert.equal(
    validateEmployerSignupForm({ ...VALID_FORM, hardFilters: " " }),
    "Hard filters are required so Claire knows what must stop a pass.",
  )
})

test("validateEmployerSignupForm requires screening questions before Claire interviews", () => {
  assert.equal(
    validateEmployerSignupForm({ ...VALID_FORM, screeningQuestions: " " }),
    "Screening questions are required so Claire knows what evidence to elicit.",
  )
})

test("validateEmployerSignupForm requires calibration examples before Claire screens", () => {
  assert.equal(
    validateEmployerSignupForm({ ...VALID_FORM, calibrationExamples: " " }),
    "Calibration examples are required so Claire knows what a strong pass and false positive look like.",
  )
})

test("validateEmployerSignupForm requires the post-pass intro handoff", () => {
  assert.equal(
    validateEmployerSignupForm({ ...VALID_FORM, introHandoff: " " }),
    "Intro handoff is required so passed candidates have a real next step.",
  )
})

test("validateEmployerSignupForm reports missing fields in the visible form order", () => {
  assert.equal(
    validateEmployerSignupForm({
      ...VALID_FORM,
      hardFilters: " ",
      screeningQuestions: " ",
      calibrationExamples: " ",
      notes: " ",
    }),
    "Hard filters are required so Claire knows what must stop a pass.",
  )

  assert.equal(
    validateEmployerSignupForm({
      ...VALID_FORM,
      calibrationExamples: " ",
      notes: " ",
    }),
    "Calibration examples are required so Claire knows what a strong pass and false positive look like.",
  )
})

test("validateEmployerSignupForm accepts a complete role-intake form", () => {
  assert.equal(validateEmployerSignupForm(VALID_FORM), null)
})

test("buildEmployerSignupPayload normalizes the role brief without inventing scope", () => {
  assert.deepEqual(buildEmployerSignupPayload(VALID_FORM), {
    companyName: "Example Systems",
    companyLinkedin: "https://www.linkedin.com/company/example-systems",
    workEmail: "talent@example.com",
    stage: "seed",
    roleAtCompany: "Founder",
    rolesHiring: ["Founding infra engineer", "Developer platform PM"],
    contactName: "Alex Rivera",
    notes: "Must have shipped infrastructure products, can explain tradeoffs, and is SF hybrid.",
    hardFilters: ["Requires US work authorization", "SF hybrid three days per week"],
    screeningQuestions: [
      "Describe a platform tradeoff you owned",
      "What evidence proves they can handle infra ambiguity?",
    ],
    calibrationExamples:
      "Strong pass: shipped a developer platform pricing migration under real customer load.\nFalse positive: only owned internal tooling without external developer users.",
    introHandoff:
      "After a passed profile, route accepted intros to Alex for a 30-minute hiring-manager screen within two business days.",
  })
})
