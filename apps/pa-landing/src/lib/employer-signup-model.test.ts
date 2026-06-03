// @ts-nocheck - source-contract model test runs with node --test via tsx.
import assert from "node:assert/strict"
import test from "node:test"

import {
  EMPLOYER_PACKET_STARTERS,
  applyEmployerPacketStarter,
  buildEmployerSignupPayload,
  deriveEmployerPacketPreview,
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
  feedbackLoop:
    "After every accepted or rejected intro, Alex posts the pass/no-pass reason and one correction signal in the WeKruit thread.",
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

test("validateEmployerSignupForm requires the hiring-team feedback loop before Claire screens", () => {
  assert.equal(
    validateEmployerSignupForm({ ...VALID_FORM, feedbackLoop: " " }),
    "Feedback loop is required so Claire's pass/no-pass signal can improve after every intro.",
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
      feedbackLoop: " ",
    }),
    "Hard filters are required so Claire knows what must stop a pass.",
  )

  assert.equal(
    validateEmployerSignupForm({
      ...VALID_FORM,
      calibrationExamples: " ",
      notes: " ",
      feedbackLoop: " ",
    }),
    "Calibration examples are required so Claire knows what a strong pass and false positive look like.",
  )

  assert.equal(
    validateEmployerSignupForm({
      ...VALID_FORM,
      feedbackLoop: " ",
      introHandoff: " ",
    }),
    "Feedback loop is required so Claire's pass/no-pass signal can improve after every intro.",
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
    feedbackLoop:
      "After every accepted or rejected intro, Alex posts the pass/no-pass reason and one correction signal in the WeKruit thread.",
    introHandoff:
      "After a passed profile, route accepted intros to Alex for a 30-minute hiring-manager screen within two business days.",
  })
})

test("deriveEmployerPacketPreview mirrors the Claire screening packet contract", () => {
  const preview = deriveEmployerPacketPreview(VALID_FORM)

  assert.equal(preview.completedCount, 6)
  assert.equal(preview.totalCount, 6)
  assert.equal(preview.ready, true)
  assert.deepEqual(
    preview.sections.map((section) => [section.id, section.label, section.complete]),
    [
      ["role_brief", "Role brief", true],
      ["hard_filters", "Hard-stop filters", true],
      ["evidence_probes", "Evidence probes", true],
      ["calibration", "Strong-pass calibration", true],
      ["feedback_loop", "Feedback loop", true],
      ["intro_handoff", "Intro handoff", true],
    ],
  )
  assert.match(preview.sections[0]!.value, /Founding infra engineer/)
  assert.match(preview.sections[1]!.value, /Requires US work authorization/)
  assert.match(preview.sections[2]!.value, /platform tradeoff/)
  assert.match(preview.sections[3]!.value, /False positive/)
})

test("deriveEmployerPacketPreview keeps missing packet sections explicit", () => {
  const preview = deriveEmployerPacketPreview({
    ...VALID_FORM,
    hardFilters: "",
    feedbackLoop: "",
    introHandoff: "",
  })

  assert.equal(preview.completedCount, 3)
  assert.equal(preview.ready, false)
  assert.deepEqual(
    preview.sections.map((section) => [section.id, section.complete, section.value]),
    [
      ["role_brief", true, "Founding infra engineer\nDeveloper platform PM"],
      ["hard_filters", false, "Missing hard-stop filters"],
      ["evidence_probes", true, "Describe a platform tradeoff you owned\nWhat evidence proves they can handle infra ambiguity?"],
      ["calibration", true, VALID_FORM.calibrationExamples],
      ["feedback_loop", false, "Missing feedback loop"],
      ["intro_handoff", false, "Missing intro handoff"],
    ],
  )
})

test("EMPLOYER_PACKET_STARTERS expose editable Claire packet starters only", () => {
  assert.deepEqual(
    EMPLOYER_PACKET_STARTERS.map((starter) => [starter.id, starter.label]),
    [
      ["founding_engineering", "Founding engineering"],
      ["product_leadership", "Product leadership"],
      ["gtm_growth", "GTM growth"],
    ],
  )

  for (const starter of EMPLOYER_PACKET_STARTERS) {
    assert.equal(typeof starter.label, "string")
    assert.equal(starter.packet.rolesHiring.trim().length > 0, true)
    assert.equal(starter.packet.hardFilters.trim().length > 0, true)
    assert.equal(starter.packet.screeningQuestions.trim().length > 0, true)
    assert.equal(starter.packet.calibrationExamples.trim().length > 0, true)
    assert.equal(starter.packet.notes.trim().length > 0, true)
    assert.equal(starter.packet.feedbackLoop.trim().length > 0, true)
    assert.equal(starter.packet.introHandoff.trim().length > 0, true)
    assert.equal("companyName" in starter.packet, false)
    assert.equal("workEmail" in starter.packet, false)
    assert.equal("contactName" in starter.packet, false)
  }
})

test("applyEmployerPacketStarter fills the screening packet without overwriting employer identity", () => {
  const draft: EmployerSignupFormState = {
    companyName: "Operator Labs",
    companyLinkedin: "https://www.linkedin.com/company/operator-labs",
    workEmail: "Hiring@OperatorLabs.com",
    contactName: "Maya Chen",
    roleAtCompany: "VP Talent",
    stage: "series-a",
    rolesHiring: "",
    notes: "",
    hardFilters: "",
    screeningQuestions: "",
    calibrationExamples: "",
    feedbackLoop: "",
    introHandoff: "",
  }

  const filled = applyEmployerPacketStarter(draft, "gtm_growth")

  assert.equal(filled.companyName, draft.companyName)
  assert.equal(filled.companyLinkedin, draft.companyLinkedin)
  assert.equal(filled.workEmail, draft.workEmail)
  assert.equal(filled.contactName, draft.contactName)
  assert.equal(filled.roleAtCompany, draft.roleAtCompany)
  assert.equal(filled.stage, draft.stage)
  assert.match(filled.rolesHiring, /GTM/)
  assert.match(filled.hardFilters, /sales-led/)
  assert.match(filled.screeningQuestions, /pipeline/)
  assert.equal(validateEmployerSignupForm(filled), null)
})
