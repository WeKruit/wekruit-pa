// @ts-nocheck - this source-contract test runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "EmployerSignup.tsx"), "utf8")

test("EmployerSignup is framed as passed-profile role intake, not a layoff list signup", () => {
  assert.doesNotMatch(source, /warm intros/i)
  assert.doesNotMatch(source, /recently-laid-off operators/i)
  assert.doesNotMatch(source, /No marketplace logins, no portals/i)
  assert.doesNotMatch(source, /hand-pick from a small verified list/i)
  assert.doesNotMatch(source, /Send signup/)
  assert.doesNotMatch(source, /A quiet list for people between things/i)
  assert.doesNotMatch(source, /WeKruit Open/)

  assert.match(source, /passed-profile role intake/i)
  assert.match(source, /Send role brief/)
  assert.match(source, /Primary role brief/)
  assert.match(source, /Must-haves/)
  assert.match(source, /Claire screens/)
  assert.match(source, /passed profiles/)
})

test("EmployerSignup role-intake examples do not borrow real company product names", () => {
  assert.doesNotMatch(source, /Claude APIs/)
  assert.match(source, /developer platform/)
  assert.match(source, /must-haves Claire should probe/)
})

test("EmployerSignup captures hard filters as a first-class screening constraint", () => {
  assert.match(source, /Hard filters \*/)
  assert.match(source, /what must stop a pass/i)
  assert.match(source, /US work authorization/)
  assert.match(source, /hardFilters/)

  assert.doesNotMatch(source, /Hard filters \(optional\)/i)
  assert.doesNotMatch(source, /AI learns automatically/i)
})
