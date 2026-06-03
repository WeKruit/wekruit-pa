import type { EmployerSignupInput } from "./onboarding-api.js"

export type EmployerSignupStage =
  | "pre-seed"
  | "seed"
  | "series-a"
  | "series-b"
  | "series-c-plus"
  | "public"
  | "other"

export type EmployerSignupFormState = {
  companyName: string
  companyLinkedin: string
  workEmail: string
  contactName: string
  roleAtCompany: string
  stage: EmployerSignupStage | ""
  rolesHiring: string
  hardFilters: string
  screeningQuestions: string
  calibrationExamples: string
  feedbackLoop: string
  introHandoff: string
  notes: string
}

type EmployerPacketFields = Pick<
  EmployerSignupFormState,
  | "rolesHiring"
  | "hardFilters"
  | "screeningQuestions"
  | "calibrationExamples"
  | "feedbackLoop"
  | "introHandoff"
  | "notes"
>

export type EmployerPacketStarterId =
  | "founding_engineering"
  | "product_leadership"
  | "gtm_growth"

export type EmployerPacketStarter = {
  id: EmployerPacketStarterId
  label: string
  summary: string
  packet: EmployerPacketFields
}

export const EMPLOYER_PACKET_STARTERS: EmployerPacketStarter[] = [
  {
    id: "founding_engineering",
    label: "Founding engineering",
    summary: "Infra, platform, or full-stack roles where ownership evidence matters more than keyword match.",
    packet: {
      rolesHiring: "Founding engineer for product infrastructure; high ownership; US time zones",
      hardFilters:
        "Must have owned production systems end-to-end\nCan work in US time zones\nNo purely advisory or architecture-only background",
      screeningQuestions:
        "Walk through a production system you owned from design to launch\nWhere did the system break, and what did you change after real users hit it?\nWhat tradeoff did you personally make without a clean answer?",
      calibrationExamples:
        "Strong pass: owned a customer-facing infra migration, handled incidents, and can explain tradeoffs with metrics.\nFalse positive: contributed to a large platform but cannot identify owned decisions or failure recovery.",
      notes:
        "Probe for ownership depth, incident judgment, product sense, ambiguity tolerance, and whether the candidate can ship without a narrow spec.",
      feedbackLoop:
        "After each intro, the hiring manager sends one accept/reject reason and the evidence that changed the decision back to WeKruit.",
      introHandoff:
        "Accepted intros go to the hiring manager for a technical ownership screen within two business days.",
    },
  },
  {
    id: "product_leadership",
    label: "Product leadership",
    summary: "PM or product lead roles where Claire needs market, execution, and decision evidence.",
    packet: {
      rolesHiring: "Product lead for a developer or workflow product; owns roadmap, launch quality, and customer signal",
      hardFilters:
        "Must have shipped a product used by external customers\nMust show direct customer discovery or sales/user feedback loops\nNo purely program-management background",
      screeningQuestions:
        "Describe a product bet you made with incomplete information\nWhat customer evidence changed the roadmap?\nHow did you decide what not to build?",
      calibrationExamples:
        "Strong pass: can tie customer evidence, product tradeoffs, launch outcomes, and follow-up decisions together.\nFalse positive: lists launches but cannot show decision ownership or customer evidence.",
      notes:
        "Probe for product judgment, customer evidence, roadmap tradeoffs, launch accountability, and ability to challenge vague stakeholder requests.",
      feedbackLoop:
        "After each candidate intro, the product/hiring owner posts the pass/no-pass reason and one calibration correction in the WeKruit thread.",
      introHandoff:
        "Accepted intros move to a product case or hiring-manager screen owned by the product lead within two business days.",
    },
  },
  {
    id: "gtm_growth",
    label: "GTM growth",
    summary: "Sales, growth, or partnerships roles where pipeline proof and customer motion are the screen.",
    packet: {
      rolesHiring: "GTM growth lead for a sales-led B2B product; owns pipeline creation and conversion learning loops",
      hardFilters:
        "Must have owned measurable pipeline or revenue motion\nMust be comfortable with founder-led or early sales-led environments\nNo purely brand or comms-only background",
      screeningQuestions:
        "Describe the pipeline motion you built or changed\nWhich customer segment did you stop pursuing, and why?\nWhat metric proved the motion was working?",
      calibrationExamples:
        "Strong pass: can explain target segment, channel, conversion metric, learning loop, and owned pipeline impact.\nFalse positive: talks about campaigns but cannot connect work to qualified pipeline or revenue learning.",
      notes:
        "Probe for pipeline ownership, customer segmentation, conversion evidence, founder-market learning, and comfort operating without mature sales ops.",
      feedbackLoop:
        "After every accepted or rejected intro, the GTM owner sends one reason and one correction signal so Claire tightens the next pass boundary.",
      introHandoff:
        "Accepted intros route to the GTM owner for a first business screen within two business days.",
    },
  },
]

export function applyEmployerPacketStarter(
  form: EmployerSignupFormState,
  starterId: EmployerPacketStarterId,
): EmployerSignupFormState {
  const starter = EMPLOYER_PACKET_STARTERS.find((s) => s.id === starterId)
  if (!starter) throw new Error(`unknown_employer_packet_starter:${starterId}`)
  return {
    ...form,
    ...starter.packet,
  }
}

export function splitRoleBriefs(rolesHiring: string): string[] {
  return rolesHiring
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function validateEmployerSignupForm(form: EmployerSignupFormState): string | null {
  if (!form.companyName.trim() || !form.workEmail.trim() || !form.contactName.trim()) {
    return "Company name, your name, and work email are required."
  }
  if (!form.workEmail.includes("@")) {
    return "That doesn't look like a valid email."
  }
  if (splitRoleBriefs(form.rolesHiring).length === 0) {
    return "Primary role brief is required before Claire can screen candidates."
  }
  if (splitRoleBriefs(form.hardFilters).length === 0) {
    return "Hard filters are required so Claire knows what must stop a pass."
  }
  if (splitRoleBriefs(form.screeningQuestions).length === 0) {
    return "Screening questions are required so Claire knows what evidence to elicit."
  }
  if (!form.calibrationExamples.trim()) {
    return "Calibration examples are required so Claire knows what a strong pass and false positive look like."
  }
  if (!form.notes.trim()) {
    return "Must-haves are required so Claire can probe the right evidence."
  }
  if (!form.feedbackLoop.trim()) {
    return "Feedback loop is required so Claire's pass/no-pass signal can improve after every intro."
  }
  if (!form.introHandoff.trim()) {
    return "Intro handoff is required so passed candidates have a real next step."
  }
  return null
}

export function buildEmployerSignupPayload(form: EmployerSignupFormState): EmployerSignupInput {
  return {
    companyName: form.companyName.trim(),
    companyLinkedin: form.companyLinkedin.trim(),
    workEmail: form.workEmail.trim().toLowerCase(),
    stage: form.stage || "other",
    roleAtCompany: form.roleAtCompany.trim(),
    rolesHiring: splitRoleBriefs(form.rolesHiring),
    contactName: form.contactName.trim(),
    notes: form.notes.trim(),
    hardFilters: splitRoleBriefs(form.hardFilters),
    screeningQuestions: splitRoleBriefs(form.screeningQuestions),
    calibrationExamples: form.calibrationExamples.trim(),
    feedbackLoop: form.feedbackLoop.trim(),
    introHandoff: form.introHandoff.trim(),
  }
}
