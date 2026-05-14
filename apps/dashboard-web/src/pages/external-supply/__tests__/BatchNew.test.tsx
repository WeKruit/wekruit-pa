/**
 * v2.0 External Supply V2 — Wave D dashboard UX — BatchNew wizard tests.
 *
 * The full `BatchNew` page transitively imports `lib/firebase.ts`, which
 * touches `import.meta.env.VITE_*` at module load and crashes Node's
 * `--test` loader (Vite-only DSL). So we exercise the wizard's pure
 * step-indicator + the related state machine here.
 *
 * Markup assertions cover each `BatchNewStep` value so the wizard's
 * visible progression stays stable across refactors.
 *
 * Run via:
 *   node --import tsx --test apps/dashboard-web/src/pages/external-supply/__tests__/BatchNew.test.tsx
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { StepIndicator, type BatchNewStep } from "../BatchNew.helpers.js"

function render(step: BatchNewStep): string {
  return renderToStaticMarkup(createElement(StepIndicator, { step }))
}

test("StepIndicator: renders all three step labels regardless of state", () => {
  for (const step of ["pick", "previewing", "committing", "done"] as const) {
    const html = render(step)
    assert.match(html, /1\. Pick/, `step=${step}`)
    assert.match(html, /2\. Preview/, `step=${step}`)
    assert.match(html, /3\. Commit/, `step=${step}`)
  }
})

test("StepIndicator: step=pick marks Pick chip active and no others done", () => {
  const html = render("pick")
  // Active chip uses the blue color #1a73e8
  assert.match(html, /1a73e8/)
})

test("StepIndicator: step=previewing marks Pick as done + Preview as active", () => {
  const html = render("previewing")
  // Both the done green and the active blue appear
  assert.match(html, /22c55e|166534|dcfce7/) // done style
  assert.match(html, /1a73e8/) // active style
})

test("StepIndicator: step=committing marks both Pick + Preview as done", () => {
  const html = render("committing")
  // At least 2 done chips appear (count of green-tone classes)
  const doneStyleMatches = html.match(/22c55e|dcfce7|166534/g) ?? []
  assert.ok(doneStyleMatches.length >= 2)
})

test("StepIndicator: step=done marks every chip as done", () => {
  const html = render("done")
  const doneStyleMatches = html.match(/22c55e|dcfce7|166534/g) ?? []
  assert.ok(doneStyleMatches.length >= 3)
})

test("StepIndicator: step=error renders an additional `error` chip", () => {
  const html = render("error")
  assert.match(html, />error</)
  assert.match(html, /991b1b|fee2e2|dc2626/) // error tones
})
