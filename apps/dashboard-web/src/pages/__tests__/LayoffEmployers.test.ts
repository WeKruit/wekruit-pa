// @ts-nocheck - source-contract test runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "../LayoffEmployers.tsx"), "utf8")

test("LayoffEmployers review shows hard filters separately from notes", () => {
  assert.match(source, /hardFilters\?: string\[\]/)
  assert.match(source, /Hard filters/)
  assert.match(source, /r\.hardFilters/)
  assert.match(source, /Notes/)

  assert.doesNotMatch(source, /hard filters are optional/i)
})

test("LayoffEmployers review shows screening questions separately from notes", () => {
  assert.match(source, /screeningQuestions\?: string\[\]/)
  assert.match(source, /Screening questions/)
  assert.match(source, /r\.screeningQuestions/)
  assert.match(source, /Notes/)

  assert.doesNotMatch(source, /screening questions are optional/i)
})

test("LayoffEmployers review shows calibration examples separately from notes", () => {
  assert.match(source, /calibrationExamples\?: string/)
  assert.match(source, /Calibration examples/)
  assert.match(source, /r\.calibrationExamples/)
  assert.match(source, /Notes/)

  assert.doesNotMatch(source, /calibration examples are optional/i)
})

test("LayoffEmployers review shows intro handoff separately from notes", () => {
  assert.match(source, /introHandoff\?: string/)
  assert.match(source, /Intro handoff/)
  assert.match(source, /r\.introHandoff/)
  assert.match(source, /Notes/)

  assert.doesNotMatch(source, /intro handoff is optional/i)
})

test("LayoffEmployers review shows feedback loop separately from notes", () => {
  assert.match(source, /feedbackLoop\?: string/)
  assert.match(source, /Feedback loop/)
  assert.match(source, /r\.feedbackLoop/)
  assert.match(source, /Notes/)

  assert.doesNotMatch(source, /feedback loop is optional/i)
  assert.doesNotMatch(source, /AI learns automatically/i)
})
