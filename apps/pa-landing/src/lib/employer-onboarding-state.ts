// Employer Onboarding Wizard — client-side state (localStorage).
//
// Ported from the admin-harness wizard state
// (apps/dashboard-web/src/lib/onboarding-wizard-state.ts): identical 7-step
// milestone list, success-metric vocab, resumable persisted shape, and
// stepStatus/resolvedCount helpers. The ONLY differences from the admin port
// are (1) a customer-site storage key (so the two surfaces never collide) and
// (2) this file lives in pa-landing's lib so the customer-facing wizard owns
// its own state module. A server-state callable (`paOnboardingState`) is a
// later slice; for now the wizard is fully resumable from the browser.
//
// This file is the single source of truth for the milestone list, the
// persisted shape, and the load/save helpers so the wizard reads identical
// data everywhere.

export const WIZARD_STORAGE_KEY = "wekruit-employer-onboarding-v1"

// The 7 onboarding milestones, in order. `key` is the stable id persisted to
// localStorage; `label` is the human-facing stepper label.
export const WIZARD_STEPS = [
  { key: "welcome", label: "Welcome" },
  { key: "connect_slack", label: "Connect Slack" },
  { key: "connect_ats", label: "Connect ATS" },
  { key: "import_pool", label: "Import Pool" },
  { key: "invite_team", label: "Invite Team" },
  { key: "calibrate_req", label: "Calibrate Pilot Req" },
  { key: "launch", label: "Launch" },
] as const

export type WizardStepKey = (typeof WIZARD_STEPS)[number]["key"]

// Per-step lifecycle state. `locked` = earlier steps incomplete; `active` =
// the step the user is on; `done`/`skipped` are terminal-ish (revisitable).
export type StepStatus = "locked" | "active" | "done" | "skipped"

// The success metric captured in Step 0 (seeds the pilot scoreboard later).
export const SUCCESS_METRICS = [
  {
    value: "time_to_first_interview",
    label: "Time to first interview",
    help: "How fast a real role produces a first qualified candidate. (Recommended)",
  },
  {
    value: "qualified_candidate_rate",
    label: "Qualified-candidate rate",
    help: "Share of surfaced candidates the team considers genuinely qualified.",
  },
  {
    value: "recruiter_override_rate",
    label: "Recruiter-override rate",
    help: "How often a human overrides the agent — lower is more trust.",
  },
  {
    value: "response_rate_lift",
    label: "Response-rate lift",
    help: "Improvement in candidate response vs. your current outreach.",
  },
] as const

export type SuccessMetric = (typeof SUCCESS_METRICS)[number]["value"]

export const DEFAULT_SUCCESS_METRIC: SuccessMetric = "time_to_first_interview"

export type WizardState = {
  /** index into WIZARD_STEPS of the step currently being viewed. */
  activeStep: number
  /** per-step completion — keyed by WizardStepKey, value is done|skipped. */
  completion: Partial<Record<WizardStepKey, "done" | "skipped">>
  /** Step 0 capture. */
  successMetric: SuccessMetric
  /**
   * Step 6 sign-off result — the persisted pilot-req id (shared by
   * matching-jobs/{reqId} + pa-jobs/{reqId}). Set once the employer signs off
   * on the calibrated req; read by the Launch step to confirm it's saved.
   */
  pilotReqId?: string
  /** Role title at sign-off — shown on the Launch confirmation. */
  pilotReqTitle?: string
  /** epoch millis of the last write (for resume affordances). */
  updatedAt: number
}

export function defaultWizardState(): WizardState {
  return {
    activeStep: 0,
    completion: {},
    successMetric: DEFAULT_SUCCESS_METRIC,
    updatedAt: Date.now(),
  }
}

export function loadWizardState(): WizardState {
  if (typeof window === "undefined") return defaultWizardState()
  try {
    const raw = window.localStorage.getItem(WIZARD_STORAGE_KEY)
    if (!raw) return defaultWizardState()
    const parsed = JSON.parse(raw) as Partial<WizardState>
    return {
      ...defaultWizardState(),
      ...parsed,
      completion: parsed.completion ?? {},
    }
  } catch {
    return defaultWizardState()
  }
}

export function saveWizardState(state: WizardState): WizardState {
  const next: WizardState = { ...state, updatedAt: Date.now() }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* ignore quota / private-mode failures */
    }
  }
  return next
}

// Derive the lifecycle status of a given step index from the persisted state.
// Rule: a step is `done`/`skipped` if recorded; otherwise the lowest unrecorded
// step is `active`; steps after the active one (and not yet recorded) are
// `locked`. Welcome (index 0) is never locked.
export function stepStatus(state: WizardState, index: number): StepStatus {
  const key = WIZARD_STEPS[index].key
  const recorded = state.completion[key]
  if (recorded) return recorded
  if (index === state.activeStep) return "active"
  // first unrecorded step before the active pointer is also addressable.
  const firstOpen = WIZARD_STEPS.findIndex((s) => !state.completion[s.key])
  if (index === firstOpen) return "active"
  return index < firstOpen ? "done" : "locked"
}

export function completedCount(state: WizardState): number {
  return WIZARD_STEPS.reduce(
    (n, s) => (state.completion[s.key] === "done" ? n + 1 : n),
    0,
  )
}

export function resolvedCount(state: WizardState): number {
  // done OR skipped — used for the progress ring.
  return WIZARD_STEPS.reduce((n, s) => (state.completion[s.key] ? n + 1 : n), 0)
}

export function isSetupComplete(state: WizardState): boolean {
  return WIZARD_STEPS.every((s) => Boolean(state.completion[s.key]))
}

export function isSetupStarted(state: WizardState): boolean {
  return state.activeStep > 0 || resolvedCount(state) > 0
}
