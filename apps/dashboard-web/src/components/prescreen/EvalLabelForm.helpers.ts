/**
 * Pure mapping helpers for the data-labeling form. Kept out of the React
 * component so they can be unit-tested with `node --test` (no DOM harness)
 * and reused by P3 (recruiter + external-supply labeling surfaces).
 *
 * These encode the locked contract:
 *  - decision "agree"            -> review status "approved"  (no rationale required)
 *  - decision "partial"|"disagree" -> review status "overridden" (rationale REQUIRED)
 *
 * The callable (`paReviewEvaluationAttempt`) ALSO enforces the rationale rule
 * server-side; this helper lets the UI block + message before the round-trip.
 */
import { EvaluationErrorCategorySchema } from "@pa/core-types"
import type {
  EvaluationErrorCategory,
  EvaluationLabelDecision,
  EvaluationOutcome,
  EvaluationOutcomeKind,
  EvaluationQualityRating,
  ReviewTerminal,
} from "./eval-label-types.js"

export type ReviewLabelStatus = "approved" | "overridden"

/** The 9 closed error-category values — sourced from the canonical schema (never hardcoded). */
export const ERROR_CATEGORY_OPTIONS = EvaluationErrorCategorySchema.options as readonly EvaluationErrorCategory[]

/** Human label for each closed error category. Keys are pinned to the schema enum. */
export const ERROR_CATEGORY_LABEL: Record<EvaluationErrorCategory, string> = {
  missed_evidence: "Missed evidence",
  hallucinated_evidence: "Hallucinated evidence",
  wrong_weight: "Wrong weight",
  over_strict: "Over-strict",
  over_lenient: "Over-lenient",
  misread_transcript: "Misread transcript",
  profile_ignored: "Profile ignored",
  rubric_mismatch: "Rubric mismatch",
  other: "Other",
}

/** The decision segments shown in the form, with optional hotkey hint. */
export const LABEL_DECISIONS: readonly { value: EvaluationLabelDecision; label: string; hint: string }[] = [
  { value: "agree", label: "Agree", hint: "A" },
  { value: "partial", label: "Partial", hint: "" },
  { value: "disagree", label: "Disagree", hint: "D" },
]

/** The 1..5 quality values. */
export const QUALITY_VALUES: readonly EvaluationQualityRating[] = [1, 2, 3, 4, 5]

/** decision -> the human-review status the callable should record. */
export function labelDecisionToStatus(decision: EvaluationLabelDecision): ReviewLabelStatus {
  return decision === "agree" ? "approved" : "overridden"
}

/** A free-text rationale is mandatory whenever the labeler diverges from the AI. */
export function labelRequiresRationale(decision: EvaluationLabelDecision): boolean {
  return decision !== "agree"
}

/**
 * Whether the label form is submittable for the given decision + rationale.
 * Mirrors the callable's guard so the operator sees the block locally.
 */
export function labelFormIsSubmittable(input: {
  decision: EvaluationLabelDecision
  rationale: string
}): boolean {
  if (labelRequiresRationale(input.decision)) return input.rationale.trim().length > 0
  return true
}

/** Validation message for a non-submittable label, or null when it is valid. */
export function labelValidationError(input: {
  decision: EvaluationLabelDecision
  rationale: string
}): string | null {
  if (labelRequiresRationale(input.decision) && input.rationale.trim().length === 0) {
    return "A rationale is required when you do not fully agree with the AI evaluation."
  }
  return null
}

/** Map a prescreen terminal to the coarse evaluation outcome kind (PASS -> pass, else reject). */
export function prescreenTerminalToOutcomeKind(terminal: ReviewTerminal): EvaluationOutcomeKind {
  return terminal === "PASS" ? "pass" : "reject"
}

/**
 * Build the corrected `EvaluationOutcome` to attach to the label, given the
 * decision + the human's chosen corrected terminal. On "agree" we return
 * undefined (the human did not diverge, so there is nothing to correct).
 */
export function buildCorrectedOutcome(input: {
  decision: EvaluationLabelDecision
  correctedTerminal: ReviewTerminal | null
}): EvaluationOutcome | undefined {
  if (input.decision === "agree") return undefined
  if (!input.correctedTerminal) return undefined
  return {
    kind: prescreenTerminalToOutcomeKind(input.correctedTerminal),
    prescreenTerminal: input.correctedTerminal,
  }
}
