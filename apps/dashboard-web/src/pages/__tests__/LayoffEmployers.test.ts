// @ts-nocheck - source-contract test runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "../LayoffEmployers.tsx"), "utf8")
const appSource = readFileSync(resolve(here, "../../App.tsx"), "utf8")
const sidebarSource = readFileSync(resolve(here, "../../components/console/Sidebar.tsx"), "utf8")
const overviewSource = readFileSync(resolve(here, "../Overview.tsx"), "utf8")

test("LayoffEmployers review is framed as employer role packet intake", () => {
  assert.match(source, /title="Employer role packets"/)
  assert.match(source, /candidate\.wekruit\.com \/employer role packets/)
  assert.match(source, /No employer role packets/)

  assert.doesNotMatch(source, /title="Layoff employers"/)
  assert.doesNotMatch(source, /layoff\.wekruit\.com \/employer signups/)
})

test("sidebar and home Today card share the Layoff signups name", () => {
  assert.match(sidebarSource, /to: "\/admin\/layoff-employers", label: "Layoff signups"/)
  assert.match(overviewSource, /label: "Layoff signups"/)
  assert.match(appSource, /Employer role packets/)

  assert.doesNotMatch(sidebarSource, /Role packets/)
  assert.doesNotMatch(appSource, /WeKruit Open — .*layoff\.wekruit\.com \/employer signups/)
})

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

test("LayoffEmployers review shows must-haves inside the Claire screening packet", () => {
  assert.match(source, /mustHaves\?: string/)
  assert.match(source, /Must-haves/)
  assert.match(source, /packet\.mustHaves/)
  assert.match(source, /r\.screeningPacket\?\.mustHaves/)

  assert.doesNotMatch(source, /must-haves are optional/i)
})

test("LayoffEmployers review shows the Claire screening packet before verification", () => {
  assert.match(source, /screeningPacket\?:/)
  assert.match(source, /Claire screening packet/)
  assert.match(source, /needs WeKruit review before Claire screens/)
  assert.match(source, /evidenceProbes/)
  assert.match(source, /mustHaves/)
  assert.match(source, /feedbackLoop/)
  assert.match(source, /introHandoff/)

  assert.doesNotMatch(source, /AI learns automatically/i)
  assert.doesNotMatch(source, /auto-approved/i)
})

test("LayoffEmployers approval stamps the Claire packet review status", () => {
  assert.match(source, /approved_for_claire/)
  assert.match(source, /rejected_by_wekruit/)
  assert.match(source, /const screeningPacket = row\.screeningPacket/)
  assert.match(source, /patch\.screeningPacket = screeningPacket/)
  assert.match(source, /reviewStatus: nextPacketStatus/)
  assert.match(source, /approved for Claire screening/)

  assert.doesNotMatch(source, /verificationStatus === "verified"[^]*openListLayoffCandidates/)
})
