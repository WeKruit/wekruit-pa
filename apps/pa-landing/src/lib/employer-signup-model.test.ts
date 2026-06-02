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
  })
})
