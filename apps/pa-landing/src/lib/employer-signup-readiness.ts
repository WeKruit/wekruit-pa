import {
  splitRoleBriefs,
  type EmployerSignupFormState,
} from "./employer-signup-model.js"

export type EmployerSignupReadinessItemId =
  | "role_brief"
  | "hard_filters"
  | "evidence_probes"
  | "calibration"
  | "must_haves"
  | "feedback_loop"
  | "intro_handoff"

export type EmployerSignupReadinessItem = {
  id: EmployerSignupReadinessItemId
  label: string
  description: string
  targetId: string
  complete: boolean
}

export type EmployerSignupReadinessSummary = {
  items: EmployerSignupReadinessItem[]
  completedCount: number
  totalCount: number
  ready: boolean
  nextIncompleteItem: EmployerSignupReadinessItem | null
}

function hasText(value: string) {
  return value.trim().length > 0
}

function hasBrief(value: string) {
  return splitRoleBriefs(value).length > 0
}

export function deriveEmployerSignupReadiness(
  form: EmployerSignupFormState,
): EmployerSignupReadinessSummary {
  const items: EmployerSignupReadinessItem[] = [
    {
      id: "role_brief",
      label: "Role brief",
      description: "The one role Claire should screen against first.",
      targetId: "employer-primary-role-brief",
      complete: hasBrief(form.rolesHiring),
    },
    {
      id: "hard_filters",
      label: "Hard filters",
      description: "Constraints that must stop a pass before screening.",
      targetId: "employer-hard-filters",
      complete: hasBrief(form.hardFilters),
    },
    {
      id: "evidence_probes",
      label: "Evidence probes",
      description: "Interview prompts Claire should use to test the signal.",
      targetId: "employer-screening-questions",
      complete: hasBrief(form.screeningQuestions),
    },
    {
      id: "calibration",
      label: "Calibration",
      description: "Strong pass and false positive examples.",
      targetId: "employer-calibration-examples",
      complete: hasText(form.calibrationExamples),
    },
    {
      id: "must_haves",
      label: "Must-haves",
      description: "The evidence Claire should not miss.",
      targetId: "employer-must-haves",
      complete: hasText(form.notes),
    },
    {
      id: "feedback_loop",
      label: "Feedback loop",
      description: "Where pass/no-pass correction signal returns.",
      targetId: "employer-feedback-loop",
      complete: hasText(form.feedbackLoop),
    },
    {
      id: "intro_handoff",
      label: "Intro handoff",
      description: "The accepted-intro owner and next step.",
      targetId: "employer-intro-handoff",
      complete: hasText(form.introHandoff),
    },
  ]
  const completedCount = items.filter((item) => item.complete).length
  const nextIncompleteItem = items.find((item) => !item.complete) ?? null

  return {
    items,
    completedCount,
    totalCount: items.length,
    ready: completedCount === items.length,
    nextIncompleteItem,
  }
}
