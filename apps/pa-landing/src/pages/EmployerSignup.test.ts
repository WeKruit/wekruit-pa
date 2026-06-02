// @ts-nocheck - this source-contract test runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "EmployerSignup.tsx"), "utf8")

test("EmployerSignup is framed as passed-profile role intake, not a layoff list signup", () => {
  assert.doesNotMatch(source, /warm intros/i)
  assert.doesNotMatch(source, /recently-laid-off operators/i)
  assert.doesNotMatch(source, /No marketplace logins, no portals/i)
  assert.doesNotMatch(source, /hand-pick from a small verified list/i)
  assert.doesNotMatch(source, /Send signup/)
  assert.doesNotMatch(source, /A quiet list for people between things/i)
  assert.doesNotMatch(source, /WeKruit Open/)

  assert.match(source, /passed-profile role intake/i)
  assert.match(source, /Send role brief/)
  assert.match(source, /Primary role brief/)
  assert.match(source, /Must-haves/)
  assert.match(source, /Claire screens/)
  assert.match(source, /passed profiles/)
})

test("EmployerSignup role-intake examples do not borrow real company product names", () => {
  assert.doesNotMatch(source, /Claude APIs/)
  assert.match(source, /developer platform/)
  assert.match(source, /must-haves Claire should probe/)
})

test("EmployerSignup captures hard filters as a first-class screening constraint", () => {
  assert.match(source, /Hard filters \*/)
  assert.match(source, /what must stop a pass/i)
  assert.match(source, /US work authorization/)
  assert.match(source, /hardFilters/)

  assert.doesNotMatch(source, /Hard filters \(optional\)/i)
  assert.doesNotMatch(source, /AI learns automatically/i)
})

test("EmployerSignup captures evidence probes as a first-class Claire interview input", () => {
  assert.match(source, /Screening questions \*/)
  assert.match(source, /evidence Claire should elicit/i)
  assert.match(source, /platform tradeoff/i)
  assert.match(source, /screeningQuestions/)

  assert.doesNotMatch(source, /Screening questions \(optional\)/i)
  assert.doesNotMatch(source, /Claire will infer the questions/i)
})

test("EmployerSignup captures calibration examples before Claire screens", () => {
  assert.match(source, /Calibration examples \*/)
  assert.match(source, /strong pass and false positive/i)
  assert.match(source, /developer platform pricing migration/i)
  assert.match(source, /calibrationExamples/)

  assert.doesNotMatch(source, /Calibration examples \(optional\)/i)
  assert.doesNotMatch(source, /Claire will infer the calibration/i)
})

test("EmployerSignup captures the post-pass intro handoff before Claire screens", () => {
  assert.match(source, /Intro handoff \*/)
  assert.match(source, /accepted intro/i)
  assert.match(source, /real next step/i)
  assert.match(source, /introHandoff/)

  assert.doesNotMatch(source, /Intro handoff \(optional\)/i)
  assert.doesNotMatch(source, /WeKruit will figure out the next step/i)
  assert.doesNotMatch(source, /Schedule intro/i)
})
