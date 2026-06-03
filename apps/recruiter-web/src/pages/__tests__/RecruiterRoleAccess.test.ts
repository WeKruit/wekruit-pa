// @ts-nocheck - source-contract test runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "../RecruiterRole.tsx"), "utf8")

test("RecruiterRole treats denied or rescinded role access as blocked, not single-submit", () => {
  assert.match(source, /function roleApplicationBlocksSubmission\(application: RecruiterRoleApplicationItem \| null\): boolean/)
  assert.match(source, /application\?\.status === "not_approved" \|\| application\?\.status === "rescinded"/)
  assert.match(source, /roleApplicationBlocksSubmission\(application\)/)
  assert.match(source, /Access blocked/)
  assert.match(source, /Role access was not approved\. Reapply with stronger candidate proof before submitting this role\./)
  assert.match(source, /Role access was rescinded\. Reapply after the role lane is fixed before submitting this role\./)
  assert.doesNotMatch(source, /application\?\.status !== "pending"[\s\S]{0,120}Single-submit lane/)
  assert.doesNotMatch(source, /application\?\.status !== "pending"[\s\S]{0,160}submit one exceptional candidate/)
})
