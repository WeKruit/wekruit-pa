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

test("EmployerSignup captures the hiring-team feedback loop before Claire screens", () => {
  assert.match(source, /Feedback loop \*/)
  assert.match(source, /pass\/no-pass signal/i)
  assert.match(source, /one correction signal/i)
  assert.match(source, /feedbackLoop/)

  assert.doesNotMatch(source, /Feedback loop \(optional\)/i)
  assert.doesNotMatch(source, /Claire will infer the feedback/i)
  assert.doesNotMatch(source, /AI learns automatically/i)
})

test("EmployerSignup shows a role packet readiness checklist before the long form", () => {
  assert.match(source, /EmployerPacketReadiness/)
  assert.match(source, /deriveEmployerSignupReadiness/)
  assert.match(source, /aria-label="Role packet readiness"/)
  assert.match(source, /Before Claire screens/)
  assert.match(source, /Role packet/)
  assert.match(source, /Complete these before WeKruit approves the role brief/i)
})

test("EmployerSignup turns role packet readiness into actionable field jumps", () => {
  assert.match(source, /summary\.nextIncompleteItem/)
  assert.match(source, /Next needed/)
  assert.match(source, /Jump to field/)
  assert.match(source, /href=\{`#\$\{summary\.nextIncompleteItem\.targetId\}`\}/)
  assert.match(source, /href=\{`#\$\{item\.targetId\}`\}/)
  assert.match(source, /id="employer-primary-role-brief"/)
  assert.match(source, /id="employer-hard-filters"/)
  assert.match(source, /id="employer-screening-questions"/)
  assert.match(source, /id="employer-calibration-examples"/)
  assert.match(source, /id="employer-must-haves"/)
  assert.match(source, /id="employer-feedback-loop"/)
  assert.match(source, /id="employer-intro-handoff"/)
})

test("EmployerSignup explains the post-submit calibration loop before the form", () => {
  assert.match(source, /EmployerCalibrationLoop/)
  assert.match(source, /aria-label="Role calibration loop"/)
  assert.match(source, /After you send the packet/)
  assert.match(source, /Review the role packet/)
  assert.match(source, /Screen with Claire/)
  assert.match(source, /Return hiring-team signal/)
  assert.match(source, /accepted or rejected intro feeds one correction back into Claire/)
  assert.match(source, /No candidate is shared until they pass the role screen and consent/)

  assert.doesNotMatch(source, /instant candidate matches/i)
  assert.doesNotMatch(source, /automatic submissions/i)
  assert.doesNotMatch(source, /browse all candidates/i)
})

test("EmployerSignup offers editable packet starters instead of a blank long-form only path", () => {
  assert.match(source, /EmployerPacketStarters/)
  assert.match(source, /EMPLOYER_PACKET_STARTERS/)
  assert.match(source, /applyEmployerPacketStarter/)
  assert.match(source, /Use as editable structure/)
  assert.match(source, /starter\.label/)
  assert.match(source, /starter\.summary/)
  assert.match(source, /onApply\(starter\.id\)/)

  assert.doesNotMatch(source, /autofill.*company/i)
  assert.doesNotMatch(source, /one-click candidate/i)
  assert.doesNotMatch(source, /instant candidate matches/i)
})

test("EmployerSignup renders the live Claire packet contract before submit", () => {
  assert.match(source, /deriveEmployerPacketPreview/)
  assert.match(source, /EmployerPacketPreview/)
  assert.match(source, /aria-label="Live Claire packet preview"/)
  assert.match(source, /Claire screening contract/)
  assert.match(source, /What WeKruit reviews/)
  assert.match(source, /preview\.sections\.map/)
  assert.match(source, /section\.complete/)

  assert.doesNotMatch(source, /preview is optional/i)
  assert.doesNotMatch(source, /instant candidate matches/i)
})

test("EmployerSignup post-submit state becomes a role packet receipt", () => {
  assert.match(source, /<SuccessCard form=\{form\} onStartAnother=\{\(\) => \{/)
  assert.match(source, /setForm\(EMPTY_FORM\)/)
  assert.match(source, /setDone\(false\)/)
  assert.match(source, /function SuccessCard\(\{ form, onStartAnother \}: \{ form: EmployerSignupFormState; onStartAnother: \(\) => void \}\)/)
  assert.match(source, /const preview = deriveEmployerPacketPreview\(form\)/)
  assert.match(source, /Role packet received/)
  assert.match(source, /Submitted packet/)
  assert.match(source, /What happens next/)
  assert.match(source, /preview\.sections\.map/)
  assert.match(source, /WeKruit reviews the submitted packet before Claire screens/)
  assert.match(source, /Claire screens only after the role packet is approved/)
  assert.match(source, /Every accepted or rejected intro returns one calibration signal/)
  assert.match(source, /onClick=\{onStartAnother\}[\s\S]*Send another role/)
  assert.match(source, /href="mailto:hello@wekruit.com"[\s\S]*Email WeKruit/)

  assert.doesNotMatch(source, /Back to home/)
  assert.doesNotMatch(source, /instant candidate matches/i)
  assert.doesNotMatch(source, /browse candidates/i)
})
