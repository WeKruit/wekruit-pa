/**
 * EvalLabelForm — pure-logic mapping + closed-vocab tests.
 *
 * The repo has no DOM harness and the form transitively imports
 * `lib/firebase.ts` (touches `import.meta.env.VITE_*`, which crashes Node's
 * `--test` loader — see BatchNew.test.tsx for the same constraint). So, per the
 * established pattern, the testable logic lives in `EvalLabelForm.helpers.ts`
 * (firebase-free) and we assert it directly: decision→status, rationale-required,
 * corrected-outcome construction, and that the error-category vocab is sourced
 * from the canonical `@pa/core-types` schema (all 9 closed values, labelled).
 *
 * Run via:
 *   node --import tsx --test apps/dashboard-web/src/pages/__tests__/EvalLabelForm.test.ts
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { EvaluationErrorCategorySchema } from "@pa/core-types"

import {
  ERROR_CATEGORY_LABEL,
  ERROR_CATEGORY_OPTIONS,
  LABEL_DECISIONS,
  buildCorrectedOutcome,
  labelDecisionToStatus,
  labelFormIsSubmittable,
  labelRequiresRationale,
  labelValidationError,
  prescreenTerminalToOutcomeKind,
} from "../../components/prescreen/EvalLabelForm.helpers.js"

describe("labelDecisionToStatus", () => {
  it("agree -> approved", () => {
    assert.equal(labelDecisionToStatus("agree"), "approved")
  })
  it("partial -> overridden", () => {
    assert.equal(labelDecisionToStatus("partial"), "overridden")
  })
  it("disagree -> overridden", () => {
    assert.equal(labelDecisionToStatus("disagree"), "overridden")
  })
})

describe("labelRequiresRationale", () => {
  it("agree does not require rationale", () => {
    assert.equal(labelRequiresRationale("agree"), false)
  })
  it("partial requires rationale", () => {
    assert.equal(labelRequiresRationale("partial"), true)
  })
  it("disagree requires rationale", () => {
    assert.equal(labelRequiresRationale("disagree"), true)
  })
})

describe("labelFormIsSubmittable + labelValidationError", () => {
  it("agree is always submittable with empty rationale", () => {
    assert.equal(labelFormIsSubmittable({ decision: "agree", rationale: "" }), true)
    assert.equal(labelValidationError({ decision: "agree", rationale: "" }), null)
  })
  it("disagree with empty rationale is NOT submittable", () => {
    assert.equal(labelFormIsSubmittable({ decision: "disagree", rationale: "   " }), false)
    assert.ok(labelValidationError({ decision: "disagree", rationale: "   " })?.includes("rationale"))
  })
  it("disagree with a rationale is submittable", () => {
    assert.equal(labelFormIsSubmittable({ decision: "disagree", rationale: "AI missed the Tesla SWE role" }), true)
    assert.equal(labelValidationError({ decision: "disagree", rationale: "AI missed the Tesla SWE role" }), null)
  })
})

describe("prescreenTerminalToOutcomeKind", () => {
  it("PASS -> pass", () => {
    assert.equal(prescreenTerminalToOutcomeKind("PASS"), "pass")
  })
  it("FAIL -> reject", () => {
    assert.equal(prescreenTerminalToOutcomeKind("FAIL"), "reject")
  })
  it("HARD_STOP -> reject", () => {
    assert.equal(prescreenTerminalToOutcomeKind("HARD_STOP"), "reject")
  })
})

describe("buildCorrectedOutcome", () => {
  it("agree -> no corrected outcome", () => {
    assert.equal(buildCorrectedOutcome({ decision: "agree", correctedTerminal: "PASS" }), undefined)
  })
  it("disagree -> corrected outcome with kind + prescreenTerminal", () => {
    assert.deepEqual(buildCorrectedOutcome({ decision: "disagree", correctedTerminal: "PASS" }), {
      kind: "pass",
      prescreenTerminal: "PASS",
    })
  })
  it("partial with FAIL -> reject", () => {
    assert.deepEqual(buildCorrectedOutcome({ decision: "partial", correctedTerminal: "FAIL" }), {
      kind: "reject",
      prescreenTerminal: "FAIL",
    })
  })
  it("disagree with no corrected terminal -> undefined", () => {
    assert.equal(buildCorrectedOutcome({ decision: "disagree", correctedTerminal: null }), undefined)
  })
})

describe("error-category closed vocab (sourced from @pa/core-types, not hardcoded)", () => {
  it("ERROR_CATEGORY_OPTIONS mirrors the canonical schema enum (all 9 values)", () => {
    assert.equal(ERROR_CATEGORY_OPTIONS.length, 9)
    assert.deepEqual([...ERROR_CATEGORY_OPTIONS], [...EvaluationErrorCategorySchema.options])
  })

  it("every closed category has a human label", () => {
    for (const cat of ERROR_CATEGORY_OPTIONS) {
      assert.ok(ERROR_CATEGORY_LABEL[cat], `missing label for ${cat}`)
    }
    assert.equal(ERROR_CATEGORY_LABEL.missed_evidence, "Missed evidence")
    assert.equal(ERROR_CATEGORY_LABEL.rubric_mismatch, "Rubric mismatch")
  })

  it("decision segments cover agree/partial/disagree, agree first", () => {
    assert.deepEqual(LABEL_DECISIONS.map((d) => d.value), ["agree", "partial", "disagree"])
    assert.equal(LABEL_DECISIONS[0]?.hint, "A")
    assert.equal(LABEL_DECISIONS[2]?.hint, "D")
  })
})
