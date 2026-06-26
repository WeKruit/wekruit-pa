// @ts-nocheck - this source-contract test runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "EmployerOnboarding.tsx"), "utf8")
const stateSource = readFileSync(
  resolve(here, "../../lib/employer-onboarding-state.ts"),
  "utf8",
)

test("EmployerOnboarding reuses the ported wizard state machine, not the admin one", () => {
  assert.match(source, /from "\.\.\/\.\.\/lib\/employer-onboarding-state\.js"/)
  assert.doesNotMatch(source, /onboarding-wizard-state/)
  assert.doesNotMatch(source, /components\/ui\.js/) // no admin ui kit
})

test("ported state keeps the 7 milestones + success-metric vocab + helpers", () => {
  for (const key of [
    "welcome",
    "connect_slack",
    "connect_ats",
    "import_pool",
    "invite_team",
    "calibrate_req",
    "launch",
  ]) {
    assert.match(stateSource, new RegExp(`key: "${key}"`))
  }
  assert.match(stateSource, /DEFAULT_SUCCESS_METRIC: SuccessMetric = "time_to_first_interview"/)
  assert.match(stateSource, /export function stepStatus\(/)
  assert.match(stateSource, /export function resolvedCount\(/)
  // customer-site storage key — must NOT collide with the admin wizard key.
  assert.match(stateSource, /WIZARD_STORAGE_KEY = "wekruit-employer-onboarding-v1"/)
  assert.doesNotMatch(stateSource, /wekruit-onboarding-wizard-v1/)
})

test("EmployerOnboarding uses the customer-facing wk- design, not the admin console", () => {
  assert.match(source, /import "\.\.\/\.\.\/styles\/wekruit-tokens\.css"/)
  assert.match(source, /background: "var\(--cream\)"/)
  assert.match(source, /var\(--halo-hero/)
  assert.match(source, /fontFamily: "var\(--font-serif\)"/)
  assert.match(source, /className="btn btn--primary"/)
  // No admin/material chrome.
  assert.doesNotMatch(source, /#111827/)
  assert.doesNotMatch(source, /#2563eb/)
})

test("EmployerOnboarding hero frames the easy-button promise", () => {
  assert.match(source, /Your AI recruiter is ready/)
  assert.match(source, /point it at a real role/)
})

test("Step 0 Welcome has the You-do / WeKruit-does legend + success-metric picker + Continue", () => {
  assert.match(source, /You do/)
  assert.match(source, /WeKruit does/)
  assert.match(source, /function SuccessMetricPicker\(/)
  assert.match(source, /What does success look like for your pilot\?/)
  assert.match(source, /onClick=\{onContinue\}/)
})

test("Steps 1-6 render branded coming-soon panels with Skip-for-now + Back", () => {
  assert.match(source, /function ComingSoonStep\(/)
  assert.match(source, /Skip for now/)
  assert.match(source, /← Back/)
})

test("EmployerOnboarding shows N/7 progress and a numbered vertical stepper", () => {
  assert.match(source, /steps resolved/)
  assert.match(source, /function VerticalStepper\(/)
  assert.match(source, /aria-label="Onboarding steps"/)
})

test("EmployerOnboarding keeps employer navigation on the employer surface", () => {
  assert.match(source, /to="\/employers"[\s\S]*← Employer overview/)
})
