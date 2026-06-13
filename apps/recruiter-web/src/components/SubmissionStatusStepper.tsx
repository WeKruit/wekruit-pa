/**
 * Recruiter-facing 4-step submission progress stepper.
 *
 * Pinned mapping (pa-recruiter-submissions.status):
 *   1 Submitted          — submitted / new / reviewing ("needs more info" pill
 *                          when requestedInfo[] is non-empty and status is reviewing)
 *   2 WeKruit interview  — wekruit_interview (legacy "advanced" displays here too)
 *   3 With client        — client_review
 *   4 Outcome            — hired = "Hired 🎉", rejected = "Not moving forward",
 *                          otherwise the step shows "In progress"
 *
 * Used on the role page ("Your submissions for this role") and the
 * My submissions tracker so both surfaces agree.
 */
import type {
  RecruiterSubmissionRequestedInfoEntry,
  RecruiterSubmissionStatusHistoryItem,
} from "../lib/recruiter-board-api.js"

export type SubmissionStepperOutcomeTone = "ok" | "danger" | "muted" | "pending"

export type SubmissionStepperStep = {
  id: "submitted" | "wekruit_interview" | "client_review" | "outcome"
  label: string
  state: "done" | "current" | "todo"
}

export type SubmissionStepperModel = {
  currentStep: number
  steps: SubmissionStepperStep[]
  outcome: { label: string; tone: SubmissionStepperOutcomeTone }
  terminal: boolean
  needsInfo: boolean
  needsInfoMessage: string | null
}

const STEPPER_STEPS: Array<{ id: SubmissionStepperStep["id"]; label: string }> = [
  { id: "submitted", label: "Submitted" },
  { id: "wekruit_interview", label: "WeKruit interview" },
  { id: "client_review", label: "With client" },
  { id: "outcome", label: "Outcome" },
]

const STEP_INDEX_BY_STATUS: Record<string, number> = {
  submitted: 0,
  new: 0,
  reviewing: 0,
  backburner: 0,
  wekruit_interview: 1,
  advanced: 1,
  client_review: 2,
  interviewing: 2,
  offer: 2,
  hired: 3,
  rejected: 3,
  duplicate: 3,
}

const TERMINAL_OUTCOMES: Record<string, { label: string; tone: SubmissionStepperOutcomeTone }> = {
  hired: { label: "Hired 🎉", tone: "ok" },
  rejected: { label: "Not moving forward", tone: "danger" },
  duplicate: { label: "Duplicate", tone: "muted" },
}

// Stage (0=Submitted, 1=WeKruit interview, 2=With client) each non-terminal
// status sits at. Terminal statuses have no stage of their own.
const STAGE_INDEX: Record<string, number> = {
  submitted: 0, new: 0, reviewing: 0, backburner: 0,
  wekruit_interview: 1, advanced: 1,
  client_review: 2, interviewing: 2, offer: 2,
}

export function buildSubmissionStatusStepper(
  status?: string,
  requestedInfo?: RecruiterSubmissionRequestedInfoEntry[],
  statusHistory?: RecruiterSubmissionStatusHistoryItem[],
): SubmissionStepperModel {
  const normalized = status || "submitted"
  const currentStep = STEP_INDEX_BY_STATUS[normalized] ?? 0
  const terminalOutcome = TERMINAL_OUTCOMES[normalized]
  const terminal = Boolean(terminalOutcome)
  const outcome = terminalOutcome ?? { label: "In progress", tone: "pending" as const }
  const entries = (requestedInfo ?? []).filter((entry) => Boolean(entry))
  const needsInfo = entries.length > 0 && normalized === "reviewing"
  const latestMessage = entries[entries.length - 1]?.message
  const needsInfoMessage = needsInfo && typeof latestMessage === "string" && latestMessage.trim()
    ? latestMessage.trim()
    : null

  // Furthest stage ACTUALLY reached (from history + current status). A candidate
  // rejected right after Submitted must not show checkmarks on WeKruit interview
  // / With client — stages they never reached.
  const seen = [normalized, ...(statusHistory ?? []).map((h) => h.status)]
  let reached = 0
  for (const st of seen) {
    const v = STAGE_INDEX[st ?? ""]
    if (typeof v === "number" && v > reached) reached = v
  }

  return {
    currentStep,
    terminal,
    outcome,
    needsInfo,
    needsInfoMessage,
    steps: STEPPER_STEPS.map((step, index) => {
      let state: SubmissionStepperStep["state"]
      if (index === 3) {
        state = terminal ? "current" : currentStep === 3 ? "current" : "todo"
      } else if (terminal) {
        state = index <= reached ? "done" : "todo"
      } else {
        state = index < currentStep ? "done" : index === currentStep ? "current" : "todo"
      }
      return { id: step.id, label: step.id === "outcome" ? outcome.label : step.label, state }
    }),
  }
}

export function SubmissionStatusStepper({
  status,
  requestedInfo,
  statusHistory,
}: {
  status?: string
  requestedInfo?: RecruiterSubmissionRequestedInfoEntry[]
  statusHistory?: RecruiterSubmissionStatusHistoryItem[]
}) {
  const model = buildSubmissionStatusStepper(status, requestedInfo, statusHistory)
  return (
    <div className="rb-submission-stepper" aria-label="Submission progress">
      <ol>
        {model.steps.map((step, index) => (
          <li
            key={step.id}
            className={`is-${step.state}${step.id === "outcome" ? ` is-${model.outcome.tone}` : ""}`}
            aria-current={step.state === "current" ? "step" : undefined}
          >
            <i>{index + 1}</i>
            <span>{step.label}</span>
          </li>
        ))}
      </ol>
      {model.needsInfo && (
        <p className="rb-submission-stepper__pill">
          <strong>Needs more info</strong>
          {model.needsInfoMessage && <span>{model.needsInfoMessage}</span>}
        </p>
      )}
    </div>
  )
}
