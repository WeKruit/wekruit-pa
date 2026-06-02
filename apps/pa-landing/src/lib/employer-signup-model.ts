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
  introHandoff: string
  notes: string
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
  if (!form.notes.trim()) {
    return "Must-haves are required so Claire can probe the right evidence."
  }
  if (splitRoleBriefs(form.hardFilters).length === 0) {
    return "Hard filters are required so Claire knows what must stop a pass."
  }
  if (splitRoleBriefs(form.screeningQuestions).length === 0) {
    return "Screening questions are required so Claire knows what evidence to elicit."
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
    introHandoff: form.introHandoff.trim(),
  }
}
