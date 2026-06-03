// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import test from "node:test"

import { getCandidateJobStatusDisplay } from "./candidate-job-status.js"

test("getCandidateJobStatusDisplay returns concise candidate-facing status copy", () => {
  assert.deepEqual(getCandidateJobStatusDisplay("invited", "Frontend Engineer"), {
    label: "Invited",
    nextStep: "Claire is ready to run the first interview for this role.",
    tone: "active",
    ctaLabel: "Start interview",
  })

  assert.deepEqual(getCandidateJobStatusDisplay("interview_started"), {
    label: "Interview started",
    nextStep: "Continue in iMessage when you are ready to finish the first interview.",
    tone: "active",
    ctaLabel: "Continue interview",
  })
})

test("getCandidateJobStatusDisplay keeps pass copy consent-safe", () => {
  const display = getCandidateJobStatusDisplay("passed", "Frontend Engineer")

  assert.equal(display.label, "Passed")
  assert.equal(display.tone, "positive")
  assert.doesNotMatch(display.nextStep, /employer|shared|sent|visible/i)
})

test("getCandidateJobStatusDisplay renders review-pending as WeKruit-side review", () => {
  const display = getCandidateJobStatusDisplay("review_pending", "Frontend Engineer")

  assert.equal(display.label, "Reviewing")
  assert.equal(display.tone, "active")
  assert.match(display.nextStep, /WeKruit is reviewing/i)
  assert.doesNotMatch(display.nextStep, /passed|not a fit|employer|shared|sent|visible/i)
})

test("getCandidateJobStatusDisplay keeps not-pass role-specific and global-pool safe", () => {
  const display = getCandidateJobStatusDisplay("not_passed", "Product Designer")

  assert.equal(display.label, "Not passed")
  assert.match(display.nextStep, /Product Designer/)
  assert.match(display.nextStep, /profile stays active/)
  assert.doesNotMatch(display.nextStep, /rejected|removed|closed/i)
})

test("getCandidateJobStatusDisplay renders employer intro outcomes without exposing private feedback", () => {
  const accepted = getCandidateJobStatusDisplay("intro_accepted", "Founding Engineer")
  const rejected = getCandidateJobStatusDisplay("intro_rejected", "Product Designer")

  assert.deepEqual(accepted, {
    label: "Intro accepted",
    nextStep: "The hiring team accepted the passed-profile intro. WeKruit will coordinate the next real step.",
    tone: "positive",
    ctaLabel: "View role",
  })
  assert.equal(rejected.label, "Intro closed")
  assert.match(rejected.nextStep, /did not move this intro forward/i)
  assert.match(rejected.nextStep, /profile stays active/i)
  assert.doesNotMatch(rejected.nextStep, /rejected|private feedback|reason/i)
})
