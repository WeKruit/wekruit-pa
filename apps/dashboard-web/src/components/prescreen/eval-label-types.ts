/**
 * Single import surface for the eval-labeling types. Everything is sourced from
 * `@pa/core-types` (the canonical closed vocab + schemas) — this module only
 * re-exports so the helpers (pure, node-test-able) and the React form agree on
 * exactly one set of types. Do NOT redeclare these enums here; import-only.
 */
export type {
  EvaluationLabelDecision,
  EvaluationErrorCategory,
  EvaluationQualityRating,
  EvaluationOutcome,
  EvaluationOutcomeKind,
  HumanEvalLabel,
} from "@pa/core-types"

/** The three prescreen terminals an operator can attach as a corrected outcome. */
export type ReviewTerminal = "PASS" | "FAIL" | "HARD_STOP"
